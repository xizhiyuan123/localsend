/* 本地互传 — browser side.
 *
 * The server only handles registration, WebRTC signalling and LAN discovery.
 * File bytes travel exclusively over the peer-to-peer DataChannel.
 */

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const PREFETCH_CHUNKS = 8;
const TARGET_CHUNK = 64 * 1024;
const MIN_CHUNK = 16 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const OFFER_TIMEOUT_MS = 60_000;
const ACK_TIMEOUT_MS = 300_000;
const IDLE_CONN_MS = 60_000;
const LS_ALIAS = 'localsend.alias';
const LS_CUSTOM = 'localsend.customDevices';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const state = {
  myId: null,
  alias: loadAlias(),
  clients: [],
  serverAddresses: [],
  lan: null,
  lanLoading: false,
  lanPollTimer: null,
  custom: loadCustom(),
  ws: null,
  wsState: 'connecting',
  reconnectTimer: null,
  reconnectDelay: 1000,
  conns: new Map(),
  transfers: new Map(),
  pendingIncoming: null,
  pickResolve: null,
  confirmResolve: null,
  editCustomId: null,
  fileTarget: null,
  testingIps: new Set(),
  dockCollapsed: false,
  debug: new URLSearchParams(location.search).has('debug'),
  logs: [],
};

window.__localsend = state;

function debugLog(...parts) {
  if (!state.debug) return;
  state.logs.push(parts.map((part) => String(part)).join(' '));
  if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
}

const dom = {
  clientList: $('#client-list'),
  clientsEmpty: $('#clients-empty'),
  lanList: $('#lan-list'),
  lanEmpty: $('#lan-empty'),
  lanSub: $('#lan-sub'),
  scanBar: $('#scan-bar'),
  scanText: $('#scan-text'),
  customList: $('#custom-list'),
  customEmpty: $('#custom-empty'),
  customCount: $('#custom-count'),
  customForm: $('#custom-form'),
  customIp: $('#custom-ip'),
  customLabel: $('#custom-label'),
  testAddBtn: $('#btn-test-add'),
  statClients: $('#stat-clients'),
  statHosts: $('#stat-hosts'),
  statAddress: $('#stat-address'),
  meAlias: $('#me-alias'),
  meIp: $('#me-ip'),
  conn: $('#conn'),
  connDot: $('#conn-dot'),
  connText: $('#conn-text'),
  fileInput: $('#file-input'),
  transferDock: $('#transfer-dock'),
  transferList: $('#transfer-list'),
  dockCount: $('#dock-count'),
  incomingModal: $('#modal-incoming'),
  incomingFrom: $('#incoming-from'),
  incomingMeta: $('#incoming-meta'),
  incomingFiles: $('#incoming-files'),
  incomingTotal: $('#incoming-total'),
  pickModal: $('#modal-pick'),
  pickList: $('#pick-list'),
  pickTitle: $('#pick-title'),
  aliasModal: $('#modal-alias'),
  aliasInput: $('#alias-input'),
  customEditModal: $('#modal-custom-edit'),
  editLabel: $('#edit-label'),
  editIp: $('#edit-ip'),
  confirmModal: $('#modal-confirm'),
  confirmTitle: $('#confirm-title'),
  confirmText: $('#confirm-text'),
  toasts: $('#toasts'),
  debugPanel: $('#debug-panel'),
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function svgIcon(symbol, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.appendChild(use);
  return svg;
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let index = -1;
  let n = value;
  do {
    n /= 1024;
    index += 1;
  } while (n >= 1024 && index < units.length - 1);
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${units[index]}`;
}

function fmtSpeed(bytesPerSecond) {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond)) return '—';
  return `${fmtBytes(bytesPerSecond)}/s`;
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function fmtTime(timestamp) {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function isIPv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function safeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .trim()
    .slice(0, 180) || '未命名文件';
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function detectDeviceType() {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function osLabel(ua = navigator.userAgent) {
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return '未知系统';
}

function browserLabel(ua = navigator.userAgent) {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return '浏览器';
}

function deviceIcon(client) {
  const ua = client?.ua || '';
  if (client?.deviceType === 'mobile' || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)) {
    return { symbol: 'i-mobile', tone: '' };
  }
  if (client?.deviceType === 'server' || client?.deviceType === 'headless') {
    return { symbol: 'i-server', tone: 'blue' };
  }
  if (/Windows|Macintosh|Mac OS X|Linux|CrOS/i.test(ua)) {
    return { symbol: 'i-desktop', tone: '' };
  }
  return { symbol: 'i-browser', tone: 'blue' };
}

function deviceLabel(client) {
  return `${browserLabel(client?.ua || '')} · ${osLabel(client?.ua || '')}`;
}

function defaultAlias() {
  return `${browserLabel()} · ${osLabel()}`;
}

function loadAlias() {
  try {
    return localStorage.getItem(LS_ALIAS) || defaultAlias();
  } catch {
    return defaultAlias();
  }
}

function saveAlias(alias) {
  try {
    localStorage.setItem(LS_ALIAS, alias);
  } catch {
    // private mode
  }
}

function loadCustom() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_CUSTOM) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry) => entry && isIPv4(entry.ip))
      .map((entry) => ({
        id: String(entry.id || uid()),
        ip: String(entry.ip),
        label: String(entry.label || entry.ip).slice(0, 40),
        addedAt: Number(entry.addedAt) || Date.now(),
        lastOkAt: Number(entry.lastOkAt) || null,
        lastRttMs: Number.isFinite(Number(entry.lastRttMs)) ? Number(entry.lastRttMs) : null,
      }));
  } catch {
    return [];
  }
}

function saveCustom() {
  try {
    localStorage.setItem(LS_CUSTOM, JSON.stringify(state.custom));
  } catch {
    showToast('无法写入 localStorage，自定义设备不会被保存', 'error');
  }
}

function selfClient() {
  return state.clients.find((client) => client.id === state.myId) || null;
}

function findClient(id) {
  return state.clients.find((client) => client.id === id) || null;
}

function clientsByIp(ip) {
  return state.clients.filter((client) => client.ip === ip);
}

function sendWS(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function setConnState(status) {
  state.wsState = status;
  dom.conn.classList.remove('is-online', 'is-offline', 'is-connecting');
  if (status === 'online') {
    dom.conn.classList.add('is-online');
    dom.connText.textContent = '已连接';
  } else if (status === 'offline') {
    dom.conn.classList.add('is-offline');
    dom.connText.textContent = '已断开';
  } else {
    dom.conn.classList.add('is-connecting');
    dom.connText.textContent = '连接中';
  }
}

function showToast(message, type = 'info', timeout = 4200) {
  const toast = document.createElement('div');
  toast.className = `toast is-${type}`;
  toast.appendChild(svgIcon(type === 'error' ? 'i-alert' : type === 'warn' ? 'i-alert' : 'i-check'));
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  dom.toasts.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 240);
  }, timeout);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback (HTTP pages have no clipboard API)
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function showModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = false;
}

function hideModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = true;
}

function closeTopModal() {
  if (!dom.incomingModal.hidden) {
    rejectIncoming('closed');
    return;
  }
  if (!dom.pickModal.hidden) {
    cancelPick();
    return;
  }
  if (!dom.confirmModal.hidden) {
    resolveConfirm(false);
    return;
  }
  for (const id of ['modal-alias', 'modal-custom-edit']) {
    const modal = document.getElementById(id);
    if (modal && !modal.hidden) modal.hidden = true;
  }
}

function confirmDialog(title, text, okLabel = '删除') {
  dom.confirmTitle.textContent = title;
  dom.confirmText.textContent = text;
  $('#btn-confirm-ok').textContent = okLabel;
  showModal('modal-confirm');
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
  });
}

function resolveConfirm(value) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  hideModal('modal-confirm');
  resolve?.(value);
}

/* -------------------------------------------------------------------------- */
/* WebSocket                                                                  */
/* -------------------------------------------------------------------------- */

function connectWS() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnState('connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
  } catch (error) {
    setConnState('offline');
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    setConnState('online');
    sendWS({ type: 'hello', alias: state.alias, deviceType: detectDeviceType() });
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  ws.addEventListener('close', () => {
    if (state.ws !== ws) return;
    setConnState('offline');
    state.myId = null;
    state.clients = [];
    closeAllConns('信令连接已断开');
    renderMe();
    renderClients();
    renderLan();
    renderCustom();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // close will follow
  });
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(Math.round(state.reconnectDelay * 1.7), 8000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectWS();
  }, delay);
}

function handleServerMessage(message) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'welcome': {
      state.myId = message.selfId;
      state.clients = Array.isArray(message.clients) ? message.clients : [];
      if (Array.isArray(message.server?.addresses)) {
        state.serverAddresses = message.server.addresses.filter(Boolean);
      }
      renderMe();
      renderClients();
      renderLan();
      renderCustom();
      break;
    }
    case 'presence': {
      state.clients = Array.isArray(message.clients) ? message.clients : [];
      cleanupOfflineConns();
      renderMe();
      renderClients();
      renderLan();
      renderCustom();
      break;
    }
    case 'signal': {
      handleSignal(message.from, message.data);
      break;
    }
    case 'error': {
      showToast(message.message || '服务器返回错误', 'error');
      break;
    }
    default:
      break;
  }
}

function handleSignal(from, data) {
  if (!state.myId || !data || typeof data !== 'object' || !data.connId) return;
  let conn = state.conns.get(data.connId);
  if (!conn) {
    if (data.description?.type === 'answer') return; // stale answer
    conn = new Conn({ peerId: from, connId: data.connId, initiator: false });
    state.conns.set(conn.connId, conn);
    conn.idleTimer = setTimeout(() => {
      if (!conn.transfer) conn.close('空闲连接超时');
    }, IDLE_CONN_MS);
  }
  conn.handleSignal(data);
}

function cleanupOfflineConns() {
  const ids = new Set(state.clients.map((client) => client.id));
  if (state.myId && !ids.has(state.myId)) {
    // The server no longer knows this session (likely restarted).
    state.myId = null;
    state.clients = [];
    closeAllConns('会话已失效');
    try {
      state.ws?.close();
    } catch {
      // ignore
    }
    return;
  }
  for (const conn of [...state.conns.values()]) {
    if (!ids.has(conn.peerId)) conn.close('对方已离线');
  }
}

/* -------------------------------------------------------------------------- */
/* WebRTC connection (one isolated connection per transfer / test)            */
/* -------------------------------------------------------------------------- */

class Conn {
  constructor({ peerId, connId, initiator }) {
    this.peerId = peerId;
    this.connId = connId;
    this.initiator = Boolean(initiator);
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.dc = null;
    this.handler = null;
    this.onPong = null;
    this.transfer = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    this.closed = false;
    this.opened = false;
    this.idleTimer = null;
    this.chunkSize = TARGET_CHUNK;
    this.queue = Promise.resolve();
    this.makingOffer = false;
    this._openResolve = null;
    this._openReject = null;
    this.openPromise = new Promise((resolve, reject) => {
      this._openResolve = resolve;
      this._openReject = reject;
    });
    // Incoming connections do not await this promise; keep a rejection from
    // surfacing as an unhandled rejection when ICE fails.
    this.openPromise.catch(() => {});
    this.openTimer = setTimeout(() => {
      this.fail(new Error('建立 WebRTC 连接超时'));
    }, CONNECT_TIMEOUT_MS);

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate && !this.closed) {
        sendSignal(this.peerId, this.connId, { candidate: event.candidate.toJSON() });
      }
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const pcState = this.pc.connectionState;
      if (pcState === 'failed') {
        this.fail(new Error('WebRTC 连接失败（可能是 AP 隔离、防火墙或 mDNS 不可用）'));
      } else if (pcState === 'closed') {
        this.close();
      }
    });

    this.pc.addEventListener('iceconnectionstatechange', () => {
      if (this.pc.iceConnectionState === 'failed') {
        this.fail(new Error('ICE 连接失败（局域网可能禁止了 P2P）'));
      }
    });

    this.pc.addEventListener('datachannel', (event) => {
      this.attachDataChannel(event.channel);
    });

    if (this.initiator) {
      this.pc.addEventListener('negotiationneeded', () => this.negotiate());
      this.attachDataChannel(this.pc.createDataChannel('localsend', { ordered: true }));
    }
  }

  async negotiate() {
    if (this.closed || this.makingOffer) return;
    if (this.pc.signalingState !== 'stable') return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        sendSignal(this.peerId, this.connId, { description: this.pc.localDescription.toJSON() });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.makingOffer = false;
    }
  }

  attachDataChannel(dc) {
    if (this.closed) {
      try { dc.close(); } catch { /* ignore */ }
      return;
    }
    if (this.dc && this.dc !== dc) {
      // With one initiator per connection this should not happen. Keep the
      // existing channel and close the duplicate.
      try { dc.close(); } catch { /* ignore */ }
      return;
    }
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;

    dc.addEventListener('open', () => {
      if (this.closed) return;
      debugLog('dc-open', this.connId.slice(0, 6), this.initiator ? 'out' : 'in');
      this.opened = true;
      clearTimeout(this.openTimer);
      this.chunkSize = chooseChunkSize(this.pc);
      this.clearIdle();
      if (!this.transfer && !this.handler) {
        this.idleTimer = setTimeout(() => {
          if (!this.transfer && !this.handler) this.close('空闲连接超时');
        }, IDLE_CONN_MS);
      }
      this._openResolve?.();
    });

    dc.addEventListener('message', (event) => {
      this.enqueue(event.data);
    });

    dc.addEventListener('close', () => {
      if (!this.closed) this.close('数据通道已关闭');
    });

    dc.addEventListener('error', () => {
      if (!this.closed) this.fail(new Error('数据通道错误'));
    });
  }

  enqueue(data) {
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        if (typeof data === 'string') {
          let message;
          try {
            message = JSON.parse(data);
          } catch {
            return;
          }
          if (!message || typeof message !== 'object') return;
          if (message.k === 'ping') {
            this.sendJson({ k: 'pong', t: message.t, seq: message.seq });
            return;
          }
          if (message.k === 'pong') {
            this.onPong?.(message);
            return;
          }
          debugLog('recv', message.k, this.connId.slice(0, 6));
          if (this.handler) {
            await this.handler(message);
          } else {
            await handleDefaultMessage(this, message);
          }
        } else if (this.handler) {
          if (!this._loggedChunk) {
            this._loggedChunk = true;
            debugLog('recv', 'binary', data.byteLength, this.connId.slice(0, 6));
          }
          await this.handler(data);
        }
      })
      .catch((error) => {
        console.error('[conn]', error);
        debugLog('conn-error', error?.message || String(error));
        if (this.transfer) failTransfer(this.transfer, error);
        else this.close(error.message || '连接错误');
      });
  }

  async handleSignal(data) {
    if (this.closed) return;
    try {
      if (data.description) {
        await this.pc.setRemoteDescription(data.description);
        this.remoteDescriptionSet = true;
        for (const candidate of this.pendingCandidates.splice(0)) {
          try {
            await this.pc.addIceCandidate(candidate);
          } catch {
            // ignore stale candidate
          }
        }
        if (data.description.type === 'offer') {
          await this.pc.setLocalDescription();
          sendSignal(this.peerId, this.connId, { description: this.pc.localDescription.toJSON() });
        }
      } else if (data.candidate) {
        if (this.remoteDescriptionSet) {
          try {
            await this.pc.addIceCandidate(data.candidate);
          } catch {
            // candidate can arrive after the connection is already established
          }
        } else {
          this.pendingCandidates.push(data.candidate);
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }

  sendJson(message) {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('数据通道尚未就绪');
    }
    this.dc.send(JSON.stringify(message));
  }

  async sendChunk(chunk) {
    if (this.closed || !this.dc || this.dc.readyState !== 'open') {
      throw new Error('连接已关闭');
    }
    await this.waitForBuffer();
    this.dc.send(chunk);
  }

  waitForBuffer() {
    if (!this.dc || this.dc.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.dc?.removeEventListener('bufferedamountlow', onLow);
        this.dc?.removeEventListener('close', onClose);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('连接已关闭'));
      };
      this.dc.addEventListener('bufferedamountlow', onLow);
      this.dc.addEventListener('close', onClose);
    });
  }

  clearIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  close(reason = '') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.openTimer);
    this.clearIdle();
    this._openReject?.(new Error(reason || '连接已关闭'));
    try {
      this.dc?.close();
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
    state.conns.delete(this.connId);
    handleConnClosed(this, reason);
  }

  fail(error) {
    const message = error?.message || String(error || '连接错误');
    if (this.transfer && !this.transfer.finalized) {
      failTransfer(this.transfer, error);
    }
    this.close(message);
  }
}

function chooseChunkSize(pc) {
  const max = Number(pc?.sctp?.maxMessageSize) || TARGET_CHUNK;
  if (!Number.isFinite(max) || max <= 0) return TARGET_CHUNK;
  return Math.max(MIN_CHUNK, Math.min(TARGET_CHUNK, max));
}

function sendSignal(peerId, connId, payload) {
  sendWS({
    type: 'signal',
    to: peerId,
    data: { connId, ...payload },
  });
}

function closeAllConns(reason) {
  for (const conn of [...state.conns.values()]) {
    conn.close(reason);
  }
}

function handleConnClosed(conn, reason) {
  if (state.pendingIncoming?.conn === conn) {
    clearTimeout(state.pendingIncoming.timer);
    state.pendingIncoming = null;
    hideModal('modal-incoming');
    document.title = '本地互传 · Local File Express';
  }
  if (conn.transfer && !conn.transfer.finalized) {
    const allDone = conn.transfer.files.length > 0
      && conn.transfer.files.every((file) => file.status === 'done');
    if (conn.transfer.direction === 'receive' && allDone) {
      completeTransfer(conn.transfer);
    } else {
      failTransfer(conn.transfer, new Error(reason || '连接已关闭'));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Transfer models                                                            */
/* -------------------------------------------------------------------------- */

function createTransfer({ transferId, direction, peer, files, conn }) {
  const normalized = files.map((file, index) => ({
    id: String(file.id || `f${index}-${uid().slice(0, 6)}`),
    name: safeName(file.name),
    size: Math.max(0, Number(file.size) || 0),
    type: String(file.type || 'application/octet-stream').slice(0, 120),
    status: 'pending',
    sent: 0,
    progress: 0,
    md5: null,
    md5Ok: null,
    blobUrl: null,
    error: null,
  }));
  const totalBytes = normalized.reduce((sum, file) => sum + file.size, 0);
  const transfer = {
    id: transferId || uid(),
    direction,
    peerId: peer?.id || conn?.peerId || '',
    peerAlias: peer?.alias || '对方',
    peerIp: peer?.ip || '',
    files: normalized,
    status: 'preparing',
    bytes: 0,
    totalBytes,
    speed: 0,
    error: null,
    startedAt: Date.now(),
    startedPerf: now(),
    finishedAt: null,
    lastSampleAt: now(),
    lastSampleBytes: 0,
    conn,
    waiters: new Map(),
    current: null,
    canceled: false,
    finalized: false,
  };
  state.transfers.set(transfer.id, transfer);
  if (conn) conn.transfer = transfer;
  dom.transferDock.hidden = false;
  scheduleDock();
  return transfer;
}

function waitFor(transfer, key, timeoutMs) {
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      removeWaiter(transfer, key, entry);
      reject(new Error('等待对方响应超时'));
    }, timeoutMs);
    const list = transfer.waiters.get(key) || [];
    list.push(entry);
    transfer.waiters.set(key, list);
  });
}

function removeWaiter(transfer, key, entry) {
  const list = transfer.waiters.get(key);
  if (!list) return;
  const next = list.filter((item) => item !== entry);
  if (next.length) transfer.waiters.set(key, next);
  else transfer.waiters.delete(key);
}

function resolveWaiter(transfer, key, value) {
  const list = transfer.waiters.get(key);
  if (!list || !list.length) return;
  const entry = list.shift();
  if (list.length) transfer.waiters.set(key, list);
  else transfer.waiters.delete(key);
  clearTimeout(entry.timer);
  entry.resolve(value);
}

function rejectWaiters(transfer, error) {
  for (const list of transfer.waiters.values()) {
    for (const entry of list) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
  transfer.waiters.clear();
}

function failTransfer(transfer, error) {
  if (!transfer || transfer.finalized) return;
  transfer.finalized = true;
  transfer.status = transfer.canceled ? 'canceled' : 'failed';
  transfer.error = error?.message || String(error || '传输失败');
  transfer.finishedAt = Date.now();
  transfer.speed = 0;
  transfer.current = null;
  for (const file of transfer.files) {
    if (file.status === 'transferring' || file.status === 'verifying' || file.status === 'pending') {
      file.status = 'failed';
      file.error = file.error || transfer.error;
    }
  }
  rejectWaiters(transfer, new Error(transfer.error));
  try {
    transfer.conn?.close();
  } catch {
    // ignore
  }
  scheduleDock();
}

function completeTransfer(transfer) {
  if (!transfer || transfer.finalized) return;
  transfer.finalized = true;
  const failed = transfer.files.some((file) => file.status === 'failed');
  transfer.status = failed ? 'failed' : 'done';
  if (failed && !transfer.error) transfer.error = '部分文件传输失败';
  transfer.finishedAt = Date.now();
  transfer.speed = 0;
  rejectWaiters(transfer, new Error('传输已结束'));
  scheduleDock();
  setTimeout(() => {
    try {
      transfer.conn?.close();
    } catch {
      // ignore
    }
  }, 1600);
}

function cancelTransfer(transfer, notifyPeer = true) {
  if (!transfer || transfer.finalized) return;
  transfer.canceled = true;
  transfer.finalized = true;
  transfer.status = 'canceled';
  transfer.error = '已取消';
  transfer.finishedAt = Date.now();
  transfer.speed = 0;
  transfer.current = null;
  for (const file of transfer.files) {
    if (file.status !== 'done') file.status = 'canceled';
  }
  if (notifyPeer) {
    try {
      transfer.conn?.sendJson({ k: 'cancel', transferId: transfer.id });
    } catch {
      // ignore
    }
  }
  rejectWaiters(transfer, new Error('传输已取消'));
  scheduleDock();
  setTimeout(() => {
    try {
      transfer.conn?.close();
    } catch {
      // ignore
    }
  }, 500);
}

function transferStatusText(transfer) {
  switch (transfer.status) {
    case 'preparing':
      return transfer.direction === 'send' ? '正在建立连接' : '准备接收';
    case 'waiting':
      return '等待对方接受';
    case 'transferring':
      return transfer.direction === 'send' ? '正在发送' : '正在接收';
    case 'done':
      return '完成';
    case 'rejected':
      return transfer.direction === 'receive' ? '已拒绝' : '对方拒绝';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    default:
      return transfer.status;
  }
}

function transferBadgeClass(transfer) {
  if (transfer.status === 'done') return '';
  if (transfer.status === 'failed') return 'is-error';
  if (transfer.status === 'rejected' || transfer.status === 'canceled') return 'is-warn';
  return 'is-active';
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                     */
/* -------------------------------------------------------------------------- */

function makeChunkReader(file, chunkSize, depth) {
  let offset = 0;
  let done = false;
  const queue = [];

  function schedule() {
    while (!done && queue.length < depth) {
      if (offset >= file.size) {
        done = true;
        break;
      }
      const start = offset;
      const end = Math.min(offset + chunkSize, file.size);
      offset = end;
      queue.push(
        file.slice(start, end).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      );
    }
  }

  return {
    async next() {
      schedule();
      if (!queue.length) return null;
      const promise = queue.shift();
      schedule();
      return promise;
    },
  };
}

async function startSend(peer, fileList) {
  if (!peer || !fileList?.length) return;
  if (!window.RTCPeerConnection) {
    showToast('当前浏览器不支持 WebRTC，无法发送文件', 'error');
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('信令连接未就绪，请稍后再试', 'error');
    return;
  }
  if (!findClient(peer.id)) {
    showToast('对方已离线', 'error');
    return;
  }

  if (fileList.some((file) => file.size > 1024 * 1024 * 1024)) {
    showToast('包含超过 1GB 的文件；没有 HTTPS 时接收端需要较多内存，可能失败', 'warn', 7000);
  }

  const transferId = uid();
  const meta = fileList.map((file, index) => ({
    id: `f${index}-${uid().slice(0, 8)}`,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
  }));

  let transfer = null;
  let conn = null;
  try {
    conn = new Conn({ peerId: peer.id, connId: uid(), initiator: true });
    state.conns.set(conn.connId, conn);
    transfer = createTransfer({ transferId, direction: 'send', peer, files: meta, conn });
    conn.handler = (message) => handleSenderMessage(conn, transfer, message);

    await conn.openPromise;
    transfer.status = 'waiting';
    debugLog('send-offer', conn.connId.slice(0, 6), transfer.id.slice(0, 6));
    conn.sendJson({
      k: 'offer',
      transferId,
      fromAlias: state.alias,
      files: meta,
      total: transfer.totalBytes,
    });
    scheduleDock();

    const decision = await waitFor(transfer, 'decision', OFFER_TIMEOUT_MS);
    if (!decision?.ok) {
      transfer.status = 'rejected';
      transfer.error = decision?.reason || '对方拒绝接收';
      transfer.finalized = true;
      transfer.finishedAt = Date.now();
      for (const file of transfer.files) file.status = 'rejected';
      lastDockRender = 0;
      scheduleDock();
      conn.close();
      return;
    }

    transfer.status = 'transferring';
    for (let index = 0; index < fileList.length; index += 1) {
      if (transfer.canceled) throw new Error('已取消');
      const file = fileList[index];
      const fileMeta = transfer.files[index];
      fileMeta.status = 'transferring';
      fileMeta.progress = file.size === 0 ? 1 : 0;
      conn.sendJson({ k: 'file-start', transferId, fileId: fileMeta.id, chunkSize: conn.chunkSize });

      const hasher = await hashwasm.createMD5();
      hasher.init();
      const reader = makeChunkReader(file, conn.chunkSize, PREFETCH_CHUNKS);
      let chunk = null;
      while ((chunk = await reader.next())) {
        if (transfer.canceled) throw new Error('已取消');
        await conn.sendChunk(chunk);
        hasher.update(chunk);
        transfer.bytes += chunk.byteLength;
        fileMeta.sent += chunk.byteLength;
        fileMeta.progress = fileMeta.size ? Math.min(1, fileMeta.sent / fileMeta.size) : 1;
        scheduleDock();
      }

      const md5 = hasher.digest('hex');
      fileMeta.md5 = md5;
      fileMeta.status = 'verifying';
      fileMeta.progress = 1;
      conn.sendJson({
        k: 'file-end',
        transferId,
        fileId: fileMeta.id,
        md5,
        size: file.size,
      });
      scheduleDock();

      const ack = await waitFor(transfer, `ack:${fileMeta.id}`, ACK_TIMEOUT_MS);
      if (ack.ok) {
        fileMeta.status = 'done';
        fileMeta.md5Ok = true;
      } else {
        fileMeta.status = 'failed';
        fileMeta.md5Ok = false;
        fileMeta.error = ack.error || '接收端 MD5 校验失败';
      }
      scheduleDock();
    }

    try {
      conn.sendJson({ k: 'done', transferId });
    } catch {
      // receiver may have closed after the last ack
    }
    completeTransfer(transfer);
  } catch (error) {
    if (transfer) {
      failTransfer(transfer, error);
    } else {
      showToast(`发送失败：${error.message}`, 'error');
      conn?.close(error.message);
    }
  }
}

function handleSenderMessage(conn, transfer, message) {
  if (!message || typeof message !== 'object') return;
  debugLog('smsg', message.k, transfer.id.slice(0, 6));
  switch (message.k) {
    case 'accept':
      resolveWaiter(transfer, 'decision', { ok: true });
      break;
    case 'reject':
      resolveWaiter(transfer, 'decision', { ok: false, reason: message.reason || '对方拒绝接收' });
      break;
    case 'file-ack':
      resolveWaiter(transfer, `ack:${message.fileId}`, {
        ok: Boolean(message.ok),
        error: message.error,
      });
      break;
    case 'cancel':
      transfer.canceled = true;
      cancelTransfer(transfer, false);
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Receiving                                                                   */
/* -------------------------------------------------------------------------- */

async function handleDefaultMessage(conn, message) {
  if (message.k === 'offer') {
    await handleIncomingOffer(conn, message);
  }
}

async function handleIncomingOffer(conn, message) {
  if (!Array.isArray(message.files) || !message.files.length) {
    try {
      conn.sendJson({ k: 'reject', transferId: message.transferId, reason: '文件列表为空' });
    } catch {
      // ignore
    }
    setTimeout(() => conn.close(), 500);
    return;
  }

  if (state.pendingIncoming) {
    try {
      conn.sendJson({ k: 'reject', transferId: message.transferId, reason: '对方忙碌' });
    } catch {
      // ignore
    }
    setTimeout(() => conn.close(), 500);
    return;
  }

  const files = message.files
    .map((file, index) => ({
      id: String(file.id || `f${index}`),
      name: safeName(file.name),
      size: Math.max(0, Number(file.size) || 0),
      type: String(file.type || 'application/octet-stream').slice(0, 120),
    }))
    .filter((file) => file.id);

  const peer = findClient(conn.peerId);
  const senderName = String(message.fromAlias || peer?.alias || '对方').slice(0, 40);
  const total = files.reduce((sum, file) => sum + file.size, 0);

  state.pendingIncoming = {
    conn,
    message,
    files,
    senderName,
    total,
    timer: setTimeout(() => {
      if (state.pendingIncoming) rejectIncoming('等待超时');
    }, OFFER_TIMEOUT_MS),
  };

  conn.clearIdle();
  renderIncoming();
  showModal('modal-incoming');
  document.title = `📥 收到文件 · 本地互传`;
  if (document.hidden) {
    showToast(`${senderName} 想发送 ${files.length} 个文件`, 'warn', 6000);
  }
}

function renderIncoming() {
  const pending = state.pendingIncoming;
  if (!pending) return;
  const peer = findClient(pending.conn.peerId);
  dom.incomingFrom.textContent = pending.senderName;
  dom.incomingMeta.textContent = `${peer?.ip || '未知 IP'} · ${pending.files.length} 个文件`;
  dom.incomingTotal.textContent = fmtBytes(pending.total);
  clearNode(dom.incomingFiles);
  for (const file of pending.files) {
    const li = document.createElement('li');
    li.appendChild(svgIcon('i-file'));
    const name = document.createElement('span');
    name.className = 'file-list-name';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'file-list-size';
    size.textContent = fmtBytes(file.size);
    li.append(name, size);
    dom.incomingFiles.appendChild(li);
  }
}

function acceptIncoming() {
  const pending = state.pendingIncoming;
  if (!pending) return;
  clearTimeout(pending.timer);
  state.pendingIncoming = null;
  hideModal('modal-incoming');
  document.title = '本地互传 · Local File Express';

  const { conn, message, files, senderName } = pending;
  if (conn.closed) {
    showToast('连接已断开，无法接收', 'error');
    return;
  }

  try {
    conn.sendJson({ k: 'accept', transferId: message.transferId });
  } catch (error) {
    showToast(`无法接受：${error.message}`, 'error');
    conn.close();
    return;
  }

  const peer = findClient(conn.peerId);
  const transfer = createTransfer({
    transferId: message.transferId,
    direction: 'receive',
    peer: peer || { id: conn.peerId, alias: senderName, ip: '' },
    files,
    conn,
  });
  transfer.status = 'transferring';
  conn.handler = (data) => handleReceiverData(conn, transfer, data);
  debugLog('accept', conn.connId.slice(0, 6), conn.dc?.readyState, transfer.id);
  scheduleDock();
}

function recordRejectedIncoming(pending, label) {
  const peer = findClient(pending.conn.peerId) || {
    id: pending.conn.peerId,
    alias: pending.senderName,
    ip: '',
  };
  const transfer = createTransfer({
    transferId: pending.message.transferId,
    direction: 'receive',
    peer,
    files: pending.files,
    conn: null,
  });
  transfer.status = 'rejected';
  transfer.error = label;
  transfer.finalized = true;
  transfer.finishedAt = Date.now();
  for (const file of transfer.files) file.status = 'rejected';
  state.dockCollapsed = false;
  lastDockRender = 0;
  scheduleDock();
}

function rejectIncoming(reason = 'rejected') {
  const pending = state.pendingIncoming;
  if (!pending) return;
  clearTimeout(pending.timer);
  state.pendingIncoming = null;
  hideModal('modal-incoming');
  document.title = '本地互传 · Local File Express';

  const label = reason === 'timeout'
    ? '等待超时，已自动拒绝'
    : reason === 'closed'
      ? '已关闭接收请求'
      : '已拒绝接收';
  recordRejectedIncoming(pending, label);

  try {
    pending.conn.sendJson({
      k: 'reject',
      transferId: pending.message.transferId,
      reason: reason === 'timeout' ? '等待超时' : reason === 'closed' ? '对方关闭了请求' : '对方拒绝接收',
    });
  } catch {
    // ignore
  }
  setTimeout(() => pending.conn.close(), 500);
}

async function handleReceiverData(conn, transfer, data) {
  if (data instanceof ArrayBuffer) {
    const current = transfer.current;
    if (!current || transfer.canceled) return;
    const chunk = new Uint8Array(data);
    if (current.received + chunk.byteLength > current.meta.size) {
      throw new Error('收到的数据超过声明的文件大小');
    }
    current.parts.push(chunk);
    current.received += chunk.byteLength;
    current.hasher.update(chunk);
    transfer.bytes += chunk.byteLength;
    current.meta.sent = current.received;
    current.meta.progress = current.meta.size
      ? Math.min(1, current.received / current.meta.size)
      : 1;
    scheduleDock();
    return;
  }

  // Control messages arrive already parsed from Conn.enqueue.
  const message = data;
  if (!message || typeof message !== 'object') return;
  debugLog('rdata', message.k, transfer.id.slice(0, 6));

  switch (message.k) {
    case 'file-start': {
      if (transfer.current) throw new Error('文件状态错乱');
      const meta = transfer.files.find((file) => file.id === message.fileId);
      if (!meta) throw new Error('收到未知文件');
      const hasher = await hashwasm.createMD5();
      hasher.init();
      transfer.current = { meta, hasher, parts: [], received: 0 };
      meta.status = 'transferring';
      meta.progress = 0;
      scheduleDock();
      break;
    }
    case 'file-end': {
      const current = transfer.current;
      if (!current || current.meta.id !== message.fileId) {
        throw new Error('文件结束消息与当前文件不匹配');
      }
      const digest = current.hasher.digest('hex');
      const sizeOk = current.received === current.meta.size;
      const hashOk = digest.toLowerCase() === String(message.md5 || '').toLowerCase();
      transfer.current = null;
      current.meta.md5 = digest;

      if (!sizeOk || !hashOk) {
        current.meta.status = 'failed';
        current.meta.md5Ok = false;
        current.meta.error = sizeOk ? 'MD5 校验失败' : '文件大小不一致';
        current.parts.length = 0;
        conn.sendJson({
          k: 'file-ack',
          transferId: transfer.id,
          fileId: current.meta.id,
          ok: false,
          error: current.meta.error,
        });
        scheduleDock();
        break;
      }

      const blob = new Blob(current.parts, { type: current.meta.type });
      current.parts.length = 0;
      const url = URL.createObjectURL(blob);
      current.meta.blobUrl = url;
      current.meta.md5 = digest;
      current.meta.md5Ok = true;
      current.meta.status = 'done';
      current.meta.progress = 1;
      queueDownload(url, current.meta.name);
      setTimeout(() => {
        if (current.meta.blobUrl !== url) return;
        current.meta.blobUrl = null;
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        scheduleDock();
      }, 10 * 60 * 1000);
      conn.sendJson({
        k: 'file-ack',
        transferId: transfer.id,
        fileId: current.meta.id,
        ok: true,
        md5: digest,
      });
      scheduleDock();
      break;
    }
    case 'done': {
      completeTransfer(transfer);
      break;
    }
    case 'cancel': {
      cancelTransfer(transfer, false);
      break;
    }
    default:
      break;
  }
}

const downloadQueue = [];
let downloadBusy = false;

function queueDownload(url, name) {
  downloadQueue.push({ url, name });
  drainDownloads();
}

async function drainDownloads() {
  if (downloadBusy || !downloadQueue.length) return;
  downloadBusy = true;
  const item = downloadQueue.shift();
  try {
    triggerDownload(item.url, item.name);
  } catch (error) {
    showToast(`保存 ${item.name} 失败：${error.message}`, 'error');
  }
  await sleep(260);
  downloadBusy = false;
  drainDownloads();
}

function triggerDownload(url, name) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName(name);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/* -------------------------------------------------------------------------- */
/* Rendering — identity and clients                                           */
/* -------------------------------------------------------------------------- */

function inviteUrl() {
  const port = location.port ? `:${location.port}` : '';
  const loopback = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';
  if (loopback && state.serverAddresses.length) {
    return `http://${state.serverAddresses[0]}${port}`;
  }
  return location.origin;
}

function renderMe() {
  const self = selfClient();
  dom.meAlias.textContent = state.alias;
  dom.meIp.textContent = self ? self.ip : '—';
  try {
    dom.statAddress.textContent = new URL(inviteUrl()).host;
  } catch {
    dom.statAddress.textContent = location.host;
  }
  dom.statClients.textContent = String(state.clients.length);
}

function renderClients() {
  const self = selfClient();
  const clients = [...state.clients].sort((a, b) => {
    if (a.id === state.myId) return -1;
    if (b.id === state.myId) return 1;
    return String(a.alias).localeCompare(String(b.alias), 'zh-CN');
  });

  clearNode(dom.clientList);
  dom.clientsEmpty.hidden = clients.length > 1 || (clients.length === 1 && clients[0].id !== state.myId);

  if (clients.length === 1 && self) {
    dom.clientsEmpty.hidden = false;
  }

  for (const client of clients) {
    const isSelf = client.id === state.myId;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `client-card${isSelf ? ' is-self' : ''}`;
    card.dataset.clientId = client.id;
    card.dataset.ip = client.ip;
    card.title = isSelf ? '这是本机' : `发送文件给 ${client.alias}`;

    const icon = deviceIcon(client);
    const avatar = document.createElement('span');
    avatar.className = `avatar ${icon.tone}`.trim();
    avatar.appendChild(svgIcon(icon.symbol));

    const main = document.createElement('span');
    main.className = 'client-main';
    const name = document.createElement('span');
    name.className = 'client-name';
    name.textContent = client.alias;
    const ip = document.createElement('span');
    ip.className = 'client-ip';
    ip.textContent = client.ip;
    const meta = document.createElement('span');
    meta.className = 'client-meta';
    meta.textContent = `${deviceLabel(client)}${countTabsAtIp(client.ip) > 1 ? ` · ${countTabsAtIp(client.ip)} 个标签页` : ''}`;
    main.append(name, ip, meta);

    const side = document.createElement('span');
    side.className = 'client-side';
    if (isSelf) {
      const tag = document.createElement('span');
      tag.className = 'tag tag-self';
      tag.textContent = '本机';
      side.appendChild(tag);
    } else {
      const hint = document.createElement('span');
      hint.className = 'client-send-hint';
      hint.append(document.createTextNode('选择文件'));
      hint.appendChild(svgIcon('i-send'));
      side.appendChild(hint);
    }

    card.append(avatar, main, side);

    if (!isSelf) {
      card.addEventListener('click', () => openFilePicker(client));
      bindDropTarget(card, client);
    } else {
      card.addEventListener('click', () => showToast('这是本机，请选择其他客户端', 'warn'));
    }

    dom.clientList.appendChild(card);
  }
}

function countTabsAtIp(ip) {
  return state.clients.filter((client) => client.ip === ip).length;
}

/* -------------------------------------------------------------------------- */
/* Rendering — LAN                                                            */
/* -------------------------------------------------------------------------- */

function ipNum(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return Number.MAX_SAFE_INTEGER;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function renderLan() {
  const data = state.lan;
  const hosts = [...(data?.hosts || [])];
  const knownIps = new Set(hosts.map((host) => host.ip));

  // Merge live registered clients immediately, even if the last LAN scan did
  // not include their IP (e.g. two tabs on one machine, or a fresh client).
  for (const client of state.clients) {
    if (!client.ip || knownIps.has(client.ip)) continue;
    knownIps.add(client.ip);
    hosts.push({
      ip: client.ip,
      hostname: '',
      mac: '',
      state: 'client',
      online: true,
      sources: ['client'],
      clients: [],
      registered: true,
      isServer: false,
    });
  }

  hosts.sort((a, b) => {
    const aRegistered = a.registered || state.clients.some((client) => client.ip === a.ip);
    const bRegistered = b.registered || state.clients.some((client) => client.ip === b.ip);
    if (aRegistered !== bRegistered) return aRegistered ? -1 : 1;
    return ipNum(a.ip) - ipNum(b.ip);
  });

  dom.statHosts.textContent = String(hosts.length);

  if (data) {
    const subnet = data.subnets?.[0]?.address
      ? `${data.subnets[0].address}/${data.subnets[0].prefix}`
      : '本机网段';
    const scanned = data.scannedAt ? fmtTime(data.scannedAt) : '—';
    dom.lanSub.textContent = `${subnet} · ${hosts.length} 台 · 更新于 ${scanned}`;
  } else if (hosts.length) {
    dom.lanSub.textContent = `${hosts.length} 台在线客户端 · 等待局域网扫描`;
  } else {
    dom.lanSub.textContent = '服务器所在网段的机器';
  }

  dom.scanBar.hidden = !state.lanLoading;
  dom.lanEmpty.hidden = hosts.length > 0;

  clearNode(dom.lanList);

  for (const host of hosts) {
    const liveClients = state.clients.filter((client) => client.ip === host.ip);
    const listedClients = liveClients.length ? liveClients : (host.clients || []);
    const otherClients = listedClients.filter((client) => client.id !== state.myId);
    const canSend = otherClients.length > 0;
    const registered = listedClients.length > 0 || host.registered;
    const selfHere = liveClients.some((client) => client.id === state.myId);
    const isServer = host.isServer;
    const online = registered || host.online;

    const row = document.createElement('div');
    row.className = `lan-row${canSend ? ' clickable' : ''}${selfHere ? ' is-self' : ''}${online ? ' is-online' : ''}`;
    row.dataset.ip = host.ip;
    row.dataset.canSend = canSend ? '1' : '0';

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    const ip = document.createElement('span');
    ip.className = 'lan-ip';
    ip.textContent = host.ip;

    const hostBlock = document.createElement('span');
    hostBlock.className = 'lan-host';
    const hostName = document.createElement('strong');
    hostName.textContent = otherClients[0]?.alias
      || host.hostname
      || (isServer ? '本机服务器' : registered ? listedClients[0]?.alias || '在线客户端' : '未知主机');
    const sub = document.createElement('span');
    const stateLabel = host.state && !['local', 'stale'].includes(host.state) ? host.state : '';
    sub.textContent = host.mac
      || (isServer ? '服务器地址' : registered ? `${otherClients.length || listedClients.length} 个客户端` : stateLabel || '仅发现');
    hostBlock.append(hostName, sub);

    const badges = document.createElement('span');
    badges.className = 'lan-badges';
    if (selfHere) badges.appendChild(makeTag('本机', 'tag-self'));
    if (canSend) badges.appendChild(makeTag(`${otherClients.length} 在线`, 'tag-live'));
    if (isServer) badges.appendChild(makeTag('服务器', 'tag-blue'));
    if (!registered) badges.appendChild(makeTag('未打开页面', 'tag-muted'));
    else if (selfHere && !canSend) badges.appendChild(makeTag('仅本机', 'tag-muted'));

    const actions = document.createElement('span');
    actions.className = 'lan-actions';
    if (canSend) {
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'btn btn-outline';
      send.dataset.action = 'send';
      send.append(svgIcon('i-send'), document.createTextNode('发送'));
      actions.appendChild(send);
    } else {
      const invite = document.createElement('button');
      invite.type = 'button';
      invite.className = 'btn btn-ghost';
      invite.dataset.action = 'invite';
      invite.append(svgIcon('i-link'), document.createTextNode('邀请'));
      actions.appendChild(invite);
    }

    row.append(dot, ip, hostBlock, badges, actions);
    dom.lanList.appendChild(row);
  }
}

function makeTag(text, className = '') {
  const tag = document.createElement('span');
  tag.className = `tag ${className}`.trim();
  tag.textContent = text;
  return tag;
}

/* -------------------------------------------------------------------------- */
/* Rendering — custom devices                                                 */
/* -------------------------------------------------------------------------- */

function renderCustom() {
  dom.customCount.textContent = `${state.custom.length} 个`;
  dom.customEmpty.hidden = state.custom.length > 0;
  clearNode(dom.customList);

  for (const entry of state.custom) {
    const onlineClients = clientsByIp(entry.ip).filter((client) => client.id !== state.myId);
    const online = onlineClients.length > 0;
    const testing = state.testingIps.has(entry.ip);

    const row = document.createElement('div');
    row.className = `custom-row${online ? ' is-online' : ''}`;
    row.dataset.id = entry.id;

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    const main = document.createElement('span');
    main.className = 'custom-main';
    const label = document.createElement('strong');
    label.textContent = entry.label || entry.ip;
    const ip = document.createElement('span');
    ip.textContent = entry.ip;
    main.append(label, ip);

    const status = document.createElement('span');
    status.className = `custom-status${online ? ' is-online' : entry.lastOkAt ? '' : ' is-unknown'}`;
    if (testing) {
      status.textContent = '测试中…';
    } else if (online) {
      status.textContent = entry.lastRttMs ? `在线 · RTT ${entry.lastRttMs}ms` : '在线';
    } else if (entry.lastOkAt) {
      status.textContent = `上次验证 ${fmtTime(entry.lastOkAt)}`;
    } else {
      status.textContent = '未验证';
    }

    const actions = document.createElement('span');
    actions.className = 'custom-actions';

    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-outline';
    send.dataset.action = 'send';
    send.disabled = !online || testing;
    send.textContent = '发送';

    const retest = document.createElement('button');
    retest.type = 'button';
    retest.className = 'icon-btn';
    retest.dataset.action = 'test';
    retest.title = '重新测试连接';
    retest.disabled = !online || testing;
    retest.appendChild(svgIcon('i-wave'));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-btn';
    edit.dataset.action = 'edit';
    edit.title = '编辑';
    edit.appendChild(svgIcon('i-edit'));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.dataset.action = 'delete';
    remove.title = '删除';
    remove.appendChild(svgIcon('i-trash'));

    actions.append(send, retest, edit, remove);
    row.append(dot, main, status, actions);
    dom.customList.appendChild(row);
  }
}

/* -------------------------------------------------------------------------- */
/* LAN loading                                                                */
/* -------------------------------------------------------------------------- */

async function loadLan(full = false) {
  if (state.lanLoading) return;
  state.lanLoading = true;
  dom.scanBar.hidden = false;
  dom.scanText.textContent = full ? '正在完整扫描局域网，可能需要几秒…' : '正在刷新局域网列表…';
  const scanButton = $('#btn-scan');
  const refreshButton = $('#btn-refresh');
  scanButton.disabled = true;
  refreshButton.disabled = true;

  try {
    const response = await fetch(`/api/lan${full ? '?full=1' : ''}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.lan = await response.json();
  } catch (error) {
    showToast(`局域网扫描失败：${error.message}`, 'error');
  } finally {
    state.lanLoading = false;
    dom.scanBar.hidden = true;
    scanButton.disabled = false;
    refreshButton.disabled = false;
    renderLan();
    clearTimeout(state.lanPollTimer);
    if (!full && state.lan?.fullScanRunning) {
      state.lanPollTimer = setTimeout(() => loadLan(false), 2000);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Custom devices                                                             */
/* -------------------------------------------------------------------------- */

function renderPick(candidates, callback, title = '选择目标客户端') {
  dom.pickTitle.textContent = title;
  clearNode(dom.pickList);

  for (const client of candidates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pick-item';
    button.dataset.clientId = client.id;
    const icon = deviceIcon(client);
    const avatar = document.createElement('span');
    avatar.className = `avatar ${icon.tone}`.trim();
    avatar.appendChild(svgIcon(icon.symbol));
    const main = document.createElement('span');
    main.className = 'pick-main';
    const name = document.createElement('strong');
    name.textContent = client.alias;
    const meta = document.createElement('span');
    meta.textContent = `${client.ip} · ${deviceLabel(client)}`;
    main.append(name, meta);
    button.append(avatar, main, svgIcon('i-chevron'));
    button.addEventListener('click', () => {
      hideModal('modal-pick');
      callback?.(client);
    });
    dom.pickList.appendChild(button);
  }
  showModal('modal-pick');
}

function chooseClient(candidates, title) {
  if (!candidates.length) return Promise.resolve(null);
  if (candidates.length === 1) return Promise.resolve(candidates[0]);
  return new Promise((resolve) => {
    state.pickResolve = resolve;
    renderPick(candidates, (client) => {
      state.pickResolve = null;
      resolve(client);
    }, title);
  });
}

function cancelPick() {
  const resolve = state.pickResolve;
  state.pickResolve = null;
  hideModal('modal-pick');
  resolve?.(null);
}

async function testPeer(client) {
  const conn = new Conn({ peerId: client.id, connId: uid(), initiator: true });
  state.conns.set(conn.connId, conn);
  try {
    await conn.openPromise;
    const rtts = [];
    for (let index = 0; index < 3; index += 1) {
      const started = now();
      const pong = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          conn.onPong = null;
          reject(new Error('Ping 超时'));
        }, 3500);
        conn.onPong = () => {
          clearTimeout(timer);
          conn.onPong = null;
          resolve();
        };
      });
      conn.sendJson({ k: 'ping', t: started, seq: index });
      await pong;
      rtts.push(now() - started);
    }
    return Math.round(rtts.reduce((sum, value) => sum + value, 0) / rtts.length);
  } finally {
    conn.close();
  }
}

async function addCustomDevice() {
  const ip = dom.customIp.value.trim();
  const label = dom.customLabel.value.trim();

  if (!isIPv4(ip)) {
    showToast('请输入有效的 IPv4 地址，例如 192.168.1.23', 'error');
    return;
  }

  const candidates = clientsByIp(ip).filter((client) => client.id !== state.myId);
  if (!candidates.length) {
    showToast('该 IP 上没有其他正在显示本页面的浏览器，无法建立连接', 'error', 6500);
    return;
  }

  const existing = state.custom.find((entry) => entry.ip === ip);

  dom.testAddBtn.disabled = true;
  const original = dom.testAddBtn.innerHTML;
  dom.testAddBtn.textContent = '测试连接中…';
  try {
    const target = await chooseClient(candidates, '选择要测试的客户端');
    if (!target) return;
    const rtt = await testPeer(target);
    if (existing) {
      existing.label = label || existing.label || target.alias || ip;
      existing.lastOkAt = Date.now();
      existing.lastRttMs = rtt;
    } else {
      state.custom.push({
        id: uid(),
        ip,
        label: label || target.alias || ip,
        addedAt: Date.now(),
        lastOkAt: Date.now(),
        lastRttMs: rtt,
      });
    }
    saveCustom();
    renderCustom();
    dom.customIp.value = '';
    dom.customLabel.value = '';
    showToast(`连接成功，往返 ${rtt}ms，已保存到本机`, 'success');
  } catch (error) {
    showToast(`测试失败：${error.message}`, 'error', 6500);
  } finally {
    dom.testAddBtn.disabled = false;
    dom.testAddBtn.innerHTML = original;
  }
}

async function retestCustom(entry) {
  const candidates = clientsByIp(entry.ip).filter((client) => client.id !== state.myId);
  if (!candidates.length) {
    showToast('该 IP 上没有其他正在显示本页面的浏览器', 'error');
    return;
  }
  state.testingIps.add(entry.ip);
  renderCustom();
  try {
    const target = await chooseClient(candidates, '选择要测试的客户端');
    if (!target) return;
    const rtt = await testPeer(target);
    entry.lastOkAt = Date.now();
    entry.lastRttMs = rtt;
    saveCustom();
    showToast(`重测成功，RTT ${rtt}ms`, 'success');
  } catch (error) {
    showToast(`重测失败：${error.message}`, 'error');
  } finally {
    state.testingIps.delete(entry.ip);
    renderCustom();
  }
}

function openCustomEditor(entry) {
  state.editCustomId = entry.id;
  dom.editLabel.value = entry.label || '';
  dom.editIp.value = entry.ip;
  showModal('modal-custom-edit');
  setTimeout(() => dom.editLabel.focus(), 30);
}

function saveCustomEditor(event) {
  event.preventDefault();
  const entry = state.custom.find((item) => item.id === state.editCustomId);
  if (!entry) return;
  const ip = dom.editIp.value.trim();
  const label = dom.editLabel.value.trim();
  if (!isIPv4(ip)) {
    showToast('请输入有效的 IPv4 地址', 'error');
    return;
  }
  if (state.custom.some((item) => item.id !== entry.id && item.ip === ip)) {
    showToast('该 IP 已在自定义列表中', 'error');
    return;
  }
  if (ip !== entry.ip) {
    entry.lastOkAt = null;
    entry.lastRttMs = null;
  }
  entry.ip = ip;
  entry.label = label || ip;
  saveCustom();
  renderCustom();
  hideModal('modal-custom-edit');
  showToast('已保存', 'success');
}

async function deleteCustom(entry) {
  const ok = await confirmDialog(
    '删除自定义设备',
    `确定删除「${entry.label || entry.ip}」吗？只会删除当前浏览器里的这条记录。`,
    '删除',
  );
  if (!ok) return;
  state.custom = state.custom.filter((item) => item.id !== entry.id);
  saveCustom();
  renderCustom();
  showToast('已删除', 'success');
}

/* -------------------------------------------------------------------------- */
/* File picker and drop                                                       */
/* -------------------------------------------------------------------------- */

function openFilePicker(client) {
  if (!client || client.id === state.myId) return;
  if (!findClient(client.id)) {
    showToast('对方已离线', 'error');
    return;
  }
  state.fileTarget = client;
  dom.fileInput.value = '';
  dom.fileInput.click();
}

function openPickerForIp(ip) {
  const candidates = clientsByIp(ip).filter((client) => client.id !== state.myId);
  if (!candidates.length) {
    showToast('该 IP 上没有其他正在显示本页面的浏览器', 'error');
    return;
  }
  if (candidates.length === 1) {
    openFilePicker(candidates[0]);
    return;
  }
  renderPick(candidates, (client) => openFilePicker(client), '选择接收文件的客户端');
}

function bindDropTarget(element, client) {
  element.addEventListener('dragenter', (event) => {
    event.preventDefault();
    element.classList.add('dragover');
  });
  element.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    element.classList.add('dragover');
  });
  element.addEventListener('dragleave', (event) => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('dragover');
  });
  element.addEventListener('drop', (event) => {
    event.preventDefault();
    element.classList.remove('dragover');
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) startSend(client, files);
  });
}

/* -------------------------------------------------------------------------- */
/* Transfer dock rendering                                                    */
/* -------------------------------------------------------------------------- */

let dockTimer = null;
let lastDockRender = 0;

function scheduleDock() {
  const elapsed = now() - lastDockRender;
  if (elapsed >= 150) {
    lastDockRender = now();
    renderDock();
    return;
  }
  if (dockTimer) return;
  dockTimer = setTimeout(() => {
    dockTimer = null;
    lastDockRender = now();
    renderDock();
  }, 150 - elapsed);
}

function renderDock() {
  const transfers = [...state.transfers.values()].sort((a, b) => b.startedAt - a.startedAt);
  dom.dockCount.textContent = String(transfers.length);
  dom.transferDock.hidden = transfers.length === 0;
  dom.transferDock.classList.toggle('collapsed', state.dockCollapsed);

  if (!transfers.length) {
    clearNode(dom.transferList);
    return;
  }

  clearNode(dom.transferList);
  for (const transfer of transfers) {
    dom.transferList.appendChild(renderTransferCard(transfer));
  }
}

function renderTransferCard(transfer) {
  const card = document.createElement('div');
  card.className = 'transfer-card';
  card.dataset.transferId = transfer.id;

  const head = document.createElement('div');
  head.className = 'transfer-head';
  const peer = document.createElement('div');
  peer.className = 'transfer-peer';

  const peerClient = findClient(transfer.peerId);
  const icon = deviceIcon(peerClient || {});
  const avatar = document.createElement('span');
  avatar.className = `avatar ${icon.tone}`.trim();
  avatar.appendChild(svgIcon(icon.symbol));

  const peerText = document.createElement('div');
  peerText.className = 'transfer-peer-text';
  const peerName = document.createElement('strong');
  peerName.textContent = transfer.peerAlias;
  const peerMeta = document.createElement('span');
  peerMeta.textContent = `${transfer.direction === 'send' ? '发送给' : '接收自'} ${transfer.peerIp || '对方'}`;
  peerText.append(peerName, peerMeta);
  peer.append(avatar, peerText);

  const right = document.createElement('div');
  right.className = 'transfer-head-right';
  const badge = document.createElement('span');
  badge.className = `transfer-badge ${transferBadgeClass(transfer)}`.trim();
  badge.textContent = transferStatusText(transfer);
  right.appendChild(badge);

  if (!transfer.finalized) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'icon-btn transfer-cancel';
    cancel.dataset.action = 'cancel';
    cancel.title = '取消传输';
    cancel.appendChild(svgIcon('i-x'));
    right.appendChild(cancel);
  }
  head.append(peer, right);

  const progress = document.createElement('div');
  progress.className = `progress${transfer.status === 'failed' ? ' is-error' : ''}`;
  const bar = document.createElement('span');
  const ratio = transfer.totalBytes > 0
    ? Math.min(1, transfer.bytes / transfer.totalBytes)
    : transfer.status === 'done' ? 1 : 0;
  bar.style.width = `${ratio * 100}%`;
  progress.appendChild(bar);

  const stats = document.createElement('div');
  stats.className = 'transfer-stats';
  const leftStats = document.createElement('span');
  if (transfer.status === 'transferring' || transfer.status === 'done' || transfer.status === 'failed') {
    leftStats.textContent = `${fmtBytes(transfer.bytes)} / ${fmtBytes(transfer.totalBytes)}`;
  } else {
    leftStats.textContent = `${transfer.files.length} 个文件 · ${fmtBytes(transfer.totalBytes)}`;
  }
  const rightStats = document.createElement('span');
  if (transfer.status === 'transferring') {
    const eta = transfer.speed > 0 ? (transfer.totalBytes - transfer.bytes) / transfer.speed : 0;
    rightStats.textContent = `${fmtSpeed(transfer.speed)}${eta > 0 ? ` · ${fmtDuration(eta)}` : ''}`;
  } else if (transfer.status === 'done') {
    rightStats.textContent = `${((transfer.finishedAt - transfer.startedAt) / 1000).toFixed(1)}s`;
  } else {
    rightStats.textContent = '';
  }
  stats.append(leftStats, rightStats);

  card.append(head, progress, stats);

  if (transfer.files.length) {
    const files = document.createElement('div');
    files.className = 'transfer-files';
    for (const file of transfer.files) {
      const row = document.createElement('div');
      row.className = 'transfer-file';
      const name = document.createElement('span');
      name.className = 'transfer-file-name';
      name.append(svgIcon('i-file'));
      const text = document.createElement('span');
      text.textContent = file.name;
      name.appendChild(text);

      const size = document.createElement('span');
      size.className = 'transfer-file-size';
      size.textContent = fmtBytes(file.size);

      const md5 = document.createElement('span');
      if (file.md5Ok === true) {
        md5.className = 'md5 ok';
        md5.append(svgIcon('i-check'), document.createTextNode('MD5'));
      } else if (file.md5Ok === false) {
        md5.className = 'md5 bad';
        md5.append(svgIcon('i-x'), document.createTextNode('MD5'));
      } else if (file.status === 'verifying') {
        md5.className = 'md5 pending';
        md5.append(svgIcon('i-wave'), document.createTextNode('校验中'));
      } else if (file.status === 'rejected') {
        md5.className = 'md5 bad';
        md5.textContent = '已拒绝';
      } else if (file.status === 'failed') {
        md5.className = 'md5 bad';
        md5.textContent = '失败';
      } else if (file.status === 'canceled') {
        md5.className = 'md5 idle';
        md5.textContent = '已取消';
      } else {
        md5.className = 'md5 idle';
        md5.textContent = 'MD5';
      }

      row.append(name, size, md5);
      files.appendChild(row);
    }
    card.appendChild(files);
  }

  const hasSave = transfer.files.some((file) => file.blobUrl && file.status === 'done');
  if (hasSave) {
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-ghost transfer-save';
    save.dataset.action = 'save';
    save.append(svgIcon('i-download'), document.createTextNode('再次保存'));
    card.appendChild(save);
  }

  if (transfer.error) {
    const note = document.createElement('p');
    note.className = `transfer-note${transfer.status === 'failed' ? ' is-error' : ''}`;
    note.textContent = transfer.error;
    card.appendChild(note);
  }

  return card;
}

/* -------------------------------------------------------------------------- */
/* UI events                                                                  */
/* -------------------------------------------------------------------------- */

function initUi() {
  $('#btn-alias').addEventListener('click', () => {
    dom.aliasInput.value = state.alias;
    showModal('modal-alias');
    setTimeout(() => dom.aliasInput.focus(), 30);
  });

  $('#btn-invite').addEventListener('click', copyInvite);
  $('#btn-invite-empty').addEventListener('click', copyInvite);
  $('#btn-refresh').addEventListener('click', () => loadLan(false));
  $('#btn-scan').addEventListener('click', () => loadLan(true));

  $('#btn-accept').addEventListener('click', acceptIncoming);
  $('#btn-reject').addEventListener('click', () => rejectIncoming('rejected'));

  $('#btn-pick-cancel').addEventListener('click', cancelPick);
  $('#btn-confirm-cancel').addEventListener('click', () => resolveConfirm(false));
  $('#btn-confirm-ok').addEventListener('click', () => resolveConfirm(true));

  $('#form-alias').addEventListener('submit', (event) => {
    event.preventDefault();
    const alias = dom.aliasInput.value.trim().slice(0, 40);
    if (!alias) {
      showToast('名称不能为空', 'error');
      return;
    }
    state.alias = alias;
    saveAlias(alias);
    const self = selfClient();
    if (self) self.alias = alias;
    sendWS({ type: 'alias', alias });
    renderMe();
    renderClients();
    hideModal('modal-alias');
    showToast('名称已更新', 'success');
  });

  $('#form-custom-edit').addEventListener('submit', saveCustomEditor);

  dom.customForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addCustomDevice();
  });

  dom.fileInput.addEventListener('change', () => {
    const files = [...(dom.fileInput.files || [])];
    const target = state.fileTarget;
    state.fileTarget = null;
    dom.fileInput.value = '';
    if (files.length && target) startSend(target, files);
  });

  dom.lanList.addEventListener('click', (event) => {
    const row = event.target.closest('.lan-row');
    if (!row) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'invite') {
      copyInvite();
      return;
    }
    if (row.dataset.canSend !== '1') return;
    if (action === 'send' || !event.target.closest('button')) {
      openPickerForIp(row.dataset.ip);
    }
  });

  dom.customList.addEventListener('click', (event) => {
    const row = event.target.closest('.custom-row');
    if (!row) return;
    const entry = state.custom.find((item) => item.id === row.dataset.id);
    if (!entry) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'send') {
      openPickerForIp(entry.ip);
    } else if (action === 'test') {
      retestCustom(entry);
    } else if (action === 'edit') {
      openCustomEditor(entry);
    } else if (action === 'delete') {
      deleteCustom(entry);
    }
  });

  dom.transferList.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    const card = event.target.closest('.transfer-card');
    if (!card) return;
    const transfer = state.transfers.get(card.dataset.transferId);
    if (!transfer) return;
    if (action === 'cancel') {
      cancelTransfer(transfer, true);
    } else if (action === 'save') {
      for (const file of transfer.files) {
        if (file.blobUrl && file.status === 'done') triggerDownload(file.blobUrl, file.name);
      }
    }
  });

  $('#btn-dock-toggle').addEventListener('click', (event) => {
    event.stopPropagation();
    state.dockCollapsed = !state.dockCollapsed;
    renderDock();
  });
  $('#dock-head').addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    state.dockCollapsed = !state.dockCollapsed;
    renderDock();
  });
  $('#btn-dock-clear').addEventListener('click', (event) => {
    event.stopPropagation();
    for (const [id, transfer] of [...state.transfers.entries()]) {
      if (!transfer.finalized) continue;
      for (const file of transfer.files) {
        if (file.blobUrl) {
          try { URL.revokeObjectURL(file.blobUrl); } catch { /* ignore */ }
        }
      }
      state.transfers.delete(id);
    }
    renderDock();
  });

  for (const close of $$('[data-close]')) {
    close.addEventListener('click', () => {
      const id = close.dataset.close;
      if (id === 'modal-incoming') rejectIncoming('closed');
      else if (id === 'modal-pick') cancelPick();
      else if (id === 'modal-confirm') resolveConfirm(false);
      else hideModal(id);
    });
  }

  for (const backdrop of $$('.modal-backdrop')) {
    backdrop.addEventListener('click', (event) => {
      if (event.target !== backdrop) return;
      // Clicking outside the incoming dialog must not silently reject the
      // sender. The explicit "拒绝" / close button is the only rejection path.
      if (backdrop.id === 'modal-incoming') return;
      if (backdrop.id === 'modal-pick') cancelPick();
      else if (backdrop.id === 'modal-confirm') resolveConfirm(false);
      else backdrop.hidden = true;
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTopModal();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // The title may still show the incoming marker.
      if (!state.pendingIncoming) document.title = '本地互传 · Local File Express';
    }
  });

  window.addEventListener('beforeunload', () => {
    try { state.ws?.close(); } catch { /* ignore */ }
    closeAllConns('页面已关闭');
  });

  window.addEventListener('storage', (event) => {
    if (event.key === LS_ALIAS) {
      state.alias = loadAlias();
      renderMe();
      renderClients();
      sendWS({ type: 'alias', alias: state.alias });
    } else if (event.key === LS_CUSTOM) {
      state.custom = loadCustom();
      renderCustom();
    }
  });

  if (state.debug) {
    dom.debugPanel.hidden = false;
    window.addEventListener('error', (event) => debugLog('ERR', event.message));
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      debugLog('REJ', reason?.message || String(reason));
    });
    setInterval(updateDebug, 1000);
    updateDebug();
    window.__localsendDebug = {
      state,
      startSend,
      openFilePicker,
      testPeer,
      inviteUrl,
      findClient,
      clientsByIp,
      cancelTransfer,
    };
  }
}

async function copyInvite() {
  const url = inviteUrl();
  const ok = await copyText(url);
  showToast(ok ? `已复制邀请链接：${url}` : '复制失败，请手动复制地址栏', ok ? 'success' : 'error');
}

function updateDebug() {
  if (!state.debug) return;
  const conns = [...state.conns.values()]
    .map((conn) => {
      const buffered = conn.dc?.bufferedAmount || 0;
      return `${conn.connId.slice(0, 8)} ${conn.dc?.readyState || '-'} buf=${buffered} chunk=${conn.chunkSize}`;
    })
    .join('\n');
  const transfers = [...state.transfers.values()]
    .map((transfer) => `${transfer.direction} ${transfer.status} ${fmtBytes(transfer.bytes)}/${fmtBytes(transfer.totalBytes)} ${fmtSpeed(transfer.speed)}`)
    .join('\n');
  dom.debugPanel.textContent = [
    `ws=${state.wsState} myId=${state.myId || '-'}`,
    `clients=${state.clients.length} conns=${state.conns.size} transfers=${state.transfers.size}`,
    `alias=${state.alias}`,
    `origin=${location.origin}`,
    `lan=${state.lan?.hosts?.length || 0} hosts`,
    conns ? `\n[conns]\n${conns}` : '',
    transfers ? `\n[transfers]\n${transfers}` : '',
    state.logs.length ? `\n[log]\n${state.logs.slice(-25).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function sampleSpeeds() {
  const timestamp = now();
  for (const transfer of state.transfers.values()) {
    if (transfer.finalized) {
      transfer.speed = 0;
      continue;
    }
    const elapsed = (timestamp - transfer.lastSampleAt) / 1000;
    if (elapsed < 0.4) continue;
    const delta = transfer.bytes - transfer.lastSampleBytes;
    const instant = delta / elapsed;
    transfer.speed = transfer.speed > 0 ? transfer.speed * 0.55 + instant * 0.45 : instant;
    transfer.lastSampleAt = timestamp;
    transfer.lastSampleBytes = transfer.bytes;
    scheduleDock();
  }
}

function boot() {
  dom.meAlias.textContent = state.alias;
  dom.statAddress.textContent = location.host;
  setConnState('connecting');

  if (!window.RTCPeerConnection) {
    showToast('当前浏览器不支持 WebRTC，只能查看设备，无法互传文件', 'error', 9000);
  }
  if (!window.hashwasm?.createMD5) {
    showToast('MD5 模块加载失败，文件校验将不可用', 'error', 9000);
  }

  initUi();
  renderClients();
  renderCustom();
  connectWS();
  loadLan(false);

  setInterval(sampleSpeeds, 500);
  setInterval(() => loadLan(false), 30_000);
}

boot();