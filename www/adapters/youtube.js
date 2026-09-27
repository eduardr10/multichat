import { BaseAdapter, STATUS } from './base.js';
import { parseYouTubeInput } from '../store.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const COOKIE = 'SOCS=CAI';
const MIN_WAIT_MS = 3000;
const MAX_WAIT_MS = 15000;
const ERROR_WAIT_MS = 15000;
const FIRST_BATCH_GRACE_MS = 5 * 60 * 1000;
const EMBED_REFRESH_MS = 120000;
const PIPED_API = 'https://api.piped.private.coffee';
// Instancias con CORS (ACAO *) probadas hoy: buscan directos por nombre/canal.
const INVIDIOUS = [
  'https://invidious.f5.si',
  'https://iv.ggtyler.dev',
  'https://invidious.jing.rocks',
  'https://yt.artemislena.eu',
  'https://invidious.privacyredirect.com',
];

// En navegador (GitHub Pages / serve) sin plataforma nativa, InnerTube devuelve
// 403 con Origin externo y sin cabeceras CORS: el modo sin clave en la web es
// el chat embebido oficial (panel iframe); la APK usa InnerTube directo.
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
    this._mode = apiKey ? 'official' : IS_BROWSER ? 'embed' : 'innertube';
    this._videoId = this._parsed.kind === 'video' ? this._parsed.value : null;
    this._chatId = null;
    this._pageToken = null;
    this._continuation = null;
    this._seen = new Set();
    this._warmed = false;
    this._startedAt = Date.now();
    this._setStatus(STATUS.CONNECTING);
    if (this._mode === 'embed') this._embedLoop();
    else this._loop();
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

  // ---------- modo embebido (web sin clave) ----------

  async _embedGet(url) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error('Sin conexión con ' + new URL(url).hostname + ': ' + String(err.message || err));
    }
    if (!res.ok) throw new Error(new URL(url).hostname + ': HTTP ' + res.status + ' (reintento)');
    return res;
  }

  async _embedPiped(path) {
    const res = await this._embedGet(PIPED_API + path);
    try {
      return await res.json();
    } catch {
      throw new Error('Respuesta inválida del proxy (reintento)');
    }
  }

  async _embedInvidious(path) {
    let lastErr = null;
    for (const base of INVIDIOUS) {
      try {
        const res = await this._embedGet(base + path);
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Invidious no responde (reintento)');
  }

  // Los directos de Piped aparecen con duration/uploaded = -1 (los VOD con datos).
  _isLiveItem(item) {
    return !!item && (item.duration === -1 || item.uploaded === -1);
  }

  _idFromWatchUrl(url) {
    const m = /[?&]v=([\w-]{11})/.exec(url || '');
    return m ? m[1] : null;
  }

  _findLiveId(items) {
    for (const item of items || []) {
      const id = this._idFromWatchUrl(item?.url);
      if (id && this._isLiveItem(item)) return id;
    }
    return null;
  }

  async _embedChannelTarget() {
    const path = this._parsed.value;
    if (path.startsWith('/channel/')) {
      const uc = path.slice('/channel/'.length);
      const cj = await this._embedPiped('/channel/' + uc);
      if (!cj?.name) throw new Error('No pude leer ese canal (reintento)');
      return { uc, name: cj.name };
    }
    if (path.startsWith('/@')) {
      const handle = path.slice(2);
      const sj = await this._embedPiped('/search?q=' + encodeURIComponent(handle) + '&filter=channels');
      const items = (sj.items || []).filter((i) => i.type === 'channel' && typeof i.url === 'string' && i.url.includes('/channel/'));
      const pick = items.find((i) => (i.name || '').toLowerCase() === handle.toLowerCase()) || items[0];
      if (!pick) throw new Error('No encontré ese canal en YouTube');
      return { uc: pick.url.slice(pick.url.indexOf('/channel/') + '/channel/'.length), name: pick.name || handle };
    }
    throw new Error('En la web usa @handle o la URL del directo (no /c/ ni /user/)');
  }

  async _embedResolveChannelVideo() {
    const { uc, name } = await this._embedChannelTarget();

    // 1) Invidious: busca directos en vivo del nombre y te quedas con el del canal.
    let invWorked = false;
    try {
      const items = await this._embedInvidious('/api/v1/search?q=' + encodeURIComponent(name) + '&type=video&features=live');
      invWorked = true;
      const hit = (Array.isArray(items) ? items : []).find((i) => i.authorId === uc);
      if (hit?.videoId) return hit.videoId;
    } catch {
      /* instancias caídas: se intenta el respaldo */
    }

    // 2) Respaldo: Piped, videos del canal con marcador de vivo (duration/uploaded -1).
    const sj = await this._embedPiped('/search?q=' + encodeURIComponent(name) + '&filter=videos');
    const scoped = (sj.items || []).filter((i) => typeof i.url === 'string' && (i.uploaderUrl || '').includes(uc));
    const id = this._findLiveId(scoped);
    if (id) return id;
    if (invWorked) throw new Error('Ese canal no tiene stream en vivo');
    if (scoped.length) throw new Error('No pude confirmar el directo (reintento)');
    throw new Error('No encontré videos de ese canal (reintento)');
  }

  async _embedResolveVideoId() {
    if (this._parsed.kind !== 'video') return this._embedResolveChannelVideo();
    const videoId = this._parsed.value;
    const sj = await this._embedPiped('/search?q=' + encodeURIComponent(videoId) + '&filter=videos');
    const item = (sj.items || []).find((i) => (i.url || '').includes(videoId));
    if (!item) throw new Error('No encontré ese video (reintento)');
    if (!this._isLiveItem(item)) throw new Error('Ese video no está en vivo o no tiene chat');
    return videoId;
  }

  async _embedLoop() {
    while (!this.stopped) {
      try {
        const videoId = await this._embedResolveVideoId();
        if (this.stopped) return;
        this._videoId = videoId;
        this._connected();
        this._emit('embed', videoId);
        await this._sleep(EMBED_REFRESH_MS);
      } catch (err) {
        if (this.stopped) return;
        this._emit('error', String(err.message || err));
        this._setStatus(STATUS.ERROR);
        await this._sleep(ERROR_WAIT_MS);
      }
    }
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
        } else if (this._parsed.kind === 'channel' && !this._chatId) {
          if (this._parsed.value.startsWith('/c/')) {
            if (IS_BROWSER) throw new Error('Con API key en la web usa @handle o la URL del directo (no /c/)');
            await this._loadInnertubeCfg();
            if (!this._videoId) this._videoId = await this._resolveVideoId();
          } else {
            await this._officialResolveChannel();
          }
        }
        const wait =
          this._mode === 'official' ? await this._officialPoll() : await this._innertubePoll();
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
