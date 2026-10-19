import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { migrate } from './migrate.js';
import { api } from './api.js';
import { pool } from './db.js';
import { seedSales } from './demo-sales.js';
import { seedDemoReports } from './demo-reports.js';
import { securityHeaders, sameOrigin, rateLimit, appGate, gzipJson } from './security.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api', sameOrigin);
app.use('/api', rateLimit({ windowMs: 60_000, max: 3000 })); // ortaq IP (NAT) arxasında yüzlərlə istifadəçi ola bilər
app.use('/api', appGate);
app.use('/api', gzipJson);
app.use('/api', api);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Tapılmadı' }));

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { setHeaders: (r) => r.setHeader('Cache-Control', 'no-cache'), index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server xətası' : err.message });
});

const port = Number(process.env.PORT) || 3000;
try {
  const roleOk = await migrate();
  console.log(roleOk ? 'Hesabat bazası (report_ro) hazırdır.' : 'Diqqət: hesabat icrası söndürülüb.');
} catch (e) {
  console.error('Migrasiya xətası:', e);
  await pool.end().catch(() => {});
  process.exit(1);
}
app.listen(port, () => console.log(`Hesabat Portalı: port ${port}`));

// Genişləndirilmiş satış test datası: server açıldıqdan sonra arxa fonda, bir əməliyyatda yaradılır.
// Xəta olsa portal işləməyə davam edir.
if (process.env.SEED_SALES_DEMO !== '0') {
  (async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await seedSales(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      console.error('Satış test datası yaradılmadı:', e.message);
    }
    try {
      await c.query('BEGIN');
      await seedDemoReports(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      console.error('Test hesabatları yaradılmadı:', e.message);
    } finally {
      c.release();
    }
  })();
}
