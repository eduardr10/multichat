import { BaseAdapter, STATUS } from './base.js';

const PUSHER_URL =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
const INACTIVITY_MS = 90000;

const KICK_BADGES = {
  moderator: 'MOD',
  subscriber: 'SUB',
  broadcaster: 'STRIM',
  vip: 'VIP',
};

function kickBadges(badges) {
  const out = [];
  if (Array.isArray(badges)) {
    for (const b of badges) {
      const name = KICK_BADGES[String(b?.type || '').toLowerCase()];
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

export class KickAdapter extends BaseAdapter {
  constructor() {
    super('kick');
    this.ws = null;
    this._watchdog = null;
    this._activity = 0;
  }

  async _connect() {
    const channel = String(this.config?.channel || '')
      .trim()
      .replace(/^\//, '')
      .split('/')[0];
    if (!channel) {
      this._setStatus(STATUS.OFF);
      return;
    }
    this._setStatus(STATUS.CONNECTING);
    try {
      const chatroomId = await this._fetchChatroomId(channel);
      if (this.stopped) return;
      this._openSocket(chatroomId);
    } catch (err) {
      this._fail(String(err.message || err));
      this._retryLater();
    }
  }

  async _fetchChatroomId(slug) {
    const res = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), {
      headers: {
        accept: 'application/json',
        referer: 'https://kick.com/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      },
    });
    if (res.status === 403) throw new Error('Kick bloqueó la petición (Cloudflare), reintenta');
    if (res.status === 404) throw new Error('Canal de Kick no encontrado: ' + slug);
    if (!res.ok) throw new Error('Kick: HTTP ' + res.status);
    const data = await res.json();
    const id = data?.chatroom?.id;
    if (typeof id !== 'number') throw new Error('Respuesta inesperada de Kick (¿challenge de Cloudflare?)');
    return id;
  }

  _openSocket(chatroomId) {
    let ws;
    try {
      ws = new WebSocket(PUSHER_URL);
    } catch (err) {
      this._fail(String(err));
      this._retryLater();
      return;
    }
    this.ws = ws;
    this._activity = Date.now();
    this._startWatchdog();
    ws.onopen = () => {
      this._activity = Date.now();
      ws.send(
        JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }),
      );
    };
    ws.onmessage = (ev) => {
      this._activity = Date.now();
      this._handleFrame(String(ev.data));
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.ws = null;
      this._stopWatchdog();
      if (this.stopped) return;
      this._retryLater();
    };
  }

  _handleFrame(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.event === 'pusher:ping') {
      try {
        this.ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      } catch {}
      return;
    }
    if (frame.event === 'pusher_internal:subscription_succeeded') {
      this._connected();
      return;
    }
    if (!frame.event || typeof frame.data !== 'string') return;
    let data;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return;
    }

    switch (frame.event) {
      case 'App\\Events\\ChatMessageEvent': {
        const sender = data.sender || {};
        this._emit(
          'message',
          this._msg({
            user: sender.username || '?',
            color: sender.identity?.color || null,
            badges: kickBadges(sender.identity?.badges),
            text: String(data.content || ''),
            id: data.id || null,
            ts: data.created_at ? Date.parse(data.created_at) || Date.now() : Date.now(),
          }),
        );
        break;
      }
      case 'App\\Events\\SubscriptionEvent': {
        const months = data.months > 1 ? ` (${data.months} meses)` : '';
        this._emit('message', this._msg({ user: '', text: `${data.username || '?'} se suscribió${months}`, kind: 'system' }));
        break;
      }
      case 'App\\Events\\GiftedSubscriptionsEvent': {
        const n = Array.isArray(data.gifted_usernames) ? data.gifted_usernames.length : 0;
        this._emit('message', this._msg({ user: '', text: `${data.gifter_username || '?'} regaló ${n} sub(s)`, kind: 'system' }));
        break;
      }
      case 'App\\Events\\StreamHostEvent': {
        this._emit('message', this._msg({ user: '', text: `${data.host_username || '?'} nos trae ${data.number_viewers || 0} espectadores`, kind: 'system' }));
        break;
      }
      default:
        break;
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      if (this.stopped || !this.ws) return;
      if (Date.now() - this._activity > INACTIVITY_MS) {
        try {
          this.ws.close();
        } catch {}
      }
    }, 5000);
  }

  _stopWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  _disconnect() {
    this._stopWatchdog();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
  }
}
