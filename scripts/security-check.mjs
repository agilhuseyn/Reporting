// Təhlükəsizlik yoxlaması: işləyən portala qarşı hücum ssenariləri.
// İstifadə:  BASE=http://localhost:3000 PW=seedparol node scripts/security-check.mjs   (serveri RUN_RATE_PER_MIN=100000 ilə işə salın)
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

// ---------- 1. Başlıqlar ----------
sec('Başlıqlar');
{
  const r = await call('GET', '/');
  const hd = (k) => r.headers.get(k) || '';
  ok('CSP var və script yalnız self', /script-src 'self'/.test(hd('content-security-policy')) && !/script-src[^;]*unsafe/.test(hd('content-security-policy')));
  ok('frame-ancestors none', /frame-ancestors 'none'/.test(hd('content-security-policy')));
  ok('X-Frame-Options DENY', hd('x-frame-options') === 'DENY');
  ok('nosniff', hd('x-content-type-options') === 'nosniff');
  ok('Referrer-Policy', hd('referrer-policy') === 'no-referrer');
  const a = await call('GET', '/api/me');
  ok('API cavabı keşlənmir (no-store)', /no-store/.test(a.headers.get('cache-control') || ''));
  ok('CORS başlığı yoxdur', !a.headers.get('access-control-allow-origin'));
  ok('X-Powered-By yoxdur', !r.headers.get('x-powered-by'));
}

// ---------- 2. Girişsiz çıxış ----------
sec('Girişsiz (autentifikasiyasız) çıxış');
for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/reports'], ['GET', '/api/reports/1/meta'], ['POST', '/api/reports/1/run'],
  ['GET', '/api/admin/users'], ['GET', '/api/admin/connections'], ['GET', '/api/admin/audit'], ['PUT', '/api/admin/connections/sql'],
  ['POST', '/api/admin/reports/test'], ['GET', '/api/admin/permissions?subjectType=user&subjectId=100482']]) {
  const r = await call(m, p, { body: m === 'GET' ? undefined : {} });
  ok(`${m} ${p} → 401`, r.status === 401, String(r.status));
}

// ---------- 3. "Yalnız tətbiq" qapısı ----------
sec('Yalnız tətbiq qapısı');
{
  const cfg = await call('GET', '/api/app-config', { app: false });
  ok('app-config açıqdır', cfg.status === 200 && typeof cfg.json?.appOnly === 'boolean', String(cfg.status));
  if (cfg.json?.appOnly) {
    const r = await call('POST', '/api/auth/login', { body: { empid: '100001', password: PW }, app: false });
    ok('Tətbiq başlığı olmadan giriş rədd edilir (403)', r.status === 403, String(r.status));
    const r2 = await call('POST', '/api/auth/login', { body: { empid: '100001', password: PW }, headers: { 'X-Portal-App': '0' }, app: false });
    ok('Brauzer tabı (X-Portal-App: 0) rədd edilir', r2.status === 403, String(r2.status));
  } else note('APP_ONLY söndürülüb (lokal rejim): qapı yoxlanmadı');
}

// ---------- 4. CSRF ----------
sec('CSRF / başqa mənbə');
{
  const r = await call('POST', '/api/auth/login', { body: { empid: '100001', password: PW }, headers: { Origin: 'https://evil.example' } });
  ok('Yad Origin ilə POST rədd edilir', r.status === 403, String(r.status));
  const r2 = await call('POST', '/api/auth/login', { body: { empid: '100001', password: PW }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  ok('Sec-Fetch-Site: cross-site rədd edilir', r2.status === 403, String(r2.status));
  const r3 = await call('POST', '/api/auth/login', { body: { empid: '100001', password: PW }, headers: { Origin: 'null' } });
  ok('Origin: null rədd edilir', r3.status === 403, String(r3.status));
}

// ---------- 5. Giriş hücumları ----------
sec('Giriş hücumları');
const sessions = {};
for (const e of ['100001', '100002', '100003', '100317', '100482', '100501']) {
  const l = await login(e);
  sessions[e] = l.cookie;
  ok(`Düzgün giriş ${e}`, l.r.status === 200 && !!l.cookie, String(l.r.status));
}
// EMPID -> UUID (API-də istifadəçi UUID ilə tanınır)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const U = {};
{
  const sj = await call('GET', '/api/admin/subjects', { cookie: sessions['100001'] });
  for (const u of sj.json?.users || []) U[u.empid] = u.id;
}
// Qanunsuz cəhd istifadəçini bloklayır. Hər cəhd üçün təmiz sessiya: admin blokdan çıxarır, istifadəçi yenidən girir.
async function fresh(empid) {
  await call('POST', `/api/admin/users/${U[empid]}/unblock`, { cookie: sessions['100001'], body: {} });
  const l = await login(empid);
  sessions[empid] = l.cookie;
  return l.cookie;
}
const auditRows = async () => (await call('GET', '/api/admin/audit?limit=1000', { cookie: sessions['100001'] })).json || [];
{
  const bad = await call('POST', '/api/auth/login', { body: { empid: '100001', password: 'yanlis-parol' } });
  const none = await call('POST', '/api/auth/login', { body: { empid: 'yoxdur999', password: 'yanlis-parol' } });
  ok('Yanlış parol 401', bad.status === 401, String(bad.status));
  ok('Olmayan istifadəçi də eyni cavab (enumerasiya yoxdur)', none.status === 401 && none.json?.error === bad.json?.error);
  note(`Cavab vaxtı: mövcud ${bad.ms}ms, mövcud olmayan ${none.ms}ms (fərq kiçik olmalıdır)`);
  for (const payload of [
    { empid: "' OR '1'='1", password: "' OR '1'='1" }, { empid: "100001'--", password: 'x' }, { empid: { $ne: 1 }, password: { $ne: 1 } },
    { empid: ['100001'], password: ['x'] }, { empid: '100001', password: '' }, { empid: '', password: '' }, { empid: null, password: null },
    { empid: '100001', password: 'a'.repeat(5000) }, { empid: '1'.repeat(500), password: 'x' }, {},
  ]) {
    const r = await call('POST', '/api/auth/login', { body: payload });
    ok(`Giriş yükü rədd (${JSON.stringify(payload).slice(0, 40)})`, r.status === 401 && r.status !== 500, String(r.status));
  }
  const bad2 = await call('POST', '/api/auth/login', { raw: '{bozuq json', headers: { 'Content-Type': 'application/json' } });
  ok('Pozuq JSON 4xx (500 yox)', bad2.status >= 400 && bad2.status < 500, String(bad2.status));
  ok('Xəta mətnində stack/yol yoxdur', !/at .*\.js|node_modules|\/home\//.test(bad2.text));
}

// ---------- 6. Token saxtakarlığı ----------
sec('Token saxtakarlığı');
{
  const good = sessions['100482'].split('=')[1];
  const [h, p, s] = good.split('.');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const tries = {
    'alg=none': `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, empid: '100001' })}.`,
    'empid dəyişdirilib, imza köhnə': `${h}.${b64({ ...payload, empid: '100001' })}.${s}`,
    'imza silinib': `${h}.${p}.`,
    'zibil': 'abc.def.ghi', 'boş': '', 'uzun zibil': 'x'.repeat(5000),
    'HS512': `${b64({ alg: 'HS512', typ: 'JWT' })}.${p}.${s}`,
  };
  for (const [name, tok] of Object.entries(tries)) {
    const r = await call('GET', '/api/me', { cookie: `token=${tok}` });
    ok(`Saxta token rədd: ${name}`, r.status === 401, String(r.status));
  }
  const adminTry = await call('GET', '/api/admin/users', { cookie: `token=${tries['empid dəyişdirilib, imza köhnə']}` });
  ok('Saxta token ilə admin API bağlıdır', adminTry.status === 401, String(adminTry.status));
}

// ---------- 7. İcazəsiz admin girişi ----------
sec('Yetki keçidi (admin marşrutları)');
{
  const adminRoutes = [
    ['GET', '/api/admin/users'], ['GET', '/api/admin/audit'], ['GET', '/api/admin/connections'], ['GET', '/api/admin/reports'],
    ['GET', '/api/admin/permissions?subjectType=user&subjectId=100482'], ['GET', '/api/admin/subjects'], ['GET', '/api/admin/categories'],
    ['POST', '/api/admin/users', { empid: 'hack1', name: 'x', password: 'parol12345', role: 'admin' }],
    ['PUT', `/api/admin/users/${U['100317']}`, { role: 'admin' }], ['PUT', `/api/admin/users/${U['100001']}`, { password: 'yenisifre123' }],
    ['PUT', '/api/admin/connections/sql', {}], ['POST', '/api/admin/connections/sql/test', {}], ['DELETE', '/api/admin/connections/sql'],
    ['POST', '/api/admin/reports/test', { sql: 'select 1' }], ['POST', '/api/admin/reports', { name_az: 'x', sql: 'select 1' }],
    ['PUT', '/api/admin/permissions', { subjectType: 'user', subjectId: U['100482'], reportId: U['100482'], granted: true, columns: {}, rules: [] }],
    ['POST', '/api/admin/positions', { name: 'hack' }], ['DELETE', `/api/admin/positions/${U['100482']}`], ['POST', '/api/admin/groups', { name: 'hack' }],
  ];
  for (const [m, p, b] of adminRoutes) {
    const r = await call(m, p, { cookie: await fresh('100482'), body: b });
    ok(`Adi istifadəçi → ${m} ${p.split('?')[0]} qadağan`, r.status === 403, String(r.status));
  }
  await fresh('100482');
  // dəstək (support) yalnız öz səlahiyyəti daxilində
  for (const [m, p, b] of [['GET', '/api/admin/connections'], ['PUT', '/api/admin/connections/sql', {}], ['POST', '/api/admin/connections/ldap/test', {}], ['DELETE', '/api/admin/connections/ldap']]) {
    const r = await call(m, p, { cookie: await fresh('100002'), body: b });
    ok(`Dəstək → ${m} ${p} (yalnız admin) qadağan`, r.status === 403, String(r.status));
  }
  const r1 = await call('GET', '/api/admin/users', { cookie: await fresh('100002') });
  ok('Dəstək (users yetkisi yoxdur) → istifadəçi siyahısı qadağan', r1.status === 403, String(r1.status));
  const r2 = await call('PUT', `/api/admin/users/${U['100001']}`, { cookie: await fresh('100003'), body: { role: 'user', password: 'yenisifre123' } });
  ok('Dəstək admin hesabını dəyişə bilmir', r2.status === 403, String(r2.status));
  const r3 = await call('GET', '/api/admin/audit', { cookie: await fresh('100003') });
  ok('Dəstək (audit yetkisi yoxdur) → jurnal qadağan', r3.status === 403, String(r3.status));
  const r4 = await call('POST', '/api/admin/reports/test', { cookie: await fresh('100003'), body: { sql: 'select 1' } });
  ok('Dəstək (reports yetkisi yoxdur) → SQL test qadağan', r4.status === 403, String(r4.status));
  for (const e of ['100002', '100003', '100482']) await fresh(e);
}

// ---------- 8. Məlumat sızması / hesabat yetkisi ----------
sec('Məlumat sızması və yetki (sütun, dəyər qaydası)');
{
  const list = await call('GET', '/api/reports', { cookie: sessions['100482'] });
  const sm = (list.json || []).find((r) => /SALES_MONTHLY|aylıq/i.test(JSON.stringify(r))) || (list.json || [])[0];
  const id = sm?.id;
  ok('Rəşad hesabat siyahısını görür', list.status === 200 && Array.isArray(list.json) && !!id, String(list.status));
  const meta = await call('GET', `/api/reports/${id}/meta`, { cookie: sessions['100482'] });
  const codes = (meta.json?.columns || []).map((c) => c.code);
  ok('Gizli sütunlar (amount, cost_price) meta-da yoxdur', !codes.includes('amount') && !codes.includes('cost_price'), codes.join(','));
  ok('Telefon maskalıdır', (meta.json?.columns || []).find((c) => c.code === 'phone')?.masked === true);
  const today = new Date().toISOString().slice(0, 10);
  const run = await call('POST', `/api/reports/${id}/run`, { cookie: sessions['100482'], body: { params: { tarix_bas: '2025-01-01', tarix_son: today } } });
  ok('Hesabat işləyir', run.status === 200, String(run.status) + ' ' + (run.json?.error || ''));
  const cols = (run.json?.columns || []).map((c) => c.code);
  ok('Nəticədə gizli sütun yoxdur', !cols.includes('amount') && !cols.includes('cost_price'), cols.join(','));
  const fi = cols.indexOf('filial_name');
  const rows = run.json?.rows || [];
  ok('Dəyər qaydası: yalnız "Bakı" sətirləri', rows.length > 0 && rows.every((r) => r[fi] === 'Bakı'), `${rows.length} sətir`);
  // admin tam datası ilə müqayisə: həqiqi telefon nömrələri sızmamalıdır
  const adm = await call('POST', '/api/admin/reports/test', { cookie: sessions['100001'], body: { sql: 'select telefon from demo.musteri limit 200' } });
  const realPhones = new Set((adm.json?.rows || []).map((r) => r[0]));
  const pi = cols.indexOf('phone');
  ok('Maskalı telefon sütununda real nömrə yoxdur', rows.length > 0 && rows.every((r) => !realPhones.has(r[pi]) && !String(r[pi]).includes('+994')));
  ok('Cavab mətnində "cost_price"/"maya" sızmır', !/cost_price|"maya"/.test(JSON.stringify(run.json?.rows || [])) );
  // yetkisi olmayan
  const none = await call('GET', '/api/reports', { cookie: sessions['100501'] });
  ok('Yetkisiz istifadəçiyə hesabat siyahısı boşdur', Array.isArray(none.json) && none.json.length === 0);
  const allReports = (await call('GET', '/api/admin/reports', { cookie: sessions['100001'] })).json || [];
  ok('Admin hesabat siyahısı alındı', allReports.length > 0);
  for (const { id: rid } of allReports) {
    const m = await call('GET', `/api/reports/${rid}/meta`, { cookie: await fresh('100501') });
    const r = await call('POST', `/api/reports/${rid}/run`, { cookie: await fresh('100501'), body: { params: { tarix_bas: '2025-01-01', tarix_son: today } } });
    const o = await call('GET', `/api/reports/${rid}/options/filial`, { cookie: await fresh('100501') });
    if (!(m.status === 403 || m.status === 404) || !(r.status === 403 || r.status === 404) || !(o.status === 403 || o.status === 404)) {
      ok(`Yetkisiz istifadəçi hesabat ${rid}-ə çata bilmir`, false, `${m.status}/${r.status}/${o.status}`);
    }
  }
  ok('Yetkisiz istifadəçi heç bir hesabata çata bilmir', !fails.some((f) => f.startsWith('Yetkisiz istifadəçi hesabat')));
  await fresh('100501');
  // parametrlə qaydanı aşmaq cəhdi
  const bypass = await call('POST', `/api/reports/${id}/run`, { cookie: sessions['100482'], body: { params: { tarix_bas: '2025-01-01', tarix_son: today, filial: 'SM' } } });
  const brows = bypass.json?.rows || [];
  ok('Filial parametri ilə yetki qaydası aşılmır (SM seçilsə də yalnız Bakı)', bypass.status === 200 && brows.every((r) => r[fi] === 'Bakı'));
  // id fuzz
  for (const bad of ['1', '2', '12', 'abc', '1 OR 1=1', '-1', '99999999999999', '1;DROP TABLE x', '%00', '1.5', '', '0x1']) {
    const r = await call('GET', `/api/reports/${encodeURIComponent(bad)}/meta`, { cookie: await fresh('100482') });
    ok(`Hesabat id fuzz «${bad}» → 4xx (500 yox)`, r.status >= 400 && r.status < 500, String(r.status));
  }
  await fresh('100482');
}

// ---------- 9. SQL injection (istifadəçi parametrləri) ----------
sec('SQL injection (parametrlər)');
{
  const list = await call('GET', '/api/reports', { cookie: sessions['100317'] });
  const id = (list.json || [])[0]?.id;
  const today = new Date().toISOString().slice(0, 10);
  const before = await call('POST', '/api/admin/reports/test', { cookie: sessions['100001'], body: { sql: 'select count(*) from demo.satis' } });
  const payloads = ["'; DROP TABLE demo.satis; --", "' OR '1'='1", "BK' UNION SELECT 1,2,3,4,5,6,7,8 --", '1); DELETE FROM demo.satis; --',
    '\u0000', 'a'.repeat(2000), "'||(select current_user)||'", '${7*7}', '{{7*7}}', '../../etc/passwd'];
  for (const p of payloads) {
    for (const key of ['filial', 'tarix_bas', 'tarix_son']) {
      const r = await call('POST', `/api/reports/${id}/run`, { cookie: await fresh('100317'), body: { params: { tarix_bas: '2025-01-01', tarix_son: today, [key]: p } } });
      if (r.status === 500 || /relation|syntax error|pg_|demo\.|portal\.|stack|ECONN/i.test(r.text)) {
        ok(`Injection yükü zərərsiz (${key}=${p.slice(0, 20)})`, false, `${r.status} ${r.text.slice(0, 120)}`);
      }
    }
  }
  const objs = [{ a: 1 }, [1, 2], true, 12345, null, { $gt: '' }];
  await fresh('100317');
  for (const v of objs) {
    const r = await call('POST', `/api/reports/${id}/run`, { cookie: sessions['100317'], body: { params: { tarix_bas: '2025-01-01', tarix_son: today, filial: v } } });
    if (r.status === 500) ok(`Obyekt/massiv parametr 500 vermir (${JSON.stringify(v)})`, false, r.text.slice(0, 100));
  }
  ok('Injection cəhdlərindən sonra sətirlər yerindədir və 500/sızma yoxdur', !fails.some((f) => f.startsWith('Injection') || f.startsWith('Obyekt')));
  const after = await call('POST', '/api/admin/reports/test', { cookie: sessions['100001'], body: { sql: 'select count(*) from demo.satis' } });
  ok('demo.satis sətir sayı dəyişməyib', String(before.json?.rows?.[0]?.[0]) === String(after.json?.rows?.[0]?.[0]), `${before.json?.rows?.[0]?.[0]} → ${after.json?.rows?.[0]?.[0]}`);
  const dt = await call('POST', `/api/reports/${id}/run`, { cookie: sessions['100317'], body: { params: { tarix_bas: 'bu-tarix-deyil', tarix_son: today } } });
  ok('Yanlış tarix: qısa, təhlükəsiz xəta (cədvəl adı sızmır)', dt.status === 400 && !/relation|syntax|demo\.|pg_|date:/i.test(dt.text), dt.text.slice(0, 120));
}

// ---------- 10. Admin SQL qoruması ----------
sec('Admin SQL qoruması (hesabat redaktoru)');
{
  const run = (sql) => call('POST', '/api/admin/reports/test', { cookie: sessions['100001'], body: { sql } });
  const blocked = {
    'portal sxemi': 'select * from portal.users', 'dırnaqlı portal': 'select * from "portal"."users"',
    'unicode portal': 'select * from U&"\\0070ortal".users', 'pg_authid': 'select rolpassword from pg_authid',
    'pg_shadow': 'select * from pg_shadow', 'pg_read_file': "select pg_read_file('/etc/passwd')", 'pg_sleep': 'select pg_sleep(100)',
    'set_config': "select set_config('statement_timeout','0',true)", 'lo_import': "select lo_import('/etc/passwd')",
    'çoxlu sorğu': 'select 1; select 2', 'şərhlə gizlədilmiş ikinci': 'select 1 /* x */; drop table demo.satis',
    'delete CTE': 'with a as (delete from demo.satis returning 1) select * from a', 'update CTE': 'with a as (update demo.satis set mebleg=0 returning 1) select * from a',
    'into': 'select * into demo.hack from demo.satis', 'insert': 'insert into demo.satis select * from demo.satis',
    'copy': "copy demo.satis to '/tmp/x'", 'information_schema': 'select * from information_schema.tables', 'dblink': "select * from dblink('x','y') as t(a int)",
    'setval': "select setval('demo.satis_id_seq', 1)", 'nextval': "select nextval('demo.satis_id_seq')",
    'for update': 'select * from demo.satis for update', 'current_setting': "select current_setting('data_directory')",
    'drop': 'drop table demo.satis', 'create': 'create table demo.hack(a int)', 'do': "do $$ begin perform 1; end $$",
  };
  for (const [name, sql] of Object.entries(blocked)) {
    const r = await run(sql);
    const leaked = r.status === 200 && /rolpassword|root:|portal|password_hash|\$2[aby]\$/.test(JSON.stringify(r.json?.rows || []));
    ok(`Admin SQL bloklanır: ${name}`, r.status !== 200 && !leaked, `${r.status} ${(r.json?.error || '').slice(0, 80)}`);
  }
  const still = await run('select count(*) from demo.satis');
  ok('Hücumlardan sonra demo.satis salamdır', still.status === 200 && Number(still.json?.rows?.[0]?.[0]) === 9000, JSON.stringify(still.json?.rows?.[0]));
  const hack = await run("select to_regclass('demo.hack') is null");
  ok('Hücum cədvəli yaranmayıb', hack.json?.rows?.[0]?.[0] === true);
}

// ---------- 11. Sessiyanın ləğvi ----------
sec('Sessiyanın ləğvi');
{
  const l = await login('100317');
  const me1 = await call('GET', '/api/me', { cookie: l.cookie });
  ok('Giriş sonrası /me işləyir', me1.status === 200);
  await call('POST', '/api/auth/logout', { cookie: l.cookie, body: {} });
  const me2 = await call('GET', '/api/me', { cookie: l.cookie });
  ok('Çıxışdan sonra köhnə token etibarsızdır', me2.status === 401, String(me2.status));
  const pw = await call('PUT', `/api/admin/users/${U['100359']}`, { cookie: sessions['100001'], body: { password: 'yeniParol12345' } });
  ok('Admin parolu dəyişdi', pw.status === 200, String(pw.status));
  const l2 = await login('100359', 'yeniParol12345');
  const me3 = await call('GET', '/api/me', { cookie: l2.cookie });
  ok('Yeni parolla giriş', me3.status === 200);
  await call('PUT', `/api/admin/users/${U['100359']}`, { cookie: sessions['100001'], body: { password: PW } });
  const me4 = await call('GET', '/api/me', { cookie: l2.cookie });
  ok('Parol dəyişəndə köhnə sessiya bağlanır', me4.status === 401, String(me4.status));
  await call('PUT', `/api/admin/users/${U['100359']}`, { cookie: sessions['100001'], body: { active: false } });
  const l3 = await login('100359');
  ok('Deaktiv istifadəçi girə bilmir', l3.r.status === 401, String(l3.r.status));
  await call('PUT', `/api/admin/users/${U['100359']}`, { cookie: sessions['100001'], body: { active: true } });
  const priv = await call('PUT', `/api/admin/users/${U['100001']}`, { cookie: sessions['100001'], body: { role: 'user' } });
  ok('Admin öz admin rolunu götürə bilmir', priv.status === 400, String(priv.status));
}

// ---------- 11b. UUID: daxili nömrələr çöldən görünmür ----------
sec('UUID (təxmin olunmayan ID-lər)');
{
  const A = sessions['100001'];
  const reports = (await call('GET', '/api/admin/reports', { cookie: A })).json || [];
  const cats = (await call('GET', '/api/admin/categories', { cookie: A })).json || [];
  const sj = (await call('GET', '/api/admin/subjects', { cookie: A })).json || {};
  const users = (await call('GET', '/api/admin/users', { cookie: A })).json || [];
  const fresh = (await login('100317')).cookie; // əvvəlki test bu istifadəçinin sessiyalarını bağlamışdı
  const mine = (await call('GET', '/api/reports', { cookie: fresh })).json || [];
  const me = (await call('GET', '/api/me', { cookie: fresh })).json || {};
  ok('Hesabat ID-ləri UUID-dir', reports.length > 0 && reports.every((r) => UUID.test(r.id)));
  ok('Hesabatın kateqoriya ID-si UUID-dir', reports.every((r) => r.category_id === null || UUID.test(r.category_id)));
  ok('Kateqoriya ID-ləri UUID-dir', cats.length > 0 && cats.every((c) => UUID.test(c.id)));
  ok('Vəzifə ID-ləri (və üst vəzifə) UUID-dir', (sj.positions || []).length > 0 && sj.positions.every((p) => UUID.test(p.id) && (p.parent_id === null || UUID.test(p.parent_id))));
  ok('Qrup ID-ləri UUID-dir', (sj.groups || []).every((g) => UUID.test(g.id)));
  ok('İstifadəçi ID-ləri UUID-dir', users.length > 0 && users.every((u) => UUID.test(u.id) && (u.position_id === null || UUID.test(u.position_id)) && (u.groups || []).every((g) => UUID.test(g))));
  ok('İstifadəçinin hesabat siyahısında ID-lər UUID-dir', mine.length > 0 && mine.every((r) => UUID.test(r.id) && (r.category_id === null || UUID.test(r.category_id))));
  ok('/me UUID verir, daxili nömrə (position_id) yoxdur', UUID.test(me.id) && !('position_id' in me));
  const all = [...reports, ...cats, ...(sj.positions || []), ...(sj.groups || []), ...users].map((x) => x.id);
  ok('Bütün ID-lər bir-birindən fərqlidir', new Set(all).size === all.length);
  const rep0 = await call('GET', `/api/admin/reports/${reports[0].id}`, { cookie: A });
  ok('Hesabat detalında daxili nömrə yoxdur', rep0.status === 200 && UUID.test(rep0.json.id) && !('uid' in rep0.json) && (rep0.json.columns || []).every((c) => !('report_id' in c)));
  const ov = await call('GET', `/api/admin/permissions/overview?subjectType=user&subjectId=${U['100317']}`, { cookie: A });
  ok('Yetki icmalında hesabat ID-ləri UUID-dir', ov.status === 200 && ov.json.every((o) => UUID.test(o.report_id)));
  // köhnə ardıcıl nömrələr və EMPID artıq işləmir
  for (const [m, p] of [['GET', '/api/admin/reports/1'], ['GET', '/api/reports/1/meta'], ['PUT', `/api/admin/users/100317`], ['DELETE', '/api/admin/groups/1'], ['DELETE', '/api/admin/positions/1']]) {
    const r = await call(m, p, { cookie: A, body: m === 'PUT' ? { name: 'x' } : undefined });
    ok(`Ardıcıl nömrə/EMPID ilə ${m} ${p} → 404`, r.status === 404, String(r.status));
  }
  const ef = await call('GET', `/api/admin/effective?empid=100317&reportId=${reports[0].id}`, { cookie: A });
  ok('/effective EMPID ilə işləmir', ef.status === 404, String(ef.status));
  const ef2 = await call('GET', `/api/admin/effective?userId=${U['100317']}&reportId=${reports[0].id}`, { cookie: A });
  ok('/effective UUID ilə işləyir', ef2.status === 200, String(ef2.status));
  // başqa növün UUID-si qəbul olunmur (hesabat UUID-si istifadəçi yerinə)
  const x = await call('PUT', `/api/admin/users/${reports[0].id}`, { cookie: A, body: { name: 'x' } });
  ok('Hesabat UUID-si istifadəçi marşrutunda işləmir', x.status === 404, String(x.status));
  // eyni UUID böyük hərflə də eyni obyektə çatır, SQL injection yoxdur
  const up = await call('GET', `/api/admin/reports/${reports[0].id.toUpperCase()}`, { cookie: A });
  ok('Böyük hərfli UUID səhv 500 vermir', up.status < 500, String(up.status));
  const inj = await call('GET', `/api/admin/reports/${encodeURIComponent(reports[0].id + "' OR '1'='1")}`, { cookie: A });
  ok('UUID-yə əlavə SQL → 404', inj.status === 404, String(inj.status));
}

// ---------- 11c. Avtomatik blok ----------
sec('Avtomatik blok (qanunsuz cəhd)');
{
  const A = sessions['100001'];
  const today = new Date().toISOString().slice(0, 10);
  // 1) Adi istifadəçi admin marşrutuna əllə sorğu göndərir
  let c = await fresh('100236');
  const r1 = await call('GET', '/api/admin/users', { cookie: c });
  ok('Yetkisiz admin marşrutu → 403 və blok mesajı', r1.status === 403 && /bloklandı/.test(r1.json?.error || ''), `${r1.status} ${r1.json?.error}`);
  const me = await call('GET', '/api/me', { cookie: c });
  ok('Bloklanandan sonra köhnə sessiya bağlanır (401)', me.status === 401, String(me.status));
  const lw = await call('POST', '/api/auth/login', { body: { empid: '100236', password: 'yanlis-parol' } });
  ok('Yanlış parolla blok bilinmir (ümumi 401)', lw.status === 401, String(lw.status));
  const lb = await call('POST', '/api/auth/login', { body: { empid: '100236', password: PW } });
  ok('Düzgün parolla da giriş bağlıdır (403 bloklanıb)', lb.status === 403 && /bloklandı/.test(lb.json?.error || ''), `${lb.status} ${lb.json?.error}`);
  let rows = await auditRows();
  const ev = rows.find((r) => r.action === 'security.block' && r.empid === '100236');
  ok('Jurnalda security.block yazısı var', !!ev);
  ok('Jurnal nə etmək istədiyini göstərir (növ, yol, IP)', ev?.detail?.kind === 'admin_route' && /\/api\/admin\/users/.test(ev.detail.path || '') && !!ev.detail.ip && !!ev.detail.what, JSON.stringify(ev?.detail));
  const ul = (await call('GET', '/api/admin/users', { cookie: A })).json || [];
  const row = ul.find((u) => u.empid === '100236');
  ok('Admin siyahısında bloklu və səbəb görünür', !!row?.blocked_at && !!row?.blocked_reason, JSON.stringify(row));
  // 2) Dəstək hesabı blokdan çıxara bilmir (yalnız admin)
  const sup = await fresh('100002');
  const un = await call('POST', `/api/admin/users/${U['100236']}/unblock`, { cookie: sup, body: {} });
  ok('Dəstək blokdan çıxara bilmir', un.status === 403, String(un.status));
  const still = await call('POST', '/api/auth/login', { body: { empid: '100236', password: PW } });
  ok('Bloklu istifadəçi hələ də bloklu qalır', still.status === 403, String(still.status));
  // 3) Admin blokdan çıxarır
  const ub = await call('POST', `/api/admin/users/${U['100236']}/unblock`, { cookie: A, body: {} });
  ok('Admin blokdan çıxarır', ub.status === 200, String(ub.status));
  const ub2 = await call('POST', `/api/admin/users/${U['100236']}/unblock`, { cookie: A, body: {} });
  ok('Bloklu olmayanı çıxarmaq 400', ub2.status === 400, String(ub2.status));
  const back = await login('100236');
  ok('Blokdan çıxandan sonra giriş işləyir', back.r.status === 200, String(back.r.status));
  ok('Blokdan çıxarma jurnala yazılır', (await auditRows()).some((r) => r.action === 'security.unblock' && r.detail?.empid === '100236'));

  // 4) Dəstək hesabı qadağan SQL yazır
  c = await fresh('100002');
  const sq = await call('POST', '/api/admin/reports/test', { cookie: c, body: { sql: 'delete from demo.satis' } });
  ok('Qadağan SQL (delete) yazan dəstək bloklanır', sq.status === 403 && /bloklandı/.test(sq.json?.error || ''), `${sq.status} ${sq.json?.error}`);
  rows = await auditRows();
  const sev = rows.find((r) => r.action === 'security.block' && r.empid === '100002');
  ok('Jurnal yazılmış SQL-i göstərir', sev?.detail?.kind === 'dangerous_sql' && /delete from demo\.satis/.test(sev.detail.sample || ''), JSON.stringify(sev?.detail));
  await fresh('100002');

  // 5) Admin bloklanmır, amma jurnala yazılır və əsl səbəbi görür
  const ad = await call('POST', '/api/admin/reports/test', { cookie: A, body: { sql: 'delete from demo.satis' } });
  ok('Admin qadağan SQL yazanda bloklanmır, əsl səbəb görür', ad.status === 400 && /SELECT|Qadağan/.test(ad.json?.error || ''), `${ad.status} ${ad.json?.error}`);
  const adMe = await call('GET', '/api/me', { cookie: A });
  ok('Admin sessiyası davam edir', adMe.status === 200, String(adMe.status));
  ok('Admin pozuntusu jurnalda var (security.violation)', (await auditRows()).some((r) => r.action === 'security.violation' && r.empid === '100001'));

  // 6) Parametrdə injection → blok; adi mətn → blok yox
  c = await fresh('100317');
  const lst = (await call('GET', '/api/reports', { cookie: c })).json || [];
  const rid = lst[0]?.id;
  for (const ok_ of ["O'Brien", 'Əliyev; Həsən', 'a-b_c 12', '50% endirim', 'Bakı (mərkəz)']) {
    const r = await call('POST', `/api/reports/${rid}/run`, { cookie: c, body: { params: { tarix_bas: '2025-01-01', tarix_son: today, filial: ok_ } } });
    ok(`Adi mətn bloklamır: «${ok_}»`, r.status !== 403, String(r.status));
  }
  const m2 = await call('GET', '/api/me', { cookie: c });
  ok('Adi mətndən sonra istifadəçi bloklanmayıb', m2.status === 200, String(m2.status));
  const inj = await call('POST', `/api/reports/${rid}/run`, { cookie: c, body: { params: { tarix_bas: '2025-01-01', tarix_son: today, filial: "x' UNION SELECT 1 --" } } });
  ok('Parametrdə UNION SELECT → blok', inj.status === 403 && /bloklandı/.test(inj.json?.error || ''), `${inj.status} ${inj.json?.error}`);
  const injRow = (await auditRows()).find((r) => r.action === 'security.block' && r.empid === '100317');
  ok('Jurnal injection dəyərini göstərir', injRow?.detail?.kind === 'injection_param' && /UNION/i.test(injRow.detail.sample || ''), JSON.stringify(injRow?.detail));
  c = await fresh('100317');

  // 7) Yanlış formatlı ID → blok; düzgün formatlı, amma mövcud olmayan UUID → yalnız 404
  const ghost = await call('GET', '/api/reports/00000000-0000-4000-8000-000000000000/meta', { cookie: c });
  ok('Mövcud olmayan (düzgün formatlı) UUID → 404, blok yox', ghost.status === 404, String(ghost.status));
  ok('...və istifadəçi bloklanmayıb', (await call('GET', '/api/me', { cookie: c })).status === 200);
  const bad = await call('GET', '/api/reports/123/meta', { cookie: c });
  ok('Yanlış formatlı ID → blok (403)', bad.status === 403, String(bad.status));
  const badAudit = (await auditRows()).find((r) => r.action === 'security.block' && r.empid === '100317');
  ok('Jurnalda bad_id və göndərilən dəyər', badAudit?.detail?.kind === 'bad_id' && badAudit.detail.sample === '123', JSON.stringify(badAudit?.detail));
  await fresh('100317');

  // 8) Saxta token və CSRF: kimin adından olduğu bilinmir, heç kəs bloklanmır, yalnız jurnal
  const xf = { 'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 200) + 1}` }; // hər test üçün ayrı IP: jurnal sürət limitinə düşməsin
  const bt = await call('GET', '/api/me', { cookie: 'token=abc.def.ghi', headers: xf });
  ok('Saxta token → 401', bt.status === 401, String(bt.status));
  const cs = await call('POST', '/api/auth/login', { headers: { Origin: 'https://evil.example', 'X-Forwarded-For': `198.51.100.${Math.floor(Math.random() * 200) + 1}` }, body: { empid: 'x', password: 'y' } });
  ok('Başqa saytdan sorğu → 403', cs.status === 403, String(cs.status));
  rows = await auditRows();
  ok('Saxta token jurnalda (security.anon, bad_token)', rows.some((r) => r.action === 'security.anon' && r.detail?.kind === 'bad_token'));
  ok('CSRF cəhdi jurnalda (security.anon, csrf)', rows.some((r) => r.action === 'security.anon' && r.detail?.kind === 'csrf'));
  for (const e of ['100236', '100002', '100317']) await fresh(e);
}

// ---------- 12. Fayl və yol sızması ----------
sec('Mənbə fayllarının sızması');
for (const p of ['/server/api.js', '/server/index.js', '/package.json', '/.git/config', '/../server/auth.js', '/%2e%2e/server/auth.js', '/..%2fserver%2fauth.js', '/.env', '/render.yaml', '/node_modules/']) {
  const r = await call('GET', p);
  const leaked = /import express|jsonwebtoken|DATABASE_URL|\[core\]|"dependencies"/.test(r.text);
  ok(`Fayl sızmır: ${p}`, !leaked && r.status < 500, `${r.status}`);
}

console.log(`\n==== NƏTİCƏ: ${pass} keçdi, ${fails.length} uğursuz ====`);
for (const f of fails) console.log(' ✗ ' + f);
process.exit(fails.length ? 1 : 0);
