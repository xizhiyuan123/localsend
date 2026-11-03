import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { getSubnets, scan, ipToNumber } from './lib/discovery.js';
import { Registry, cleanAlias, normalizeIp } from './lib/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const registry = new Registry();

/** @type {Map<string, {id:string, ws:import('ws').WebSocket, registered:boolean, alive:boolean, ip:string}>} */
const sessions = new Map();

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

let lanCache = null;
let lanCacheAt = 0;
let fullScanPromise = null;
let quickScanPromise = null;

function now() {
  return Date.now();
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  setCommonHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

async function handleHttp(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/info') {
      return sendJson(res, 200, {
        name: '本地互传',
        version: VERSION,
        hostname: os.hostname(),
        addresses: getSubnets().map((subnet) => subnet.address),
        subnets: getSubnets().map((s) => ({ name: s.name, address: s.address, prefix: s.prefix })),
        port: PORT,
        protocol: 'http',
        uptime: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      });
    }

    if (pathname === '/api/lan') {
      const wantsFull = url.searchParams.get('full') === '1';
      let data;
      if (wantsFull) {
        data = await runFullScan();
      } else {
        data = await getLanSnapshot();
      }
      return sendJson(res, 200, decorateLan(data));
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        clients: sessions.size,
        registered: registry.clients.size,
        uptime: Math.round(process.uptime()),
      });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not_found' });
    }

    return serveStatic(req, res, pathname);
  } catch (error) {
    console.error('[http]', error);
    return sendJson(res, 500, { error: 'internal_error', message: String(error?.message || error) });
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    setCommonHeaders(res);
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('method not allowed');
    return;
  }

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    setCommonHeaders(res);
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  if (relative === '/' || relative === '') relative = '/index.html';
  if (relative.includes('\0')) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    setCommonHeaders(res);
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      setCommonHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const type = MIME[extension] || 'application/octet-stream';
    const cache = extension === '.html' || filePath.endsWith('index.html') || extension === '.js' || extension === '.css'
      ? 'no-store'
      : 'public, max-age=3600';

    setCommonHeaders(res);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cache,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  });
}

/* -------------------------------------------------------------------------- */
/* LAN discovery                                                              */
/* -------------------------------------------------------------------------- */

async function runFullScan() {
  if (fullScanPromise) return fullScanPromise;
  fullScanPromise = scan({ full: true })
    .then((data) => {
      lanCache = data;
      lanCacheAt = now();
      console.log(`[lan] full scan: ${data.hosts.length} host(s), ${data.pinged} ping reply/ies`);
      return data;
    })
    .catch((error) => {
      console.error('[lan] full scan failed:', error);
      if (lanCache) return lanCache;
      throw error;
    })
    .finally(() => {
      fullScanPromise = null;
    });
  return fullScanPromise;
}

async function runQuickScan() {
  if (quickScanPromise) return quickScanPromise;
  quickScanPromise = scan({ full: false })
    .then((data) => {
      lanCache = data;
      lanCacheAt = now();
      return data;
    })
    .catch((error) => {
      console.error('[lan] quick scan failed:', error);
      if (lanCache) return lanCache;
      throw error;
    })
    .finally(() => {
      quickScanPromise = null;
    });
  return quickScanPromise;
}

async function getLanSnapshot() {
  if (lanCache && now() - lanCacheAt < 15_000) return lanCache;
  // A full scan may be warming in the background. The quick neighbour
  // snapshot returns immediately, so the first page load is not blocked for
  // several seconds; the client polls again while `fullScanRunning` is true.
  return runQuickScan();
}

function decorateLan(data) {
  const clients = registry.list();
  const byIp = new Map();
  for (const client of clients) {
    const list = byIp.get(client.ip) || [];
    list.push(client);
    byIp.set(client.ip, list);
  }

  const local = new Set((data.subnets || []).map((subnet) => subnet.address));
  const hostMap = new Map();
  for (const host of data.hosts || []) {
    hostMap.set(host.ip, {
      ...host,
      clients: [],
      registered: false,
      isServer: local.has(host.ip),
    });
  }

  for (const ip of local) {
    if (!hostMap.has(ip)) {
      hostMap.set(ip, {
        ip,
        mac: '',
        hostname: data.hostname || os.hostname(),
        state: 'local',
        online: true,
        sources: ['server'],
        clients: [],
        registered: false,
        isServer: true,
      });
    }
  }

  for (const [ip, list] of byIp) {
    let host = hostMap.get(ip);
    if (!host) {
      host = {
        ip,
        mac: '',
        hostname: '',
        state: 'client',
        online: true,
        sources: ['client'],
        clients: [],
        registered: false,
        isServer: local.has(ip),
      };
      hostMap.set(ip, host);
    }
    host.clients = list;
    host.registered = true;
    host.online = true;
  }

  const hosts = [...hostMap.values()].sort((a, b) => {
    if (a.registered !== b.registered) return a.registered ? -1 : 1;
    return ipToNumber(a.ip) - ipToNumber(b.ip);
  });

  return {
    ...data,
    hostname: data.hostname || os.hostname(),
    hosts,
    registeredCount: clients.length,
    cachedAt: lanCacheAt,
    fullScanRunning: Boolean(fullScanPromise),
  };
}

/* -------------------------------------------------------------------------- */
/* WebSocket                                                                  */
/* -------------------------------------------------------------------------- */

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const ip = normalizeIp(req.socket.remoteAddress);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const session = {
    id: '',
    ws,
    registered: false,
    alive: true,
    ip,
    joinedAt: now(),
  };
  let cleaned = false;

  const helloTimeout = setTimeout(() => {
    if (!session.registered) ws.close(4000, 'hello timeout');
  }, 5000);

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(helloTimeout);
    if (session.id) {
      sessions.delete(session.id);
      const wasRegistered = session.registered;
      registry.remove(session.id);
      session.registered = false;
      if (wasRegistered) broadcastPresence();
    }
  };

  ws.on('pong', () => {
    session.alive = true;
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (!session.registered) {
      if (message.type !== 'hello') return;
      clearTimeout(helloTimeout);
      const alias = cleanAlias(message.alias, '浏览器');
      const deviceType = ['desktop', 'mobile', 'web', 'server', 'headless'].includes(message.deviceType)
        ? message.deviceType
        : 'web';
      const client = registry.create({ ip, ua });
      registry.update(client.id, { alias, deviceType });
      session.id = client.id;
      session.registered = true;
      session.joinedAt = client.joinedAt;
      sessions.set(client.id, session);
      send(ws, {
        type: 'welcome',
        selfId: client.id,
        clients: registry.list(),
        server: {
          hostname: os.hostname(),
          port: PORT,
          addresses: getSubnets().map((subnet) => subnet.address),
        },
      });
      broadcastPresence();
      return;
    }

    registry.touch(session.id);

    switch (message.type) {
      case 'alias': {
        const alias = cleanAlias(message.alias, '浏览器');
        registry.update(session.id, { alias });
        broadcastPresence();
        break;
      }
      case 'hello': {
        const alias = cleanAlias(message.alias, '浏览器');
        registry.update(session.id, { alias });
        broadcastPresence();
        break;
      }
      case 'signal': {
        const targetId = typeof message.to === 'string' ? message.to : '';
        if (!targetId || targetId === session.id) return;
        const target = sessions.get(targetId);
        if (!target || !target.registered) {
          send(ws, { type: 'error', code: 'peer-gone', message: '目标客户端已离线' });
          return;
        }
        if (!message.data || typeof message.data !== 'object') return;
        send(target.ws, {
          type: 'signal',
          from: session.id,
          data: message.data,
        });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

function send(ws, message) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // ignore broken sockets
    }
  }
}

function broadcastPresence() {
  const clients = registry.list();
  const payload = { type: 'presence', clients };
  for (const session of sessions.values()) {
    if (session.registered) send(session.ws, payload);
  }
}

const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    if (!session.alive) {
      try {
        session.ws.terminate();
      } catch {
        // ignore
      }
      continue;
    }
    session.alive = false;
    try {
      session.ws.ping();
    } catch {
      // ignore
    }
  }
}, 20_000);

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换一个端口：PORT=3001 npm start\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │  本地互传 · Local File Express               │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('');
  console.log(`  本机访问   http://localhost:${PORT}`);
  for (const address of getSubnets().map((subnet) => subnet.address)) {
    console.log(`  局域网     http://${address}:${PORT}`);
  }
  console.log('');
  console.log('  文件只在浏览器之间通过 WebRTC 直传，服务器不经手文件内容。');
  console.log('');

  // Warm the neighbour table so the first page load has something to show.
  setTimeout(() => {
    runFullScan().catch(() => {});
  }, 400);
});

function shutdown(signal) {
  console.log(`\n[server] ${signal}, shutting down...`);
  clearInterval(heartbeat);
  for (const session of sessions.values()) {
    try {
      session.ws.close(1001, 'server shutdown');
    } catch {
      // ignore
    }
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));