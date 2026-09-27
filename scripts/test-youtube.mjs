import { YouTubeAdapter } from '../www/adapters/youtube.js';
import { STATUS } from '../www/adapters/base.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(150);
  }
  return false;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

async function findLive() {
  const home = await (await fetch('https://www.youtube.com/', { headers: { 'user-agent': UA, cookie: 'SOCS=CAI' } })).text();
  const key = home.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const ver = home.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1];
  const res = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${key}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, cookie: 'SOCS=CAI' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'en', gl: 'US' } },
      query: 'live news',
      params: 'EgJAAQ==',
    }),
  });
  const j = await res.json();
  const found = [];
  (function walk(o) {
    if (!o || typeof o !== 'object' || found.length > 5) return;
    if (o.videoRenderer?.videoId && JSON.stringify(o.videoRenderer.badges || '').includes('LIVE')) {
      found.push(o.videoRenderer.videoId);
    }
    for (const v of Object.values(o)) walk(v);
  })(j);
  return [...new Set(found)];
}

async function runAdapter(label, input, apiKey, connectTimeout) {
  const adapter = new YouTubeAdapter();
  let messages = 0;
  let lastError = null;
  adapter.on('status', (s) => console.log(`[youtube:${label}] status: ${s}`));
  adapter.on('error', (e) => {
    lastError = e;
    console.log(`[youtube:${label}] error: ${e}`);
  });
  adapter.on('message', (m) => {
    messages += 1;
    if (messages <= 3) console.log(`[youtube:${label}] ${m.user}: ${m.text}`);
  });

  adapter.start({ input, apiKey });
  const connected = await waitFor(() => adapter.status === STATUS.CONNECTED, connectTimeout);
  await sleep(8000);
  console.log(
    `[youtube:${label}] ${connected ? 'CONECTADO' : 'FALLA'} | input=${input} | mensajes=${messages}` +
      (connected ? '' : ` | ultimoError=${lastError}`),
  );
  adapter.stop();
  await sleep(100);
  return { connected, messages };
}

const apiKey = process.env.YT_API_KEY || '';
const givenInput = process.argv[2] || '';

let pass = false;

if (givenInput) {
  console.log(`Probando entrada indicada: ${givenInput}`);
  const r = await runAdapter('directo', givenInput, apiKey, 45000);
  // Conectar basta: el chat puede estar en silencio (mensajes = informativo).
  pass = r.connected;
} else if (apiKey) {
  console.log('\n--- modo OFICIAL (con API key) ---');
  const lives = await findLive();
  if (!lives.length) {
    console.error('FALLA: sin streams en vivo en la busqueda');
    process.exit(1);
  }
  const r = await runAdapter('oficial', lives[0], apiKey, 30000);
  pass = r.connected;
} else {
  console.log('\n--- modo sin clave: busqueda de live + video directo ---');
  const lives = await findLive();
  console.log(lives.length ? `candidatos: ${lives.join(', ')}` : 'sin candidatos');
  for (const id of lives.slice(0, 3)) {
    const r = await runAdapter('innertube', id, '', 30000);
    pass = r.connected;
    if (pass) break;
  }
}

console.log(pass ? '\nOK: YouTube hibrido funcionando' : '\nFALLA: YouTube no conecto');
process.exit(pass ? 0 : 1);
