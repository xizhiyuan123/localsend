import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PING_TIMEOUT_MS = 1400;
const DNS_TIMEOUT_MS = 800;
const ARP_WAIT_MS = 420;

/** Interfaces that usually do not represent the user's physical LAN. */
const VIRTUAL_IFACE = [
  /^docker/i,
  /^br-/i,
  /^veth/i,
  /^virbr/i,
  /^vmnet/i,
  /^vboxnet/i,
  /^tailscale/i,
  /^utun/i,
  /^tun/i,
  /^tap/i,
  /^zt/i,
  /^wg/i,
  /^cni/i,
  /^flannel/i,
  /^ham/i,
];

let pingMissing = false;

export function localAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      const family = typeof address.family === 'string' ? address.family : `IPv${address.family}`;
      if (family !== 'IPv4' || address.internal) continue;
      if (!isIPv4(address.address)) continue;
      out.push(address.address);
    }
  }
  return [...new Set(out)];
}

/**
 * Derive scan targets. Every interface is reduced to the /24 that contains its
 * own address, so a /16 docker bridge never turns into a 65k-host scan.
 */
export function getSubnets() {
  const all = [];
  const seen = new Set();
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      const family = typeof address.family === 'string' ? address.family : `IPv${address.family}`;
      if (family !== 'IPv4' || address.internal) continue;
      if (!isIPv4(address.address)) continue;
      if (address.address.startsWith('169.254.')) continue;
      const base = address.address.split('.').slice(0, 3).join('.');
      if (seen.has(base)) continue;
      seen.add(base);
      all.push({
        name,
        address: address.address,
        netmask: address.netmask || '255.255.255.0',
        mac: address.mac || '',
        base,
        prefix: 24,
        virtual: VIRTUAL_IFACE.some((re) => re.test(name)),
      });
    }
  }
  const physical = all.filter((s) => !s.virtual);
  return physical.length ? physical : all;
}

export function isIPv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function baseOf(ip) {
  return ip.split('.').slice(0, 3).join('.');
}

function targetsForSubnet(subnet) {
  const targets = [];
  for (let i = 1; i <= 254; i += 1) {
    const ip = `${subnet.base}.${i}`;
    if (ip !== subnet.address) targets.push(ip);
  }
  return targets;
}

/**
 * Read the OS neighbour table. Works on Linux, macOS and Windows; failures
 * degrade to an empty list instead of breaking discovery.
 */
export async function readNeighbors() {
  const platform = process.platform;
  const commands = platform === 'win32'
    ? [['arp', ['-a']]]
    : platform === 'darwin'
      ? [['arp', ['-an']], ['ip', ['neigh', 'show']]]
      : [['ip', ['-4', 'neigh', 'show']], ['arp', ['-an']]];

  for (const [command, args] of commands) {
    let stdout;
    try {
      const result = await execFileAsync(command, args, {
        timeout: 3000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      if (error.stdout) stdout = error.stdout;
      else continue;
    }
    const parsed = parseNeighbors(stdout, platform);
    if (parsed.size) return parsed;
  }
  return new Map();
}

export function parseNeighbors(text, platform = process.platform) {
  const hosts = new Map();
  const lines = String(text || '').split(/\r?\n/);

  if (platform === 'win32') {
    for (const line of lines) {
      const match = line.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(\S+)/i);
      if (!match) continue;
      const [, ip, rawMac, state] = match;
      if (!isIPv4(ip)) continue;
      hosts.set(ip, { ip, mac: rawMac.replaceAll('-', ':').toLowerCase(), state: state.toLowerCase() });
    }
    return hosts;
  }

  if (platform === 'darwin') {
    for (const line of lines) {
      const match = line.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-f:]{2,17}|\(incomplete\))/i);
      if (!match) continue;
      const [, ip, rawMac] = match;
      if (!isIPv4(ip)) continue;
      if (/incomplete/i.test(rawMac)) continue;
      hosts.set(ip, { ip, mac: rawMac.toLowerCase(), state: 'reachable' });
    }
    return hosts;
  }

  for (const line of lines) {
    // Linux iproute2:
    //   192.168.83.2 dev ens33 lladdr 00:50:56:e5:39:cf REACHABLE
    // BusyBox (Alpine):
    //   192.168.83.2 dev ens33 lladdr 00:50:56:e5:39:cf ref 1 used 0/0/0 REACHABLE
    const ipMatch = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+(\S+)/);
    if (!ipMatch) continue;
    const [, ip] = ipMatch;
    if (!isIPv4(ip)) continue;
    const macMatch = line.match(/lladdr\s+([0-9a-f:]{17})/i);
    const stateMatch = line.match(/\b(REACHABLE|STALE|DELAY|PROBE|FAILED|INCOMPLETE|NOARP|PERMANENT)\b/i);
    const state = stateMatch ? stateMatch[1].toUpperCase() : '';
    if (state === 'FAILED' || state === 'INCOMPLETE') continue;
    hosts.set(ip, {
      ip,
      mac: macMatch ? macMatch[1].toLowerCase() : '',
      state: state.toLowerCase(),
    });
  }
  return hosts;
}

async function triggerArp(ips) {
  if (!ips.length) return;
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => {
    let pending = ips.length;
    const done = () => {
      pending -= 1;
      if (pending <= 0) resolve();
    };
    socket.on('error', () => done());
    for (const ip of ips) {
      try {
        socket.send(Buffer.from([0]), 9, ip, (error) => {
          if (error) {
            // Unreachable hosts are expected; the ARP request has still been
            // emitted by the kernel before the ICMP error comes back.
          }
          done();
        });
      } catch {
        done();
      }
    }
    // Guard against a socket that never reports callbacks.
    setTimeout(resolve, 600);
  });
  try {
    socket.close();
  } catch {
    // already closed
  }
  await sleep(ARP_WAIT_MS);
}

async function pingHost(ip) {
  if (pingMissing) return false;
  let args;
  if (process.platform === 'win32') {
    args = ['-n', '1', '-w', '800', ip];
  } else if (process.platform === 'darwin') {
    args = ['-c', '1', '-W', '1000', ip];
  } else {
    args = ['-c', '1', '-W', '1', ip];
  }
  try {
    await execFileAsync('ping', args, {
      timeout: PING_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') pingMissing = true;
    return false;
  }
}

async function reverseName(ip) {
  try {
    const result = await Promise.race([
      dns.reverse(ip),
      sleep(DNS_TIMEOUT_MS).then(() => null),
    ]);
    if (!result || !result.length) return '';
    return String(result[0]).replace(/\.$/, '').slice(0, 120);
  } catch {
    return '';
  }
}

async function mapLimit(items, limit, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Discover machines on the server's LAN.
 *
 * quick: neighbour table only (fast, ~1ms)
 * full: ARP trigger + concurrent ICMP + neighbour re-read (a few seconds)
 */
export async function scan({ full = false } = {}) {
  const subnets = getSubnets();
  const local = localAddresses();
  const targets = [];
  const targetSet = new Set();
  for (const subnet of subnets) {
    for (const ip of targetsForSubnet(subnet)) {
      if (targetSet.has(ip)) continue;
      targetSet.add(ip);
      targets.push(ip);
    }
  }

  /** @type {Map<string, {ip:string, mac:string, hostname:string, reverse:string, state:string, online:boolean, sources:Set<string>}>} */
  const hosts = new Map();

  const mergeNeighbors = (neighbors, source) => {
    for (const [ip, info] of neighbors) {
      if (!isIPv4(ip)) continue;
      // Ignore multicast/broadcast rows from the ARP table.
      const last = Number(ip.split('.').pop());
      if (last === 0 || last === 255) continue;
      const existing = hosts.get(ip);
      if (existing) {
        if (!existing.mac && info.mac) existing.mac = info.mac;
        existing.state = info.state || existing.state;
        existing.online = existing.online || !['stale', 'failed', 'incomplete'].includes(existing.state);
        existing.sources.add(source);
      } else {
        hosts.set(ip, {
          ip,
          mac: info.mac || '',
          hostname: '',
          reverse: '',
          state: info.state || '',
          online: !['stale', 'failed', 'incomplete'].includes(info.state),
          sources: new Set([source]),
        });
      }
    }
  };

  mergeNeighbors(await readNeighbors(), 'arp');

  let pinged = 0;
  if (full) {
    await triggerArp(targets);
    mergeNeighbors(await readNeighbors(), 'arp');
    const alive = await mapLimit(targets, 64, async (ip) => {
      const ok = await pingHost(ip);
      if (ok) pinged += 1;
      return ok ? ip : null;
    });
    for (const ip of alive) {
      if (!ip) continue;
      const existing = hosts.get(ip);
      if (existing) {
        existing.online = true;
        existing.sources.add('ping');
      } else {
        hosts.set(ip, {
          ip,
          mac: '',
          hostname: '',
          reverse: '',
          state: 'reachable',
          online: true,
          sources: new Set(['ping']),
        });
      }
    }
    // Ping populates the neighbour table with MACs.
    mergeNeighbors(await readNeighbors(), 'arp');
  }

  // Never advertise the loopback address.
  hosts.delete('127.0.0.1');

  // Only keep members of the scanned physical /24s. The neighbour table can
  // also contain docker0/veth/other bridges; those are not the user's LAN and
  // would make the device list noisy.
  const bases = new Set(subnets.map((subnet) => `${subnet.base}.`));
  const hostList = [...hosts.values()].filter((host) => {
    if (!bases.size) return true;
    for (const base of bases) {
      if (host.ip.startsWith(base)) return true;
    }
    return false;
  });
  const names = await mapLimit(hostList, 12, (host) => reverseName(host.ip));
  hostList.forEach((host, index) => {
    host.reverse = names[index] || '';
    host.hostname = host.reverse;
  });

  hostList.sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));

  return {
    hostname: os.hostname(),
    localAddresses: local,
    subnets: subnets.map((subnet) => ({
      name: subnet.name,
      address: subnet.address,
      netmask: subnet.netmask,
      prefix: subnet.prefix,
      virtual: subnet.virtual,
    })),
    hosts: hostList.map((host) => ({
      ip: host.ip,
      mac: host.mac,
      hostname: host.hostname,
      state: host.state,
      online: host.online,
      sources: [...host.sources],
    })),
    scannedAt: Date.now(),
    full,
    pinged,
  };
}

export function ipToNumber(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return Number.MAX_SAFE_INTEGER;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}