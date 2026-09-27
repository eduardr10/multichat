import { loadConfig, saveConfig, parseYouTubeInput, loadRecentMessages, saveRecentMessages, HISTORY_MS } from './store.js';
import { TwitchAdapter } from './adapters/twitch.js';
import { YouTubeAdapter } from './adapters/youtube.js';
import { KickAdapter } from './adapters/kick.js';

const PLATFORM_LABEL = { twitch: 'TW', youtube: 'YT', kick: 'KI' };
const PLATFORM_CLASS = { twitch: 'tw', youtube: 'yt', kick: 'ki' };
const PLATFORM_NAME = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
const MAX_MESSAGES = 500;

const chatEl = document.getElementById('chat');
const jumpEl = document.getElementById('jump');
const overlayEl = document.getElementById('overlay');
const settingsError = document.getElementById('settings-error');
const inputTwitch = document.getElementById('inp-twitch');
const inputYoutube = document.getElementById('inp-youtube');
const inputKey = document.getElementById('inp-key');
const inputRelay = document.getElementById('inp-relay');
const inputKick = document.getElementById('inp-kick');

const config = loadConfig();

// Versión web (GitHub Pages / npm run serve): YouTube bloquea las llamadas
// cruzadas (403 + sin CORS); hace falta relay propio o API key para mezclarlo.
if (typeof window !== 'undefined' && !window.Capacitor?.isNativePlatform?.()) {
  const ytHint = document.getElementById('yt-hint');
  if (ytHint) {
    ytHint.textContent =
      'Version web: Twitch y Kick sin clave. YouTube se mezcla en la lista con un relay propio (ver abajo) o con API key. Guia en docs/SETUP.md';
  }
}

const adapters = {
  twitch: new TwitchAdapter(),
  youtube: new YouTubeAdapter(),
  kick: new KickAdapter(),
};

let stickToBottom = true;
let pending = 0;
const lastErrorAt = { twitch: 0, youtube: 0, kick: 0 };

// Últimos 5 minutos de chat (en memoria + persistidos) para verlos al reabrir.
const recent = [];
let recentDirty = false;

// Deduplicación: al reabrir la app (o al reiniciar conectores) el historial y el
// primer backlog de YouTube/Kick se solapan -> mismos mensajes dos veces.
const seenIds = new Set();
const seenOrder = [];
const softSeen = []; // sin id (mensajes antiguos o eventos): firma + timestamp

function msgIdKey(m) {
  return `${m.platform}#${m.id}`;
}
function msgSig(m) {
  return `${m.platform}|${m.user}|${m.text}`;
}
function isDuplicate(m) {
  if (m.id && seenIds.has(msgIdKey(m))) return true;
  const sig = msgSig(m);
  const ts = m.ts || 0;
  return softSeen.some((s) => s.sig === sig && Math.abs(s.ts - ts) < 2000);
}
function markSeen(m) {
  if (m.id) {
    seenIds.add(msgIdKey(m));
    seenOrder.push(msgIdKey(m));
    if (seenOrder.length > 4000) {
      for (const k of seenOrder.splice(0, 1000)) seenIds.delete(k);
    }
  } else {
    softSeen.push({ sig: msgSig(m), ts: m.ts || 0 });
    if (softSeen.length > 500) softSeen.splice(0, 100);
  }
}

function pruneRecent() {
  const cutoff = Date.now() - HISTORY_MS;
  while (recent.length && recent[0].ts < cutoff) recent.shift();
}

function remember(msg) {
  if (msg.kind === 'system') return;
  recent.push({ platform: msg.platform, kind: msg.kind, user: msg.user, color: msg.color, badges: msg.badges, text: msg.text, id: msg.id || null, ts: msg.ts || Date.now() });
  pruneRecent();
  recentDirty = true;
}

function setStatus(platform, status) {
  const pill = document.querySelector(`.pill[data-platform="${platform}"]`);
  if (pill) pill.dataset.status = status;
}

function startAll() {
  adapters.twitch.start(config.twitchChannel.trim() ? { channel: config.twitchChannel } : null);
  const youtubeInput = config.youtubeUrl.trim();
  const apiKey = config.youtubeApiKey.trim();
  const relay = config.youtubeRelay.trim();
  adapters.youtube.start(youtubeInput ? { input: youtubeInput, apiKey, relay } : null);
  adapters.kick.start(config.kickChannel.trim() ? { channel: config.kickChannel } : null);
}

function timeStr(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function appendMessage(msg, opts = {}) {
  if (isDuplicate(msg)) {
    markSeen(msg);
    return;
  }
  markSeen(msg);
  if (opts.history) recent.push(msg);
  else remember(msg);

  const el = document.createElement('div');
  el.className = 'msg' + (msg.kind === 'system' ? ' system' : '');

  if (msg.kind !== 'system') {
    const plat = document.createElement('span');
    plat.className = 'badge plat-' + PLATFORM_CLASS[msg.platform];
    plat.textContent = PLATFORM_LABEL[msg.platform];
    el.appendChild(plat);

    for (const badge of msg.badges || []) {
      const b = document.createElement('span');
      b.className = 'badge b-' + badge;
      b.textContent = badge;
      el.appendChild(b);
    }

    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = msg.user;
    if (msg.color) user.style.color = msg.color;
    el.appendChild(user);
  }

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = msg.text;
  el.appendChild(text);

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeStr(msg.ts || Date.now());
  el.appendChild(time);

  chatEl.appendChild(el);
  while (chatEl.children.length > MAX_MESSAGES) chatEl.removeChild(chatEl.firstChild);

  if (stickToBottom) {
    chatEl.scrollTop = chatEl.scrollHeight;
  } else {
    pending += 1;
    jumpEl.hidden = false;
    jumpEl.textContent = pending + ' nuevos';
  }
}

function reportError(platform, error) {
  const now = Date.now();
  if (now - lastErrorAt[platform] < 5000) return;
  lastErrorAt[platform] = now;
  appendMessage({ platform, kind: 'system', text: `${PLATFORM_NAME[platform]}: ${error}`, ts: now });
}

chatEl.addEventListener('scroll', () => {
  stickToBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
  if (stickToBottom) {
    pending = 0;
    jumpEl.hidden = true;
  }
});

jumpEl.addEventListener('click', () => {
  stickToBottom = true;
  pending = 0;
  jumpEl.hidden = true;
  chatEl.scrollTop = chatEl.scrollHeight;
});

function openSettings() {
  inputTwitch.value = config.twitchChannel;
  inputYoutube.value = config.youtubeUrl;
  inputKey.value = config.youtubeApiKey;
  inputRelay.value = config.youtubeRelay;
  inputKick.value = config.kickChannel;
  settingsError.hidden = true;
  overlayEl.hidden = false;
}

function closeSettings() {
  overlayEl.hidden = true;
}

function saveSettings() {
  const youtubeUrl = inputYoutube.value.trim();
  if (youtubeUrl && !parseYouTubeInput(youtubeUrl)) {
    settingsError.textContent = 'Ese enlace/canal de YouTube no se reconoce (prueba con @canal o la URL del stream)';
    settingsError.hidden = false;
    return;
  }
  const youtubeRelay = inputRelay.value.trim();
  if (youtubeRelay && !/^https?:\/\/.+/i.test(youtubeRelay)) {
    settingsError.textContent = 'El relay debe ser una URL tipo https://tu-relay.workers.dev (o déjalo vacío)';
    settingsError.hidden = false;
    return;
  }
  config.twitchChannel = inputTwitch.value.trim();
  config.youtubeUrl = youtubeUrl;
  config.youtubeApiKey = inputKey.value.trim();
  config.youtubeRelay = youtubeRelay.replace(/\/+$/, '');
  config.kickChannel = inputKick.value.trim();
  saveConfig(config);
  closeSettings();
  startAll();
}

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-cancel').addEventListener('click', closeSettings);
document.getElementById('btn-save').addEventListener('click', saveSettings);

for (const [platform, adapter] of Object.entries(adapters)) {
  adapter.on('status', (status) => setStatus(platform, status));
  adapter.on('message', appendMessage);
  adapter.on('error', (error) => reportError(platform, error));
}

for (const m of loadRecentMessages()) appendMessage(m, { history: true });

setInterval(() => {
  if (recentDirty) {
    recentDirty = false;
    saveRecentMessages(recent);
  }
}, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveRecentMessages(recent);
});
window.addEventListener('pagehide', () => saveRecentMessages(recent));

// Mantener la pantalla encendida mientras se usa la app (Wake Lock API).
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    /* no soportado o permiso denegado */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    acquireWakeLock();
    for (const adapter of Object.values(adapters)) adapter.resume();
  }
});
document.addEventListener('pointerdown', acquireWakeLock, { once: true });
acquireWakeLock();

startAll();

if (!config.twitchChannel && !config.youtubeUrl && !config.kickChannel) {
  openSettings();
}
