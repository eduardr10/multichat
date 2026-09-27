import { TwitchAdapter } from '../www/adapters/twitch.js';
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

const channel = process.argv[2] || 'twitch';
const adapter = new TwitchAdapter();
let messages = 0;

adapter.on('status', (s) => console.log('[twitch] status:', s));
adapter.on('error', (e) => console.log('[twitch] error:', e));
adapter.on('message', (m) => {
  messages += 1;
  if (messages <= 3) console.log(`[twitch] ${m.user}: ${m.text}`);
});

adapter.start({ channel });

const connected = await waitFor(() => adapter.status === STATUS.CONNECTED, 8000);
console.log(connected ? `OK: conectado a #${channel}` : 'FALLA: sin conectar en 8s');

await sleep(6000);
console.log(`mensajes recibidos: ${messages}${messages > 0 ? '' : ' (canal quizás offline — no bloquea)'}`);

adapter.stop();
process.exit(connected ? 0 : 1);
