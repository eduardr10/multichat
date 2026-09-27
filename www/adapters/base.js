export const STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  OFF: 'off',
};

export class BaseAdapter {
  constructor(platform) {
    this.platform = platform;
    this.status = STATUS.IDLE;
    this.stopped = true;
    this.config = null;
    this._handlers = {};
    this._retry = 0;
    this._reconnectTimer = null;
  }

  on(event, cb) {
    (this._handlers[event] ||= []).push(cb);
    return this;
  }

  _emit(event, payload) {
    for (const cb of this._handlers[event] || []) cb(payload);
  }

  _setStatus(status) {
    if (this.status !== status) {
      this.status = status;
      this._emit('status', status);
    }
  }

  _msg({ user, color = null, badges = [], text, id = null, ts = Date.now(), kind = 'chat' }) {
    return { platform: this.platform, user, color, badges, text, id, ts, kind };
  }

  start(config) {
    this.stop();
    this.stopped = false;
    this.config = config;
    this._retry = 0;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimer();
    this._disconnect();
    this._setStatus(STATUS.OFF);
  }

  // Llamado al volver a primer plano: reanuda sin esperar el temporizador.
  resume() {}

  _connect() {
    throw new Error('adapter sin _connect');
  }

  _disconnect() {}

  _connected() {
    this._retry = 0;
    this._setStatus(STATUS.CONNECTED);
  }

  _fail(error) {
    if (this.stopped) return;
    this._setStatus(STATUS.ERROR);
    this._emit('error', error);
  }

  _retryLater() {
    if (this.stopped) return;
    const base = Math.min(1000 * 2 ** this._retry, 30000);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this._retry += 1;
    this._setStatus(STATUS.RECONNECTING);
    this._clearTimer();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.stopped) this._connect();
    }, delay);
  }

  _clearTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}
