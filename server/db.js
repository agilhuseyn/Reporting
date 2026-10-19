import pg from 'pg';

const { Pool } = pg;

// DATE sütunları JS Date əvəzinə YYYY-MM-DD mətni kimi qayıtsın (saat qurşağı sürüşməsi olmasın)
pg.types.setTypeParser(1082, (v) => v);

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL təyin olunmayıb');

const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
export const ssl = local ? false : { rejectUnauthorized: false };

// Portal bazası (idarəetmə məlumatları). Tam yetkili istifadəçi.
export const pool = new Pool({ connectionString: url, ssl, max: 8 });

// Hesabat bazası. Yalnız oxuma yetkisi olan ayrı istifadəçi (report_ro).
// Parol olmasa və ya rol yaranmasa, hesabatlar işləməz (təhlükəsizlik üçün).
export let reportPool = null;

export function initReportPool() {
  const password = process.env.REPORT_RO_PASSWORD;
  if (!password) return null;
  const u = new URL(url);
  u.username = 'report_ro';
  u.password = password;
  reportPool = new Pool({ connectionString: u.toString(), ssl, max: 5 });
  reportPool.on('error', (e) => console.error('reportPool xətası:', e.message));
  return reportPool;
}

export function disableReportPool() {
  reportPool = null;
}
