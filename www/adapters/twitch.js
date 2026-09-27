import { BaseAdapter, STATUS } from './base.js';

function parseTags(raw) {
  const tags = {};
  if (!raw) return tags;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) tags[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return tags;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

const BADGE_NAMES = {
  broadcaster: 'STRIM',
  moderator: 'MOD',
  subscriber: 'SUB',
  vip: 'VIP',
  founder: 'VIP',
  staff: 'STAFF',
  admin: 'STAFF',
  global_mod: 'MOD',
};

function badgesFromTags(tags) {
  const out = [];
  const raw = tags.badges || '';
  for (const part of raw.split(',')) {
    const type = part.split('/')[0];
    const name = BADGE_NAMES[type];
    if (name && !out.includes(name)) out.push(name);
  }
  if (tags.mod === '1' && !out.includes('MOD')) out.unshift('MOD');
  if (tags['user-type'] === 'mod' && !out.includes('MOD')) out.unshift('MOD');
  return out;
}

export class TwitchAdapter extends BaseAdapter {
  constructor() {
    super('twitch');
    this.ws = null;
  }

  _connect() {
    const channel = String(this.config?.channel || '')
      .trim()
      .toLowerCase()
      .replace(/^#/, '')
      .replace(/^.*\//, '');
    if (!channel) {
      this._setStatus(STATUS.OFF);
      return;
    }
    this._setStatus(STATUS.CONNECTING);
    let ws;
    try {
      ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    } catch (err) {
      this._fail(String(err));
      this._retryLater();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 89999));
      ws.send('JOIN #' + channel);
    };
    ws.onmessage = (ev) => this._handleFrame(String(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      this.ws = null;
      if (this.stopped) return;
      this._retryLater();
    };
  }

  _handleFrame(frame) {
    for (const raw of frame.split('\r\n')) {
      if (!raw) continue;
      if (raw.startsWith('PING')) {
        try {
          this.ws?.send('PONG :tmi.twitch.tv');
        } catch {}
        continue;
      }
      if (raw.includes(' 001 ')) {
        this._connected();
        continue;
      }

      const notice = raw.match(/^(?:@(\S+) )?:[^ ]+ NOTICE #\S+ :(.*)$/);
      if (notice) {
        this._emit('error', 'Twitch: ' + decodeEntities(notice[2]));
        continue;
      }

      const userNotice = raw.match(/^(?:@(\S+) )?:[^ ]+ USERNOTICE #\S+(?::(.*))?$/);
      if (userNotice) {
        const tags = parseTags(userNotice[1]);
        const text = decodeEntities(tags['system-msg'] || 'Evento de suscripción');
        this._emit('message', this._msg({ user: '', badges: [], text, kind: 'system', ts: Date.now() }));
        continue;
      }

      const privmsg = raw.match(/^(?:@(\S+) )?:([^!]+)!([^ ]+) PRIVMSG #(\S+) :(.*)$/);
      if (!privmsg) continue;
      const tags = parseTags(privmsg[1]);
      const badges = badgesFromTags(tags);
      const user = tags['display-name'] || privmsg[2];
      const color = tags.color && tags.color !== '' ? tags.color : null;
      this._emit(
        'message',
        this._msg({ user: decodeEntities(user), color, badges, text: decodeEntities(privmsg[5]), id: tags.id || null }),
      );
    }
  }

  _disconnect() {
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
