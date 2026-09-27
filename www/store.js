const KEY = 'multichat.config.v1';

export function defaultConfig() {
  return { twitchChannel: '', youtubeUrl: '', youtubeApiKey: '', kickChannel: '' };
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultConfig();
    return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config) {
  localStorage.setItem(KEY, JSON.stringify(config));
}

// Historial: los últimos 5 minutos de mensajes se guardan en localStorage
// para verlos al reabrir la app (se recortan al cargar y al guardar).
const MSG_KEY = 'multichat.messages.v1';
export const HISTORY_MS = 5 * 60 * 1000;

export function loadRecentMessages(now = Date.now()) {
  try {
    const arr = JSON.parse(localStorage.getItem(MSG_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter((m) => m && typeof m.ts === 'number' && m.ts >= now - HISTORY_MS);
  } catch {
    return [];
  }
}

export function saveRecentMessages(messages) {
  try {
    const cutoff = Date.now() - HISTORY_MS;
    const arr = messages.filter((m) => m.ts >= cutoff).slice(-300);
    localStorage.setItem(MSG_KEY, JSON.stringify(arr));
  } catch {
    /* almacenamiento lleno o no disponible: se ignora */
  }
}

export function parseYouTubeInput(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;

  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return { kind: 'video', value: v };

  let path = null;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!/(^|\.)youtube\.com$/i.test(u.hostname) && !/(^|\.)youtu\.be$/i.test(u.hostname)) return null;
      if (/(^|\.)youtu\.be$/i.test(u.hostname)) {
        const id = u.pathname.slice(1, 12);
        if (/^[A-Za-z0-9_-]{11}$/.test(id)) return { kind: 'video', value: id };
      }
      const vid = u.searchParams.get('v');
      if (vid && /^[A-Za-z0-9_-]{11}$/.test(vid)) return { kind: 'video', value: vid };
      path = u.pathname;
      const m = path.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return { kind: 'video', value: m[1] };
    } catch {
      return null;
    }
  } else {
    v = v.replace(/^(?:www\.)?youtube\.com\//i, '');
    path = v.startsWith('/') ? v : '/' + v;
  }

  path = path.replace(/\/live\/?$/, '');
  if (/^\/(?:@[\w.\-]+|channel\/UC[\w-]{22}|c\/[\w.\-]+|user\/[\w.\-]+)\/?$/.test(path)) {
    return { kind: 'channel', value: path };
  }
  return null;
}
