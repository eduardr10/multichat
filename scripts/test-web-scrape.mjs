// Prueba del modo web (scraping del popout del chat) sin relay ni API key.
// Uso: node scripts/test-web-scrape.mjs [https://www.youtube.com/watch?v=...]
import { YouTubeAdapter } from '../www/adapters/youtube.js';

const url = process.argv[2] || 'https://www.youtube.com/watch?v=uhicSinVQEs';
console.log('modo web (scraping) contra', url);

const adapter = new YouTubeAdapter();
const msgs = [];
const errors = [];
let status = 'idle';
adapter.on('status', (s) => {
  status = s;
  console.log('  [scrape] status:', s);
});
adapter.on('error', (e) => {
  errors.push(e);
  console.log('  [scrape] error:', e);
});
adapter.on('message', (m) => msgs.push(m));

adapter.start({ input: url, mode: 'scrape' });

const t0 = Date.now();
const deadline = t0 + 60000;
let firstCount = 0;
let sawNew = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  if (!firstCount && msgs.length) {
    firstCount = msgs.length;
    const m = msgs[0];
    console.log(`  primer lote: ${firstCount} mensajes | ej: ${m.user}: ${m.text.slice(0, 60)}`);
  }
  if (firstCount && msgs.length > firstCount) {
    sawNew = true;
    break;
  }
  if (status === 'error' && errors.length >= 3) break;
}
adapter.stop();

const ids = msgs.map((m) => m.id).filter(Boolean);
const dups = ids.length - new Set(ids).size;
const pass = msgs.length > 0 && dups === 0;
console.log(
  pass
    ? `OK: scraping en vivo (mensajes: ${msgs.length}, refresco: ${sawNew ? 'si' : 'no hubo mensaje nuevo en la ventana'}, dups: ${dups})`
    : `FALLO: status=${status} mensajes=${msgs.length} dups=${dups} errores=${errors.join(' | ') || 'ninguno'}`,
);
process.exit(pass ? 0 : 1);
