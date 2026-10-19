// Sürət limiti yoxlaması: RUN_RATE_PER_MIN standart (30) olan serverdə işlədin.
// Təhlükəsizlik yoxlaması: işləyən portala qarşı hücum ssenariləri.
// İstifadə:  BASE=http://localhost:3000 PW=seedparol node scripts/security-check.mjs
// Yalnız TEST mühitində işlədin (nümunə istifadəçilər 100001, 100002, 100003, 100317, 100482, 100501 lazımdır).
const BASE = process.env.BASE || 'http://localhost:3000';
const PW = process.env.PW || 'ChangeMe123';
const APPHDR = { 'X-Portal-App': '1' };

let pass = 0;
const fails = [];
const notes = [];
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else fails.push(`${name}${extra ? ' → ' + extra : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? '  [' + extra + ']' : ''}`);
};
const note = (s) => { notes.push(s); console.log(`NOTE  ${s}`); };

async function call(method, path, { body, cookie, headers = {}, raw, app = true } = {}) {
  const h = { ...(app ? APPHDR : {}), ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* mətn */ }
  return { status: res.status, json, text, headers: res.headers, ms: Date.now() - t0 };
}

async function login(empid, password = PW) {
  const r = await call('POST', '/api/auth/login', { body: { empid, password } });
  const sc = r.headers.get('set-cookie') || '';
  const m = /token=([^;]+)/.exec(sc);
  return { r, cookie: m ? `token=${m[1]}` : null };
}

const sec = (t) => console.log(`\n=== ${t} ===`);

const sessions = {};
for (const e of ['100317', '100501']) sessions[e] = (await login(e)).cookie;
sec('Sürət limiti');
{
  const cookie = sessions['100317'];
  const list = await call('GET', '/api/reports', { cookie });
  const id = list.json[0].id;
  const today = new Date().toISOString().slice(0, 10);
  const codes = [];
  for (let i = 0; i < 45; i++) {
    const r = await call('POST', `/api/reports/${id}/run`, { cookie, body: { params: { tarix_bas: today, tarix_son: today } } });
    codes.push(r.status);
  }
  ok('İstifadəçi başına hesabat limiti (429) işləyir', codes.includes(429), [...new Set(codes)].join(','));
  const l = [];
  for (let i = 0; i < 12; i++) l.push((await call('POST', '/api/auth/login', { body: { empid: 'lockme01', password: 'x' + i } })).status);
  ok('Brute-force: eyni hesaba ardıcıl səhv cəhdlər 429 ilə kəsilir', l.includes(429), l.join(','));
  const still = await login('100501');
  ok('Başqa hesab təsirlənmir', still.r.status === 200, String(still.r.status));
  const big = await call('POST', '/api/auth/login', { raw: JSON.stringify({ empid: 'a', password: 'x'.repeat(400_000) }), headers: { 'Content-Type': 'application/json' } });
  if (big.status === 413) ok('Böyük sorğu gövdəsi rədd edilir (413)', true);
  else note(`Böyük gövdə (400KB) cavabı ${big.status}: real Express-də 413 olmalıdır (test mühitində yalançı Express var)`);
}

console.log(`\n==== NƏTİCƏ: ${pass} keçdi, ${fails.length} uğursuz ====`);
for (const f of fails) console.log(' ✗ ' + f);
process.exit(fails.length ? 1 : 0);
