import { app } from './app.js';
import { pool } from './db.js';
const server = app.listen(Number(process.env.API_PORT ?? 4000), '127.0.0.1', () => console.log('Signals API listening on port 4000'));
const cleanup = setInterval(() => {
  void pool.query('DELETE FROM auth_transactions WHERE expires_at<now()').catch(() => {});
  void pool.query('DELETE FROM auth_sessions WHERE expires_at<now() OR absolute_expires_at<now()').catch(() => {});
}, 60_000);
cleanup.unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(cleanup); server.close(() => { void pool.end(); });
});
