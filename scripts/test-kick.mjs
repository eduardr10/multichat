import { KickAdapter } from '../www/adapters/kick.js';
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

const channel = process.argv[2] || 'xqc';
const adapter = new KickAdapter();
let messages = 0;

adapter.on('status', (s) => console.log('[kick] status:', s));
adapter.on('error', (e) => console.log('[kick] error:', e));
adapter.on('message', (m) => {
  messages += 1;
  if (messages <= 3) console.log(`[kick] ${m.kind === 'system' ? '*' : m.user}: ${m.text}`);
});

adapter.start({ channel });

const connected = await waitFor(() => adapter.status === STATUS.CONNECTED, 15000);
console.log(connected ? `OK: suscrito al chat de ${channel}` : 'FALLA: sin suscribir en 15s');

await sleep(6000);
console.log(`mensajes recibidos: ${messages}${messages > 0 ? '' : ' (canal quizás offline — no bloquea)'}`);

adapter.stop();
process.exit(connected ? 0 : 1);
