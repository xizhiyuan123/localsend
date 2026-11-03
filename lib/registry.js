import { randomUUID } from 'node:crypto';

/**
 * Online browser registry. Purely in-memory: a client disappears when its
 * WebSocket closes, and re-registers on reload.
 */
export class Registry {
  constructor() {
    /** @type {Map<string, {id:string, ip:string, ua:string, alias:string, deviceType:string, joinedAt:number, lastSeen:number}>} */
    this.clients = new Map();
  }

  create({ ip, ua }) {
    const client = {
      id: randomUUID(),
      ip,
      ua: ua || '',
      alias: '未命名设备',
      deviceType: 'web',
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.clients.set(client.id, client);
    return client;
  }

  get(id) {
    return this.clients.get(id) || null;
  }

  update(id, patch) {
    const client = this.clients.get(id);
    if (!client) return null;
    Object.assign(client, patch, { lastSeen: Date.now() });
    return client;
  }

  touch(id) {
    const client = this.clients.get(id);
    if (client) client.lastSeen = Date.now();
  }

  remove(id) {
    const client = this.clients.get(id) || null;
    this.clients.delete(id);
    return client;
  }

  list() {
    return [...this.clients.values()].map(publicClient);
  }

  byIp(ip) {
    return [...this.clients.values()].filter((c) => c.ip === ip).map(publicClient);
  }
}

export function publicClient(client) {
  return {
    id: client.id,
    ip: client.ip,
    alias: client.alias,
    deviceType: client.deviceType,
    ua: client.ua,
    joinedAt: client.joinedAt,
  };
}

export function normalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

export function cleanAlias(value, fallback = '未命名设备') {
  const alias = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40);
  return alias || fallback;
}