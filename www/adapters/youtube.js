import { BaseAdapter, STATUS } from './base.js';
import { parseYouTubeInput } from '../store.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const COOKIE = 'SOCS=CAI';
const MIN_WAIT_MS = 3000;
const MAX_WAIT_MS = 15000;
const ERROR_WAIT_MS = 15000;
const FIRST_BATCH_GRACE_MS = 5 * 60 * 1000;

// En navegador (GitHub Pages / serve) YouTube bloquea las llamadas cruzadas
// (403 con Origin externo, sin CORS), asi que la web lee el chat por scraping
// del popout del chat pasandolo por proxies GET con CORS. La APK llama a
// InnerTube directo (CapacitorHttp), sin nada.
const IS_BROWSER =
  typeof window !== 'undefined' && typeof document !== 'undefined' && !window.Capacitor?.isNativePlatform?.();

function runsText(x) {
  if (!x) return '';
  if (Array.isArray(x.runs)) return x.runs.map((r) => r.text ?? r.emoji?.emojiId ?? '').join('');
  return x.simpleText || x.content || '';
}

function badgesFrom(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const b of list) {
    const s = JSON.stringify(b);
    let name = null;
    if (/MODERATOR|Moderator/.test(s)) name = 'MOD';
    else if (/OWNER|Broadcaster/.test(s)) name = 'STRIM';
    else if (/"style":"MEMBER"|Member for|Subscriber|MEMBER/.test(s)) name = 'SUB';
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// El popout del chat (live_chat?is_popout=1) trae los mensajes recientes en
// window["ytInitialData"] dentro del HTML. Extraemos ese objeto JSON.
function extractInitialData(html) {
  const i = html.indexOf('window["ytInitialData"] = ');
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const CHAT_RENDERERS = [
  'liveChatTextMessageRenderer',
  'liveChatPaidMessageRenderer',
  'liveChatMembershipItemRenderer',
  'giftMessageViewModel',
];

function collectChat(data) {
  const list = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of CHAT_RENDERERS) {
      if (o[k] && typeof o[k] === 'object') list.push({ [k]: o[k] });
    }
    for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
  })(data);
  return list;
}

// Proxies GET con CORS para que el navegador pueda leer el HTML del popout.
// Se prueban en orden y se rotan al fallar; todos reciben el Origin del sitio.
const SCRAPE_PROXIES = [
  (u) => ({ url: 'https://r.jina.ai/' + u, headers: { 'x-return-format': 'html', 'x-no-cache': 'true' } }),
  (u) => ({ url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u), headers: {} }),
  (u) => ({ url: 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u), headers: {} }),
];

export class YouTubeAdapter extends BaseAdapter {
  constructor() {
    super('youtube');
    this._timer = null;
    this._wakeup = null;
    this._parsed = null;
    this._mode = 'innertube';
    this._key = null;
    this._ver = null;
    this._visitor = null;
    this._videoId = null;
    this._chatId = null;
    this._pageToken = null;
    this._continuation = null;
    this._seen = new Set();
    this._startedAt = 0;
    this._warmed = false;
    this._proxyIdx = 0;
  }

  _connect() {
    const input = String(this.config?.input || '').trim();
    const apiKey = String(this.config?.apiKey || '').trim();
    if (!input) {
      this._setStatus(STATUS.OFF);
      return;
    }
    this._parsed = parseYouTubeInput(input);
    if (!this._parsed) {
      this._fail('Enlace de YouTube no reconocido');
      return;
    }
    const force = String(this.config?.mode || '').trim();
    this._mode = apiKey
      ? 'official'
      : force === 'scrape' || (IS_BROWSER && force !== 'innertube')
        ? 'scrape'
        : 'innertube';
    if (this._mode === 'scrape' && this._parsed.kind === 'channel') {
      this._fail('En la web, pega el enlace del directo (@canal necesita API key o la APK)');
      return;
    }
    this._videoId = this._parsed.kind === 'video' ? this._parsed.value : null;
    this._chatId = null;
    this._pageToken = null;
    this._continuation = null;
    this._seen = new Set();
    this._warmed = false;
    this._proxyIdx = 0;
    this._startedAt = Date.now();
    this._setStatus(STATUS.CONNECTING);
    this._loop();
  }

  // ---------- HTTP ----------

  async _fetchText(url) {
    const res = await fetch(url, { headers: { 'user-agent': UA, cookie: COOKIE } });
    if (!res.ok) throw new Error('YouTube: HTTP ' + res.status);
    return { text: await res.text(), url: res.url };
  }

  async _loadInnertubeCfg() {
    if (this._key) return;
    const { text } = await this._fetchText('https://www.youtube.com/');
    const key = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    const ver = text.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1];
    if (!key || !ver) throw new Error('No pude inicializar YouTube (¿página de consentimiento?)');
    this._key = key;
    this._ver = ver;
  }

  async _ytPost(path, body) {
    await this._loadInnertubeCfg();
    const headers = {
      'content-type': 'application/json',
      'user-agent': UA,
      cookie: COOKIE,
    };
    if (this._visitor) headers['x-goog-visitor-id'] = this._visitor;
    const res = await fetch(`https://www.youtube.com/youtubei/v1/${path}?key=${this._key}&prettyPrint=false`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: this._ver, hl: 'en', gl: 'US' } },
        ...body,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('YouTube innertube: HTTP ' + res.status);
    const json = JSON.parse(text);
    const visitor = json?.responseContext?.visitorData;
    if (visitor) this._visitor = visitor;
    return json;
  }

  // ---------- resolucion video/canal ----------

  _chatBar(nj) {
    return nj?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer || null;
  }

  _continuationOf(container) {
    const c = container?.continuations?.[0] || {};
    return (
      c.reloadContinuationData?.continuation ||
      c.timedContinuationData?.continuation ||
      c.invalidationContinuationData?.continuation ||
      null
    );
  }

  _videoInfo(nj) {
    const contents = nj?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    for (const c of contents) if (c.videoPrimaryInfoRenderer) return c.videoPrimaryInfoRenderer;
    return null;
  }

  _isLiveFlag(nj) {
    const flag = this._videoInfo(nj)?.viewCount?.videoViewCountRenderer?.isLive;
    return typeof flag === 'boolean' ? flag : null;
  }

  async _resolveVideoId() {
    if (this._parsed.kind === 'video') return this._parsed.value;
    let path = this._parsed.value;
    if (!/\/live$/.test(path)) path += '/live';
    const { text } = await this._fetchText('https://www.youtube.com' + path);
    if (!text.includes('"isLive":true')) throw new Error('Ese canal no tiene stream en vivo');
    const ids = [...new Set([...text.matchAll(/"videoId":"([\w-]{11})"/g)].map((m) => m[1]))].slice(0, 8);
    let sawLiveNoChat = false;
    for (const id of ids) {
      const nj = await this._ytPost('next', { videoId: id });
      if (this._isLiveFlag(nj) === true && !this._chatBar(nj)) {
        sawLiveNoChat = true;
        continue;
      }
      if (this._chatBar(nj) && this._isLiveFlag(nj) !== false) return id;
    }
    if (sawLiveNoChat) throw new Error('El canal está en vivo pero con el chat desactivado');
    throw new Error('Ese canal no tiene stream en vivo');
  }

  // ---------- modo oficial (API key) ----------

  async _officialApi(resource, params) {
    const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', this.config.apiKey);
    let res;
    try {
      res = await fetch(url.toString());
    } catch (err) {
      throw new Error('YouTube sin conexión: ' + String(err.message || err));
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const reason = body?.error?.errors?.[0]?.reason || '';
      if (res.status === 403 && reason === 'quotaExceeded') throw new Error('Cuota diaria de YouTube agotada');
      if (res.status === 403) throw new Error('API key inválida o API no habilitada (403)');
      if (res.status === 404) throw new Error('Video no encontrado (404)');
      throw new Error('YouTube: HTTP ' + res.status);
    }
    return res.json();
  }

  async _officialResolveChatId() {
    const data = await this._officialApi('videos', { part: 'liveStreamingDetails', id: this._videoId });
    const chatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) throw new Error('Ese video no tiene chat activo (¿está en vivo?)');
    return chatId;
  }

  // Canal -> directo activo con la API oficial (sin InnerTube): ~3 unidades.
  async _officialResolveChannel() {
    const path = this._parsed.value;
    let params = null;
    if (path.startsWith('/channel/')) params = { id: path.slice('/channel/'.length) };
    else if (path.startsWith('/@')) params = { forHandle: path.slice(1) };
    else if (path.startsWith('/user/')) params = { forUsername: path.slice('/user/'.length) };
    else throw new Error('Con API key usa @handle o la URL del directo (no /c/)');

    const ch = await this._officialApi('channels', { part: 'snippet,contentDetails', ...params });
    const channel = ch.items?.[0];
    if (!channel) throw new Error('No encontré ese canal en YouTube');
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new Error('Ese canal no tiene videos');

    const pl = await this._officialApi('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '5' });
    const ids = (pl.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) throw new Error('Ese canal no tiene stream en vivo');

    const vids = await this._officialApi('videos', { part: 'liveStreamingDetails', id: ids.join(',') });
    const live = (vids.items || []).find((v) => v.liveStreamingDetails?.activeLiveChatId);
    if (live) {
      this._videoId = live.id;
      this._chatId = live.liveStreamingDetails.activeLiveChatId;
      return;
    }
    if ((vids.items || []).some((v) => v.liveStreamingDetails?.actualStartTime && !v.liveStreamingDetails?.actualEndTime)) {
      throw new Error('El canal está en vivo pero con el chat desactivado');
    }
    throw new Error('Ese canal no tiene stream en vivo');
  }

  _officialEmit(items) {
    for (const item of items) {
      if (this._seen.has(item.id)) continue;
      this._seen.add(item.id);
      const published = Date.parse(item.snippet.publishedAt) || Date.now();
      if (published < this._startedAt) continue;
      const author = item.authorDetails;
      const badges = [];
      if (author.isChatOwner) badges.push('STRIM');
      if (author.isChatModerator) badges.push('MOD');
      if (author.isChatSponsor) badges.push('SUB');
      const text = item.snippet.displayMessage || '';
      if (!text) continue;
      this._emit(
        'message',
        this._msg({
          user: author.displayName || author.channelName || '?',
          color: null,
          badges,
          text,
          id: item.id,
          ts: published,
          kind: item.snippet.type === 'memberMilestoneMessage' ? 'system' : 'chat',
        }),
      );
    }
  }

  async _officialPoll() {
    if (!this._chatId) this._chatId = await this._officialResolveChatId();
    const params = { part: 'snippet,authorDetails', liveChatId: this._chatId, maxResults: '200' };
    if (this._pageToken) params.pageToken = this._pageToken;
    const data = await this._officialApi('liveChatMessages', params);
    this._connected();
    this._officialEmit(data.items || []);
    this._pageToken = data.nextPageToken || null;
    return Math.min(Math.max(Number(data.pollingIntervalMillis) || 5000, 5000), MAX_WAIT_MS);
  }

  // ---------- modo web sin clave (scraping del popout del chat) ----------

  async _scrapeRaw(url) {
    let lastErr = null;
    for (let i = 0; i < SCRAPE_PROXIES.length; i++) {
      const idx = (this._proxyIdx + i) % SCRAPE_PROXIES.length;
      const { url: proxyUrl, headers } = SCRAPE_PROXIES[idx](url);
      try {
        const h = { ...headers, referer: 'https://eduardr10.github.io/' };
        if (!IS_BROWSER) h['user-agent'] = UA;
        const res = await fetch(proxyUrl, { headers: h });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (!text.includes('ytInitialData')) throw new Error('respuesta sin datos de YouTube');
        this._proxyIdx = idx;
        return text;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error('No pude leer el chat (' + String(lastErr?.message || lastErr) + ')');
  }

  async _scrapePoll() {
    if (!this._videoId) throw new Error('En la web, pega el enlace del directo');
    const url = `https://www.youtube.com/live_chat?is_popout=1&v=${this._videoId}`;
    const html = await this._scrapeRaw(url);
    const data = extractInitialData(html);
    if (!data) throw new Error('YouTube cambió la estructura de la página del chat');
    const list = collectChat(data);
    if (!list.length && !html.includes('liveChatRenderer')) throw new Error('Ese video no tiene chat activo');
    this._connected();
    if (list.length) {
      this._innertubeEmit({
        continuationContents: {
          liveChatContinuation: {
            actions: list.map((item) => ({ addChatItemAction: { item } })),
          },
        },
      });
    }
    return 4000 + Math.floor(Math.random() * 1500);
  }

  // ---------- modo sin clave (InnerTube) ----------

  async _innertubePoll() {
    if (!this._continuation) {
      const nj = await this._ytPost('next', { videoId: this._videoId });
      const bar = this._chatBar(nj);
      const flag = this._isLiveFlag(nj);
      if (!bar) {
        if (flag === true) throw new Error('Ese directo tiene el chat desactivado');
        throw new Error('Ese video no está en vivo o no tiene chat');
      }
      if (flag === false) throw new Error('Ese video no está en vivo (parece una grabación)');
      this._continuation = this._continuationOf(bar);
      if (!this._continuation) throw new Error('No pude obtener el chat de YouTube');
    }
    const cj = await this._ytPost('live_chat/get_live_chat', { continuation: this._continuation });
    this._connected();
    this._innertubeEmit(cj);
    const cont = cj?.continuationContents?.liveChatContinuation;
    this._continuation = this._continuationOf(cont);
    if (!this._continuation) throw new Error('El chat de YouTube terminó');
    const timing = cont?.continuations?.[0] || {};
    const timeout =
      Number(
        timing.timedContinuationData?.timeoutMs ??
          timing.invalidationContinuationData?.timeoutMs ??
          timing.reloadContinuationData?.timeoutMs,
      ) || 5000;
    return Math.min(Math.max(timeout, MIN_WAIT_MS), MAX_WAIT_MS);
  }

  _innertubeEmit(cj) {
    const actions = cj?.continuationContents?.liveChatContinuation?.actions || [];
    for (const a of actions) {
      const aKey = Object.keys(a).find((k) => k !== 'clickTrackingParams');
      if (aKey !== 'addChatItemAction') continue;
      const item = a[aKey]?.item;
      if (!item) continue;
      const rKey = Object.keys(item)[0];
      const r = item[rKey];

      if (rKey === 'liveChatTextMessageRenderer') {
        const text = runsText(r.message);
        const id = r.id || null;
        if (!text || (id && this._seen.has(id))) continue;
        if (id) this._seen.add(id);
        const ts = Number(r.timestampUsec) / 1000 || Date.now();
        if (!this._warmed && ts < this._startedAt - FIRST_BATCH_GRACE_MS) continue;
        this._emit(
          'message',
          this._msg({ user: runsText(r.authorName) || '?', color: null, badges: badgesFrom(r.authorBadges), text, id, ts }),
        );
      } else if (rKey === 'giftMessageViewModel') {
        const id = r.id || null;
        if (id && this._seen.has(id)) continue;
        if (id) this._seen.add(id);
        const text = runsText(r.text);
        const user = runsText(r.authorName);
        const ts = Number(r.timestampUsec) / 1000 || Date.now();
        if (text) this._emit('message', this._msg({ user, color: null, badges: [], text, id, ts }));
      } else if (rKey === 'liveChatPaidMessageRenderer') {
        const id = r.id || null;
        if (id && this._seen.has(id)) continue;
        if (id) this._seen.add(id);
        const amount = runsText(r.purchaseAmount);
        const text = [amount && `[${amount}]`, runsText(r.message)].filter(Boolean).join(' ');
        const ts = Number(r.timestampUsec) / 1000 || Date.now();
        if (text) this._emit('message', this._msg({ user: runsText(r.authorName) || '?', badges: ['SUB'], text, id, ts }));
      } else if (rKey === 'liveChatMembershipItemRenderer') {
        const text = runsText(r.message) || `${runsText(r.authorName)} es miembro`;
        const id = r.id || null;
        const ts = Number(r.timestampUsec) / 1000 || Date.now();
        this._emit('message', this._msg({ user: '', text, kind: 'system', id, ts }));
      }
    }
    if (actions.length) this._warmed = true;
  }

  // ---------- bucle ----------

  async _loop() {
    while (!this.stopped) {
      try {
        if (this._mode === 'innertube') {
          await this._loadInnertubeCfg();
          if (!this._videoId) this._videoId = await this._resolveVideoId();
        } else if (this._mode === 'official' && this._parsed.kind === 'channel' && !this._chatId) {
          if (this._parsed.value.startsWith('/c/')) {
            if (IS_BROWSER) throw new Error('Con API key en la web usa @handle o la URL del directo (no /c/)');
            await this._loadInnertubeCfg();
            if (!this._videoId) this._videoId = await this._resolveVideoId();
          } else {
            await this._officialResolveChannel();
          }
        }
        const wait =
          this._mode === 'official'
            ? await this._officialPoll()
            : this._mode === 'scrape'
              ? await this._scrapePoll()
              : await this._innertubePoll();
        await this._sleep(wait);
      } catch (err) {
        if (this.stopped) return;
        this._emit('error', String(err.message || err));
        this._setStatus(STATUS.ERROR);
        this._continuation = null;
        this._chatId = null;
        this._pageToken = null;
        this._warmed = false;
        if (this._parsed?.kind === 'channel') this._videoId = null;
        await this._sleep(ERROR_WAIT_MS);
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._wakeup = resolve;
      this._timer = setTimeout(() => {
        this._timer = null;
        this._wakeup = null;
        resolve();
      }, ms);
    });
  }

  _disconnect() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._wakeup) {
      const resolve = this._wakeup;
      this._wakeup = null;
      resolve();
    }
  }

  // Al volver a primer plano: no esperar al temporizador y refrescar la
  // posición del chat (el token de continuación puede haber caducado).
  resume() {
    if (this.stopped) return;
    this._continuation = null;
    this._pageToken = null;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._wakeup) {
      const resolve = this._wakeup;
      this._wakeup = null;
      resolve();
    }
  }
}
