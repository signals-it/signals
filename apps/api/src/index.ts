import { app } from './app.js';
import { pool } from './db.js';
import { settings } from './config.js';
const server = app.listen(settings.port, settings.host, () => console.log(`Signals backend API listening on ${settings.host}:${settings.port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(() => { void pool.end(); });
});
