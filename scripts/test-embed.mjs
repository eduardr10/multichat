// Test del modo embebido de YouTube (la web sin API key).
// Define window/document antes de importar el adaptador para que IS_BROWSER=true,
// igual que en el navegador de GitHub Pages. Busca un directo en vivo y espera
// el evento 'embed' con el videoId que usara el panel iframe.
globalThis.window = {};
globalThis.document = {};

const { YouTubeAdapter } = await import('../www/adapters/youtube.js');
const { STATUS } = await import('../www/adapters/base.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

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
    if (!o || typeof o !== 'object' || found.length > 6) return;
    const v = o.videoRenderer;
    if (v?.videoId && JSON.stringify(v.badges || '').includes('LIVE')) {
      const browse = v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
      found.push({ id: v.videoId, handle: browse?.canonicalBaseUrl, uc: browse?.browseId });
    }
    for (const child of Object.values(o)) walk(child);
  })(j);
  return found;
}

const givenInput = process.argv[2] || '';
let input = givenInput;

if (!input) {
  const lives = await findLive();
  const pick = lives.find((l) => l.handle?.startsWith('/@')) || lives[0];
  if (!pick) {
    console.error('FALLA: sin streams en vivo en la busqueda');
    process.exit(1);
  }
  input = pick.handle?.startsWith('/@')
    ? 'https://www.youtube.com' + pick.handle
    : 'https://www.youtube.com/channel/' + pick.uc;
  console.log(`candidato: ${input} (video ${pick.id})`);
}

const adapter = new YouTubeAdapter();
let pass = false;

adapter.on('status', (s) => console.log(`[embed] status: ${s}`));
adapter.on('error', (e) => console.log(`[embed] error: ${e}`));
adapter.on('embed', (videoId) => {
  console.log(`[embed] EMBED videoId=${videoId}`);
  pass = /^[A-Za-z0-9_-]{11}$/.test(videoId) && adapter.status === STATUS.CONNECTED;
  adapter.stop();
  console.log(pass ? '\nOK: modo embebido resolvio el directo' : '\nFALLA: embed invalido');
  process.exit(pass ? 0 : 1);
});

adapter.start({ input, apiKey: '' });

await sleep(100000);
console.log('FALLA: timeout esperando el evento embed');
process.exit(1);
