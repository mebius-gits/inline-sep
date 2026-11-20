import { createApp } from './app.js';
import { networkInterfaces } from 'node:os';

const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '0.0.0.0';
const { app, db } = await createApp({ dbPath: process.env.DB_PATH || 'data/orders.sqlite', adminUsername: process.env.ADMIN_USERNAME ?? 'admin', adminPassword: process.env.ADMIN_PASSWORD ?? 'admin', secureCookies: process.env.COOKIE_SECURE === 'true' });
const server = app.listen(port, host, () => {
  console.log(`點餐頁：http://localhost:${port}`);
  console.log(`管理後台：http://localhost:${port}/admin`);
  if (host === '0.0.0.0') for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) {
    if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) console.log(`同 Wi-Fi 手機：http://${address.address}:${port}`);
  }
});
server.on('error', error => { console.error(error.message); db.close(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
