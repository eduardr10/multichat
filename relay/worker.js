// Relay de YouTube para la version web de MultiChat (Cloudflare Workers, gratis).
//
// Despliegue (una vez):
//   npm install -g wrangler
//   wrangler login
//   npx wrangler deploy relay/worker.js --name multichat-relay
//
// Luego pega la URL que imprime (https://multichat-relay.TU-USUARIO.workers.dev)
// en Ajustes -> "Relay propio de YouTube" de la app web.
//
// Por que: el navegador llama a youtube.com con Origin de otra pagina y
// YouTube responde 403 sin CORS; aqui se reenvia la peticion sin ese Origin
// y se devuelve con Access-Control-Allow-Origin: *.

const ALLOWED = ['youtube.com', 'googleapis.com'];

function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
    ...extra,
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(request.url);
    let target = url.searchParams.get('url') || (url.pathname !== '/' ? url.pathname.slice(1) : null);
    if (!target) {
      return new Response('Uso: /?url=https://www.youtube.com/...', { status: 400, headers: cors() });
    }
    if (target.startsWith('//')) target = 'https:' + target;

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response('URL invalida', { status: 400, headers: cors() });
    }
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED.some((d) => host === d || host.endsWith('.' + d))) {
      return new Response('Solo se proxya youtube.com/googleapis.com', { status: 403, headers: cors() });
    }

    // El navegador manda Origin/Sec-Fetch/Referer de la app: se quitan para
    // que YouTube no responda 403. Cookie/user-agent tambien se descartan.
    const headers = new Headers();
    for (const [k, v] of request.headers) {
      const key = k.toLowerCase();
      if (['origin', 'referer', 'cookie', 'host', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'].includes(key)) {
        continue;
      }
      headers.set(k, v);
    }

    let res;
    try {
      res = await fetch(parsed.toString(), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'follow',
      });
    } catch (err) {
      return new Response('Error de red: ' + String(err.message || err), { status: 502, headers: cors() });
    }

    const out = cors();
    const type = res.headers.get('content-type');
    if (type) out['content-type'] = type;
    return new Response(res.body, { status: res.status, headers: out });
  },
};
