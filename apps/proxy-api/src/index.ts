import { app } from './app.js';
import { pool } from './db.js';
import { settings } from './config.js';
const server = app.listen(settings.port, settings.host, () => console.log(`Signals proxy API listening on ${settings.host}:${settings.port}`));
const cleanup = setInterval(() => {
  void pool.query('DELETE FROM auth_transactions WHERE expires_at<now()').catch(() => {});
  void pool.query('DELETE FROM auth_sessions WHERE expires_at<now() OR absolute_expires_at<now()').catch(() => {});
}, 60_000);
cleanup.unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(cleanup); server.close(() => { void pool.end(); });
});
