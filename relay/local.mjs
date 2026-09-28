// Relay local de prueba para la web (mismo contrato que relay/worker.js).
// Uso: node relay/local.mjs  ->  http://127.0.0.1:8787/?url=<destino>
// Para exponerlo a internet sin cuentas:
//   E:\tools\cloudflared.exe tunnel --url http://127.0.0.1:8787 --no-autoupdate
// (imprime una URL https://xxx.trycloudflare.com; pegala en Ajustes de la app)
import http from 'node:http';

const ALLOWED = ['youtube.com', 'googleapis.com'];
const DROP = ['origin', 'referer', 'cookie', 'host', 'connection', 'keep-alive',
  'transfer-encoding', 'upgrade', 'accept-encoding', 'sec-fetch-site',
  'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
};

function body(req) {
  return new Promise((ok) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => ok(Buffer.concat(c)));
  });
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  const u = new URL(req.url, 'http://localhost');
  let target = u.searchParams.get('url') || (u.pathname !== '/' ? u.pathname.slice(1) : null);
  if (!target) { res.writeHead(400, cors); return res.end('Uso: /?url=https://www.youtube.com/...'); }
  if (target.startsWith('//')) target = 'https:' + target;

  let parsed;
  try { parsed = new URL(target); } catch { res.writeHead(400, cors); return res.end('URL invalida'); }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED.some((d) => host === d || host.endsWith('.' + d))) {
    res.writeHead(403, cors);
    return res.end('Solo se proxya youtube.com/googleapis.com');
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP.includes(k.toLowerCase())) headers[k] = v;
  }
  delete headers['content-length'];

  try {
    const b = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
    const r = await fetch(parsed.toString(), { method: req.method, headers, body: b, redirect: 'follow' });
    const out = { ...cors };
    const ct = r.headers.get('content-type');
    if (ct) out['content-type'] = ct;
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, cors);
    res.end('Error de red: ' + (e?.message || e));
  }
}).listen(8787, '127.0.0.1', () => console.log('relay local en http://127.0.0.1:8787'));
