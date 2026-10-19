// Yük (stress) testi. Yalnız TEST mühitində işlədin.
// BASE=http://localhost:3000 PW=seedparol [PID=<server pid>] node scripts/load-check.mjs
// Serveri RUN_RATE_PER_MIN=100000 ilə işə salın (istifadəçi başına sürət limiti ölçməni pozmasın).
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const PW = process.env.PW || 'ChangeMe123';
const PID = process.env.PID;
const H = { 'X-Portal-App': '1' };
const USERS = Number(process.env.USERS || 300);

async function call(method, path, { body, cookie } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...H, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, ms: performance.now() - t0, size: text.length, text, headers: res.headers };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, size: 0, text: String(e.message), headers: new Headers() };
  }
}
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
const rss = () => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${PID}/status`, 'utf8'))[1]) / 1024); } catch { return null; } };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : 0; };

async function login(empid, pw = PW) {
  const r = await call('POST', '/api/auth/login', { body: { empid, password: pw } });
  const m = /token=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  return { r, cookie: m ? `token=${m[1]}` : null };
}

// Hadisə dövrəsi gecikməsi: /healthz-ə hər 100 ms sorğu
function lagMonitor() {
  const lags = [];
  let on = true;
  (async () => {
    while (on) {
      const r = await call('GET', '/healthz');
      lags.push(r.ms);
      await new Promise((r2) => setTimeout(r2, 100));
    }
  })();
  return { stop: () => { on = false; return { p50: pct(lags, 0.5), max: Math.round(Math.max(0, ...lags)) }; } };
}

async function scenario(name, n, fn) {
  const lag = lagMonitor();
  const rss0 = rss();
  let peak = rss0 || 0;
  const tick = setInterval(() => { const v = rss(); if (v && v > peak) peak = v; }, 200);
  const t0 = performance.now();
  const res = await Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
  const total = performance.now() - t0;
  clearInterval(tick);
  const l = lag.stop();
  const by = {};
  for (const r of res) by[r.status] = (by[r.status] || 0) + 1;
  const ok = res.filter((r) => r.status === 200).map((r) => r.ms);
  console.log(
    `${name.padEnd(42)} n=${String(n).padStart(4)} | ${Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' ')} | ` +
    `p50=${pct(ok, 0.5)}ms p95=${pct(ok, 0.95)}ms max=${pct(ok, 1)}ms | ${(total / 1000).toFixed(1)}s | ` +
    `lag p50=${l.p50}ms max=${l.max}ms | RSS ${rss0 ?? '?'}→${peak || '?'}MB | ${Math.round((res[0]?.size || 0) / 1024)}KB/cavab`,
  );
  return res;
}

// ---------- hazırlıq ----------
const admin = await login('100001');
if (!admin.cookie) { console.error('Admin girişi alınmadı'); process.exit(2); }
const A = admin.cookie;

const subj = json(await call('GET', '/api/admin/subjects', { cookie: A }));
const pos = subj.positions.find((p) => p.name === 'İç. SN') || subj.positions[0];

// 20 000 və 50 000 sətirlik hesabatlar
async function ensureReport(code, name, limit) {
  const list = json(await call('GET', '/api/admin/reports', { cookie: A })) || [];
  let r = list.find((x) => x.code === code);
  if (!r) {
    const sql = `SELECT s.id AS sifaris_id, s.nomre AS nomre, s.tarix AS tarix, m.ad AS musteri, f.ad AS filial, s.status AS status, s.cemi AS cemi
      FROM demo.satis_sifaris s JOIN demo.musteri m ON m.id = s.musteri_id JOIN demo.filial f ON f.kod = s.filial_kod
      WHERE s.tarix >= @bas ORDER BY s.id LIMIT ${limit}`;
    const an = json(await call('POST', '/api/admin/reports/analyze', { cookie: A, body: { sql, kind: 'query' } }));
    const cr = await call('POST', '/api/admin/reports', { cookie: A, body: {
      code: code, name_az: name, kind: 'query', sql,
      params: [{ name: 'bas', type: 'date', required: true, label: 'Başlanğıc', default: '2025-01-01' }],
      columns: (an?.columns || []).map((c) => ({ code: c.code, src: c.src, label_az: c.label, type: c.type, sensitivity: 'normal' })),
    } });
    const id = json(cr)?.id;
    const meta = json(await call('GET', `/api/admin/reports/${id}`, { cookie: A }));
    const cols = Object.fromEntries((meta.columns || []).map((c) => [c.code, 'show']));
    await call('PUT', '/api/admin/permissions', { cookie: A, body: { subjectType: 'position', subjectId: String(pos.id), reportId: id, granted: true, canExport: true, columns: cols, rules: [] } });
    r = { id };
  }
  return r.id;
}
const R20 = await ensureReport('LOAD_20K', 'Yük testi 20k sətir', 20000);
const R50 = await ensureReport('LOAD_50K', 'Yük testi 50k sətir', 50000);

// test istifadəçiləri
const sessions = [];
const lo = process.env.SKIPSETUP ? 0 : USERS;
for (let i = 0; i < lo; i += 25) {
  await Promise.all(Array.from({ length: Math.min(25, lo - i) }, async (_, k) => {
    const id = `load${String(i + k).padStart(3, '0')}`;
    await call('POST', '/api/admin/users', { cookie: A, body: { empid: id, name: `Yük ${i + k}`, password: PW, role: 'user', position_id: pos.id } });
  }));
}
console.log(`Hazırlıq: ${USERS} test istifadəçisi, hesabatlar ${R20}/${R50}, vəzifə "${pos.name}"\n`);

// ---------- giriş yükü ----------
const t0 = performance.now();
const logins = await scenario('Giriş: 300 istifadəçi eyni anda', USERS, async (i) => {
  const l = await login(`load${String(i).padStart(3, '0')}`);
  if (l.cookie) sessions[i] = l.cookie;
  return l.r;
});
console.log(`   (giriş throughput ≈ ${(USERS / ((performance.now() - t0) / 1000)).toFixed(0)} giriş/san)`);
const live = sessions.filter(Boolean);
if (live.length < 10) { console.error('Kifayət qədər sessiya yoxdur'); process.exit(2); }

const listBody = (i) => ({ params: { tarix_bas: '2025-01-01', tarix_son: '2026-12-31' } });
const smId = json(await call('GET', '/api/reports', { cookie: live[0] })).find((r) => /SALES_MONTHLY|aylıq/i.test(JSON.stringify(r)))?.id;

// ---------- normal iş ----------
await scenario('Hesabat siyahısı (300 eyni anda)', live.length, (i) => call('GET', '/api/reports', { cookie: live[i] }));
await scenario('Satış hesabatı (kiçik nəticə), 300 eyni anda', live.length, (i) => call('POST', `/api/reports/${smId}/run`, { cookie: live[i], body: listBody(i) }));
await scenario('Satış hesabatı, 60 eyni anda', 60, (i) => call('POST', `/api/reports/${smId}/run`, { cookie: live[i], body: listBody(i) }));

// ---------- ağır nəticə ----------
await scenario('20 000 sətir, 1 istifadəçi', 1, () => call('POST', `/api/reports/${R20}/run`, { cookie: live[0], body: { params: { bas: '2025-01-01' } } }));
await scenario('20 000 sətir, 10 eyni anda', 10, (i) => call('POST', `/api/reports/${R20}/run`, { cookie: live[i], body: { params: { bas: '2025-01-01' } } }));
await scenario('20 000 sətir, 50 eyni anda', 50, (i) => call('POST', `/api/reports/${R20}/run`, { cookie: live[i], body: { params: { bas: '2025-01-01' } } }));
await scenario('50 000 sətir (maks), 1 istifadəçi', 1, () => call('POST', `/api/reports/${R50}/run`, { cookie: live[0], body: { params: { bas: '2025-01-01' } } }));
await scenario('50 000 sətir (maks), 20 eyni anda', 20, (i) => call('POST', `/api/reports/${R50}/run`, { cookie: live[i], body: { params: { bas: '2025-01-01' } } }));

// ---------- davamlı yük ----------
{
  const lag = lagMonitor();
  const t1 = performance.now();
  const lat = [];
  const codes = {};
  let sent = 0;
  const DUR = 20_000;
  await Promise.all(Array.from({ length: 40 }, async (_, w) => {
    while (performance.now() - t1 < DUR) {
      const i = (w * 7 + sent++) % live.length;
      const r = await call('POST', `/api/reports/${smId}/run`, { cookie: live[i], body: listBody(i) });
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.status === 200) lat.push(r.ms);
    }
  }));
  const l = lag.stop();
  console.log(`Davamlı yük: 40 paralel istifadəçi, 20 san | ${Object.entries(codes).map(([k, v]) => `${k}:${v}`).join(' ')} | ` +
    `${(sent / 20).toFixed(0)} sorğu/san | p50=${pct(lat, 0.5)}ms p95=${pct(lat, 0.95)}ms | lag max=${l.max}ms | RSS ${rss() ?? '?'}MB`);
}

// ---------- sonda: server sağlamdır? ----------
const h = await call('GET', '/healthz');
const me = await call('GET', '/api/me', { cookie: live[0] });
console.log(`\nSon yoxlama: healthz ${h.status}, /me ${me.status}`);
process.exit(h.status === 200 && me.status === 200 ? 0 : 1);
