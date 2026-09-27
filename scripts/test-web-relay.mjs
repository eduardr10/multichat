// E2E de la version web: simul navegador (window/document) y levanta un relay
// local con el mismo contrato que relay/worker.js. Comprueba que con relay el
// chat de YouTube llega unificado, y que sin relay ni API key falla con el
// mensaje de ayuda.
import http from 'node:http';

globalThis.window = {};
globalThis.document = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAY = 'http://127.0.0.1:8899';
const VIDEO = process.argv[2] || 'https://www.youtube.com/watch?v=7mhSMVs4y4U';

const SKIP = new Set(['origin', 'referer', 'cookie', 'host', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, RELAY);
  const target = u.searchParams.get('url');
  const acao = { 'access-control-allow-origin': '*' };
  if (!target) {
    res.writeHead(400, acao);
    res.end('no url');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!SKIP.has(k.toLowerCase())) headers[k] = v;
  try {
    const r = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      redirect: 'follow',
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { ...acao, 'content-type': r.headers.get('content-type') || 'text/plain' });
    res.end(buf);
  } catch (err) {
    res.writeHead(502, acao);
    res.end(String(err.message || err));
  }
});
await new Promise((r) => server.listen(8899, '127.0.0.1', r));
console.log('relay local en', RELAY);

const { YouTubeAdapter } = await import('../www/adapters/youtube.js');
const { STATUS } = await import('../www/adapters/base.js');

// 1) sin relay ni API key: debe fallar con la ayuda
{
  const a = new YouTubeAdapter();
  let err = null;
  a.on('error', (e) => (err = e));
  a.start({ input: VIDEO, apiKey: '', relay: '' });
  await sleep(400);
  const ok = a.status === STATUS.ERROR && /relay propio o API key/.test(err || '');
  console.log(ok ? 'OK: sin relay avisa (relay propio o API key)' : `FALLA: status=${a.status} error=${err}`);
  if (!ok) { server.close(); process.exit(1); }
  a.stop();
}

// 2) con relay local: conecta (next + get_live_chat pasan por el relay)
{
  const a = new YouTubeAdapter();
  let messages = 0;
  let lastError = null;
  a.on('status', (s) => console.log('  [web-relay] status:', s));
  a.on('error', (e) => { lastError = e; console.log('  [web-relay] error:', e); });
  a.on('message', (m) => { messages += 1; if (messages <= 3) console.log(`  [web-relay] ${m.user}: ${m.text}`); });
  a.start({ input: VIDEO, apiKey: '', relay: RELAY });

  const deadline = Date.now() + 60000;
  let connected = false;
  while (Date.now() < deadline) {
    if (a.status === STATUS.CONNECTED) connected = true;
    if (connected && messages > 0) break;
    await sleep(300);
  }
  console.log(connected ? `OK: conectado via relay (mensajes en vivo: ${messages}; si es 0 el chat estaba en silencio)` : `FALLA: conectado=false ultimoError=${lastError}`);
  const relayOk = connected;
  a.stop();

  // 3) parseo de mensajes (fixture, sin red): gracia de 5 min + dedupe
  const b = new YouTubeAdapter();
  let emitted = 0;
  b.on('message', () => (emitted += 1));
  b.stopped = false;
  b._startedAt = Date.now() - 60000;
  b._warmed = false;
  b._seen = new Set();
  const fixture = (id, ts) => ({
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id,
          timestampUsec: String(ts * 1000),
          authorName: { simpleText: 'tester' },
          message: { runs: [{ text: 'hola ' + id }] },
        },
      },
    },
  });
  const cj = (actions) => ({ continuationContents: { liveChatContinuation: { actions } } });
  b._innertubeEmit(cj([fixture('viejo', Date.now() - 10 * 60 * 1000), fixture('nuevo', Date.now())]));
  b._innertubeEmit(cj([fixture('nuevo', Date.now())]));
  const parseOk = emitted === 1;
  console.log(parseOk ? 'OK: parseo (salta lo viejo, dedupe por id)' : `FALLA: parseo emitio=${emitted} (esperado 1)`);

  server.close();
  process.exit(relayOk && parseOk ? 0 : 1);
}
