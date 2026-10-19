import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { makeGate, makeLimiter, appOnly } from './security.js';
import { login, logout, requireAuth, needCap, needAdmin, audit, publicUser, ALL_CAPS } from './auth.js';
import { reportsFor, effective, visibleColumns } from './perms.js';
import { publicConns, loadConn, saveConn, deleteConn, cleanConfig, testSql } from './connections.js';
import { testAd } from './ldap.js';
import { analyze, slug } from './sqlparse.js';
import { keyOf, keyOrNull, keysOf } from './ids.js';
import { violation, looksLikeInjection } from './guard.js';
import { GuardError } from './errors.js';
import { runForUser, runDetailForUser, runTest, runOptions, detectParams, guardAuto, HttpError } from './runner.js';

// Xətalar burada tutulur. Qanunsuz cəhd (yanlış formatlı ID, görünməyən dəyər, admin ekranında zərərli SQL)
// aşkarlananda istifadəçi dərhal bloklanır və nə etmək istədiyi jurnala yazılır.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(async (e) => {
  if (req.user) {
    if (e?.violation) e = await violation(req, e.violation.kind, e.violation.what, e.violation.sample, e);
    else if (e instanceof GuardError && String(req.originalUrl).startsWith('/api/admin/')) {
      // Yalnız admin ekranında yazılan SQL. İcra zamanı saxlanmış hesabatın SQL-i istifadəçiyə aid deyil.
      e = await violation(req, 'dangerous_sql', `Qadağan SQL yazmağa cəhd: ${e.message}`, req.body?.sql ?? req.body?.drill?.sql, e);
    }
  }
  next(e);
});

// Hesabata yetkisi olmayan istifadəçiyə ekran bu hesabatı göstərmir. Yenə də sorğu gəlirsə, əllə göndərilib.
const denyReport = (req, report, what) =>
  violation(req, 'report_access', `${what}: ${report.code}`, undefined, new HttpError(403, 'Bu hesabata yetkiniz yoxdur'));

// Parametr və detal dəyərində açıq SQL injection əlaməti
async function scanInjection(req, values) {
  for (const [name, v] of Object.entries(values)) {
    if (looksLikeInjection(v)) throw await violation(req, 'injection_param', `Parametrdə SQL injection əlaməti: ${name}`, v, new HttpError(400, 'Parametr dəyəri yanlışdır'));
  }
}
export const api = express.Router();

// Giriş ekranı üçün (autentifikasiyasız): portal yalnız tətbiq kimi açılırmı
api.get('/app-config', (_req, res) => res.json({ appOnly: appOnly() }));

api.post('/auth/login', wrap(login));
api.post('/auth/logout', logout);

api.use(wrap(requireAuth));

api.get('/me', (req, res) => res.json(req.user));

// ---------- İstifadəçi ekranı ----------
api.get('/reports', wrap(async (req, res) => res.json(await reportsFor(req.user.empid))));

async function loadReport(id) {
  const key = await keyOf('report', id).catch((e) => { throw e.violation ? e : new HttpError(404, 'Hesabat tapılmadı'); });
  const r = await pool.query('SELECT * FROM portal.reports WHERE id = $1 AND active', [key]);
  if (!r.rows[0]) throw new HttpError(404, 'Hesabat tapılmadı');
  return r.rows[0];
}

api.get('/reports/:id/meta', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const perm = await effective(req.user.empid, report.id);
  if (!perm.allowed) throw await denyReport(req, report, 'Yetkisiz hesabatın məlumatını istədi');
  const rcols = (await pool.query(
    'SELECT * FROM portal.report_columns WHERE report_id = $1 ORDER BY pos, code', [report.id])).rows;
  const vis = visibleColumns(perm, rcols);
  res.json({
    id: report.uid, kind: report.kind, name_az: report.name_az, name_en: report.name_en, name_ru: report.name_ru,
    description: report.description,
    params: report.params.map((p) => ({ ...p, optionsSql: undefined, hasOptions: !!p.optionsSql })),
    columns: vis.map((c) => ({
      code: c.code, label_az: c.label_az, label_en: c.label_en, label_ru: c.label_ru, type: c.type, masked: c.masked,
    })),
    drill: report.drill?.sql && vis.some((c) => c.code === report.drill.column && !c.masked) ? { column: report.drill.column } : null,
    hiddenCount: rcols.length - vis.length,
    restricted: perm.rules.length > 0,
    canExport: perm.canExport,
  });
}));

api.get('/reports/:id/options/:param', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const perm = await effective(req.user.empid, report.id);
  if (!perm.allowed) throw await denyReport(req, report, 'Yetkisiz hesabatın siyahısını istədi');
  const p = report.params.find((x) => x.name === req.params.param);
  if (!p?.optionsSql) throw new HttpError(404, 'Siyahı yoxdur');
  try {
    res.json(await runOptions(p.optionsSql));
  } catch (e) {
    console.error('Siyahı xətası:', e.message);
    throw new HttpError(400, 'Siyahı yüklənmədi');
  }
}));

// Hesabat icrası: istifadəçi başına dəqiqədə 30, eyni anda ən çox 2; serverdə ümumi 4 paralel icra.
const runLimiter = makeLimiter({ windowMs: 60_000, max: Number(process.env.RUN_RATE_PER_MIN) || 30 });
const runGate = makeGate({ max: Number(process.env.RUN_CONCURRENCY) || 4, maxQueue: 500, waitMs: 30_000 });
const userActive = new Map();

// İcra üçün ortaq qayda: yetki əvvəl, parametr yoxlaması, sürət və paralel limit.
async function limitedRun(req, report, fn) {
  // Yetki ilk yoxlanır: yetkisiz istifadəçi hesabatın parametrlərini belə görməsin
  if (!(await effective(req.user.empid, report.id)).allowed) throw await denyReport(req, report, 'Yetkisiz hesabatı icra etməyə cəhd');
  const given = req.body?.params || {};
  const params = {};
  for (const p of report.params) {
    const v = given[p.name];
    if (p.required && (v === undefined || v === '' || v === null)) {
      throw new HttpError(400, `Parametr məcburidir: ${p.label || p.name}`);
    }
    if (v !== undefined && v !== null && (typeof v === 'object' || String(v).length > 500)) {
      throw new HttpError(400, `Parametr dəyəri yanlışdır: ${p.label || p.name}`);
    }
    params[p.name] = v;
  }
  // Ekranın göndərmədiyi sahələr də daxil olmaqla, gələn bütün parametr dəyərləri yoxlanır
  await scanInjection(req, { ...(typeof given === 'object' ? given : {}), ...(typeof req.body?.key === 'string' ? { key: req.body.key } : {}) });
  if (runLimiter.hit(req.user.empid)) throw new HttpError(429, 'Çox sorğu. Bir az gözləyin.');
  if ((userActive.get(req.user.empid) || 0) >= 2) throw new HttpError(429, 'Əvvəlki sorğularınız hələ işləyir.');
  userActive.set(req.user.empid, (userActive.get(req.user.empid) || 0) + 1);
  let out;
  try {
    out = await runGate.run(() => fn(params));
  } finally {
    const n = (userActive.get(req.user.empid) || 1) - 1;
    if (n <= 0) userActive.delete(req.user.empid); else userActive.set(req.user.empid, n);
  }
  return { out, params };
}

api.post('/reports/:id/run', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const { out, params } = await limitedRun(req, report, (p) => runForUser(req.user.empid, report, p));
  await audit(req.user.empid, 'run', { report: report.code, rows: out.rows.length, ms: out.ms, params });
  res.json(out);
}));

// Detal pəncərəsi: basılan dəyər + əsas hesabatın parametrləri
api.post('/reports/:id/detail', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  if (!report.drill?.sql) throw new HttpError(404, 'Detal yoxdur');
  const key = req.body?.key;
  const { out, params } = await limitedRun(req, report, (p) => runDetailForUser(req.user.empid, report, p, key));
  await audit(req.user.empid, 'detail', { report: report.code, rows: out.rows.length, ms: out.ms, key: String(key).slice(0, 100), params });
  res.json(out);
}));

api.post('/reports/:id/export-log', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const perm = await effective(req.user.empid, report.id);
  if (!perm.canExport) throw await denyReport(req, report, 'Export yetkisi olmadan export bildirişi göndərdi');
  await audit(req.user.empid, 'export', { report: report.code, rows: req.body?.rows ?? null });
  res.json({ ok: true });
}));

// ---------- Admin: hesabatlar ----------
const admin = express.Router();
api.use('/admin', admin);

admin.get('/categories', needCap('reports', 'permissions'), wrap(async (_req, res) => {
  res.json((await pool.query('SELECT uid AS id, name_az, name_en, name_ru FROM portal.report_categories ORDER BY id')).rows);
}));
admin.post('/categories', needCap('reports'), wrap(async (req, res) => {
  const { name_az, name_en, name_ru } = req.body || {};
  if (!name_az) throw new HttpError(400, 'Ad lazımdır');
  const r = await pool.query(
    'INSERT INTO portal.report_categories (name_az,name_en,name_ru) VALUES ($1,$2,$3) RETURNING uid AS id, name_az, name_en, name_ru',
    [name_az, name_en || name_az, name_ru || name_az]);
  res.json(r.rows[0]);
}));

admin.get('/reports', needCap('reports', 'permissions'), wrap(async (_req, res) => {
  const r = await pool.query(
    `SELECT r.uid AS id, r.code, r.kind, r.name_az, r.name_en, r.name_ru, r.active, r.version,
            (SELECT c.uid FROM portal.report_categories c WHERE c.id = r.category_id) AS category_id,
            (SELECT count(*)::int FROM portal.report_columns c WHERE c.report_id = r.id) AS columns
     FROM portal.reports r ORDER BY r.category_id NULLS LAST, r.name_az`);
  res.json(r.rows);
}));

admin.get('/reports/:id', needCap('reports', 'permissions'), wrap(async (req, res) => {
  const key = await keyOf('report', req.params.id);
  const row = (await pool.query('SELECT * FROM portal.reports WHERE id = $1', [key])).rows[0];
  const cat = row.category_id ? (await pool.query('SELECT uid FROM portal.report_categories WHERE id = $1', [row.category_id])).rows[0] : null;
  const cols = await pool.query('SELECT * FROM portal.report_columns WHERE report_id = $1 ORDER BY pos, code', [key]);
  const ver = await pool.query(
    `SELECT v.version, v.changed_by, u.name AS changed_name, v.changed_at
     FROM portal.report_versions v LEFT JOIN portal.users u ON u.empid = v.changed_by
     WHERE v.report_id = $1 ORDER BY v.version DESC LIMIT 20`, [key]);
  res.json({
    ...row, id: row.uid, uid: undefined, category_id: cat?.uid ?? null,
    columns: cols.rows.map(({ report_id, ...c }) => c), versions: ver.rows,
  });
}));

admin.post('/reports/detect', needCap('reports'), wrap(async (req, res) => {
  res.json({ params: detectParams(req.body?.sql) });
}));

// SQL-dən sütun kodu/adı və parametr adı/tipi avtomatik çıxarılır.
admin.post('/reports/analyze', needCap('reports'), wrap(async (req, res) => {
  const known = Array.isArray(req.body?.known) ? req.body.known : [];
  const rc = Array.isArray(req.body?.columns) ? req.body.columns : null;
  const a = analyze(String(req.body?.sql || ''), rc, known);
  res.json({ ...a, detected: detectParams(req.body?.sql) });
}));

admin.post('/reports/test', needCap('reports'), wrap(async (req, res) => {
  const out = await runTest(req.body?.sql, req.body?.params || {}, req.body?.types || {}, req.body?.kind);
  await audit(req.user.empid, 'test', { ms: out.ms, rows: out.rows.length });
  res.json(out);
}));

// Detal (ikinci SQL) sazlaması. Boşdursa null. Yalnız bilinən sahələr saxlanır.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const clip = (v, n) => String(v ?? '').slice(0, n);
async function cleanDrill(d, mainCodes, params) {
  if (!d || !String(d.sql || '').trim()) return null;
  if (!mainCodes.includes(d.column)) throw new HttpError(400, 'Detal üçün basılan sütun seçilməyib');
  await guardAuto(d.sql, 'query');
  const known = new Set((params || []).map((p) => p.name));
  for (const n of detectParams(d.sql)) {
    if (n !== 'deyer' && !known.has(n)) throw new HttpError(400, `Detal SQL-də naməlum parametr: @${n}`);
  }
  const cols = (Array.isArray(d.columns) ? d.columns : []).slice(0, 80);
  if (!cols.length) throw new HttpError(400, 'Detal sütunları tapılmayıb. "Sütunları götür" düyməsini basın.');
  const seen = new Set();
  return {
    column: d.column,
    sql: String(d.sql),
    columns: cols.map((c) => {
      if (!IDENT_RE.test(String(c.code || '')) || seen.has(c.code)) throw new HttpError(400, `Yanlış detal sütun kodu: ${clip(c.code, 40)}`);
      seen.add(c.code);
      return {
        code: c.code, src: c.src ? clip(c.src, 200) : null,
        label_az: clip(c.label_az || c.code, 200), label_en: clip(c.label_en || c.label_az || c.code, 200),
        label_ru: clip(c.label_ru || c.label_az || c.code, 200), type: ['text', 'number', 'date'].includes(c.type) ? c.type : 'text',
      };
    }),
  };
}

async function saveColumns(client, reportId, columns) {
  const codes = columns.map((c) => c.code);
  for (const c of codes) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) throw new HttpError(400, `Yanlış sütun kodu: ${c}`);
  }
  let i = 0;
  for (const c of columns) {
    await client.query(
      `INSERT INTO portal.report_columns (report_id,code,label_az,label_en,label_ru,type,sensitivity,pos,src)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (report_id, code) DO UPDATE SET label_az=$3,label_en=$4,label_ru=$5,type=$6,sensitivity=$7,pos=$8,src=$9`,
      [reportId, c.code, c.label_az || c.code, c.label_en || c.label_az || c.code, c.label_ru || c.label_az || c.code,
        c.type || 'text', c.sensitivity || 'normal', i++, c.src ? String(c.src).slice(0, 200) : null]);
  }
  await client.query('DELETE FROM portal.report_columns WHERE report_id = $1 AND NOT (code = ANY($2::text[]))', [reportId, codes]);
  await client.query('DELETE FROM portal.perm_column WHERE report_id = $1 AND NOT (column_code = ANY($2::text[]))', [reportId, codes]);
  await client.query('DELETE FROM portal.perm_value WHERE report_id = $1 AND NOT (column_code = ANY($2::text[]))', [reportId, codes]);
}

admin.post('/reports', needCap('reports'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name_az) throw new HttpError(400, 'Ad (AZ) lazımdır');
  // Hesabat kodu arxa fonda adından yaradılır; istifadəçi görmür, əl ilə yazılmır.
  const baseCode = (slug(b.name_az) || 'hesabat').slice(0, 50);
  let code = baseCode;
  for (let i = 2; (await pool.query('SELECT 1 FROM portal.reports WHERE code = $1', [code])).rowCount; i++) code = `${baseCode}_${i}`;
  await guardAuto(b.sql, b.kind || 'query');
  const categoryKey = await keyOrNull('category', b.category_id);
  const drill = await cleanDrill(b.drill, (b.columns || []).map((c) => c.code), b.params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO portal.reports (code,category_id,kind,name_az,name_en,name_ru,description,sql,params,updated_by,drill)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, uid`,
      [code, categoryKey, b.kind || 'query', b.name_az, b.name_en || b.name_az, b.name_ru || b.name_az,
        b.description || '', b.sql, JSON.stringify(b.params || []), req.user.empid, drill ? JSON.stringify(drill) : null]);
    const id = r.rows[0].id;
    await client.query('INSERT INTO portal.report_versions (report_id,version,sql,changed_by) VALUES ($1,1,$2,$3)',
      [id, b.sql, req.user.empid]);
    await saveColumns(client, id, b.columns || []);
    await client.query('COMMIT');
    await audit(req.user.empid, 'report.create', { code });
    res.json({ id: r.rows[0].uid });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new HttpError(400, 'Bu kodlu hesabat var');
    throw e;
  } finally {
    client.release();
  }
}));

admin.put('/reports/:id', needCap('reports'), wrap(async (req, res) => {
  const key = await keyOf('report', req.params.id);
  const b = req.body || {};
  await guardAuto(b.sql, b.kind || 'query');
  const categoryKey = await keyOrNull('category', b.category_id);
  const mainCodes = Array.isArray(b.columns)
    ? b.columns.map((c) => c.code)
    : (await pool.query('SELECT code FROM portal.report_columns WHERE report_id = $1', [key])).rows.map((r) => r.code);
  const setDrill = b.drill !== undefined; // göndərilməyibsə mövcud detal toxunulmaz qalır
  const drill = setDrill ? await cleanDrill(b.drill, mainCodes, b.params) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM portal.reports WHERE id = $1 FOR UPDATE', [key])).rows[0];
    if (!cur) throw new HttpError(404, 'Tapılmadı');
    const changed = cur.sql !== b.sql;
    const version = changed ? cur.version + 1 : cur.version;
    await client.query(
      `UPDATE portal.reports SET category_id=$2, kind=$3, name_az=$4, name_en=$5, name_ru=$6, description=$7,
         sql=$8, params=$9, active=$10, version=$11, updated_by=$12, updated_at=now(),
         drill = CASE WHEN $13::boolean THEN $14::jsonb ELSE drill END WHERE id=$1`,
      [cur.id, categoryKey, b.kind || cur.kind, b.name_az || cur.name_az, b.name_en || b.name_az,
        b.name_ru || b.name_az, b.description ?? '', b.sql, JSON.stringify(b.params || []), b.active !== false,
        version, req.user.empid, setDrill, drill ? JSON.stringify(drill) : null]);
    if (changed) {
      await client.query('INSERT INTO portal.report_versions (report_id,version,sql,changed_by) VALUES ($1,$2,$3,$4)',
        [cur.id, version, b.sql, req.user.empid]);
    }
    if (Array.isArray(b.columns)) await saveColumns(client, cur.id, b.columns);
    await client.query('COMMIT');
    await audit(req.user.empid, 'report.update', { id: cur.id, version });
    res.json({ id: cur.uid, version });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---------- Admin: yetkilər ----------
const SUBJECT_TYPES = ['position', 'group', 'user'];
// Subyekt UUID ilə gəlir; bazada vəzifə/qrup nömrəsi, istifadəçi üçün EMPID saxlanır.
async function subj(q) {
  const type = String(q.subjectType || '');
  if (!SUBJECT_TYPES.includes(type) || !q.subjectId) throw new HttpError(400, 'Subyekt yanlışdır');
  const key = await keyOf(type, String(q.subjectId));
  return [type, String(key)];
}

admin.get('/permissions', needCap('permissions'), wrap(async (req, res) => {
  const [type, id] = await subj(req.query);
  const rid = await keyOf('report', req.query.reportId);
  const grant = await pool.query(
    'SELECT can_export FROM portal.perm_report WHERE subject_type=$1 AND subject_id=$2 AND report_id=$3', [type, id, rid]);
  const cols = await pool.query(
    'SELECT column_code, mode FROM portal.perm_column WHERE subject_type=$1 AND subject_id=$2 AND report_id=$3', [type, id, rid]);
  const rules = await pool.query(
    'SELECT id, column_code, op, value FROM portal.perm_value WHERE subject_type=$1 AND subject_id=$2 AND report_id=$3 ORDER BY id',
    [type, id, rid]);
  res.json({
    granted: grant.rowCount > 0,
    canExport: !!grant.rows[0]?.can_export,
    columns: Object.fromEntries(cols.rows.map((c) => [c.column_code, c.mode])),
    rules: rules.rows.map((r) => ({ column: r.column_code, op: r.op, value: r.value })),
  });
}));

admin.get('/permissions/overview', needCap('permissions'), wrap(async (req, res) => {
  const [type, id] = await subj(req.query);
  const r = await pool.query(
    `SELECT r.uid AS report_id, p.can_export FROM portal.perm_report p JOIN portal.reports r ON r.id = p.report_id
     WHERE p.subject_type=$1 AND p.subject_id=$2`, [type, id]);
  res.json(r.rows);
}));

admin.put('/permissions', needCap('permissions'), wrap(async (req, res) => {
  const [type, id] = await subj(req.body || {});
  const b = req.body;
  const rid = await keyOf('report', b.reportId);
  const codes = (await pool.query('SELECT code FROM portal.report_columns WHERE report_id=$1', [rid])).rows.map((r) => r.code);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM portal.perm_report WHERE subject_type=$1 AND subject_id=$2 AND report_id=$3', [type, id, rid]);
    await client.query('DELETE FROM portal.perm_column WHERE subject_type=$1 AND subject_id=$2 AND report_id=$3', [type, id, rid]);
    await client.query('DELETE FROM portal.perm_value WHERE subject_type=$1 AND subject_id=$2 AND report_id=$3', [type, id, rid]);
    if (b.granted) {
      await client.query('INSERT INTO portal.perm_report VALUES ($1,$2,$3,$4)', [type, id, rid, !!b.canExport]);
    }
    for (const [code, mode] of Object.entries(b.columns || {})) {
      if (!codes.includes(code) || !['show', 'mask', 'hide'].includes(mode)) continue;
      await client.query('INSERT INTO portal.perm_column VALUES ($1,$2,$3,$4,$5)', [type, id, rid, code, mode]);
    }
    for (const r of b.rules || []) {
      if (!codes.includes(r.column) || !['in', 'eq', 'gte', 'lte'].includes(r.op)) continue;
      await client.query(
        'INSERT INTO portal.perm_value (subject_type,subject_id,report_id,column_code,op,value) VALUES ($1,$2,$3,$4,$5,$6)',
        [type, id, rid, r.column, r.op, JSON.stringify(r.value)]);
    }
    await client.query('COMMIT');
    await audit(req.user.empid, 'perm.update', { subject: `${type}:${id}`, report: rid });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

admin.get('/effective', needCap('permissions'), wrap(async (req, res) => {
  const empid = await keyOf('user', req.query.userId);
  const rid = await keyOf('report', req.query.reportId);
  const perm = await effective(empid, rid);
  const names = {};
  for (const r of (await pool.query('SELECT id, name FROM portal.positions')).rows) names[`position:${r.id}`] = r.name;
  for (const r of (await pool.query('SELECT id, name FROM portal.groups')).rows) names[`group:${r.id}`] = r.name;
  names[`user:${empid}`] = 'Şəxsi';
  const label = (s) => names[`${s.type}:${s.id}`] || s.id;
  const cols = (await pool.query('SELECT code, label_az FROM portal.report_columns WHERE report_id=$1 ORDER BY pos', [rid])).rows;
  res.json({
    allowed: perm.allowed,
    canExport: perm.canExport,
    columns: cols.map((c) => ({
      code: c.code, label: c.label_az,
      result: perm.columns[c.code] || 'hide',
      sources: (perm.sources[c.code] || []).map((s) => ({ from: label(s), mode: s.mode })),
    })),
    rules: perm.rules.map((r) => ({ column: r.column, op: r.op, value: r.value, from: label(r.subject) })),
  });
}));

// ---------- Admin: struktur və istifadəçilər ----------
admin.get('/subjects', needCap('permissions', 'users'), wrap(async (_req, res) => {
  const positions = (await pool.query(
    `SELECT p.uid AS id, p.name, (SELECT pp.uid FROM portal.positions pp WHERE pp.id = p.parent_id) AS parent_id, (SELECT count(*)::int FROM portal.users u WHERE u.position_id = p.id AND u.active) AS members
     FROM portal.positions p ORDER BY p.parent_id NULLS FIRST, p.name`)).rows;
  const groups = (await pool.query(
    `SELECT g.uid AS id, g.name, (SELECT count(*)::int FROM portal.user_groups ug WHERE ug.group_id = g.id) AS members
     FROM portal.groups g ORDER BY g.name`)).rows;
  const users = (await pool.query(
    `SELECT u.uid AS id, u.empid, u.name, (SELECT p.uid FROM portal.positions p WHERE p.id = u.position_id) AS position_id,
            u.role, u.active FROM portal.users u ORDER BY u.name`)).rows;
  res.json({ positions, groups, users });
}));

admin.get('/users', needCap('users'), wrap(async (_req, res) => {
  const r = await pool.query(
    `SELECT u.uid AS id, u.empid, u.name, u.role, u.caps, u.blocked_at, u.blocked_reason,
            (SELECT p.uid FROM portal.positions p WHERE p.id = u.position_id) AS position_id, u.active,
            COALESCE((SELECT array_agg(g.uid::text) FROM portal.user_groups ug JOIN portal.groups g ON g.id = ug.group_id
                      WHERE ug.empid = u.empid), '{}') AS groups
     FROM portal.users u ORDER BY u.name`);
  res.json(r.rows);
}));

async function setGroups(client, empid, groups) {
  const keys = await keysOf('group', groups, client);
  await client.query('DELETE FROM portal.user_groups WHERE empid = $1', [empid]);
  for (const g of keys) await client.query('INSERT INTO portal.user_groups VALUES ($1,$2) ON CONFLICT DO NOTHING', [empid, g]);
}

admin.post('/users', needCap('users'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!/^[A-Za-z0-9_.-]{2,30}$/.test(b.empid || '')) throw new HttpError(400, 'EMPID yanlışdır');
  if (!b.name) throw new HttpError(400, 'Ad lazımdır');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128) throw new HttpError(400, 'Parol 8-128 simvol olmalıdır');
  const isAdmin = req.user.role === 'admin';
  const positionKey = await keyOrNull('position', b.position_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO portal.users (empid,name,password_hash,role,caps,position_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [b.empid, b.name, bcrypt.hashSync(b.password, 10), isAdmin ? b.role || 'user' : 'user',
        isAdmin ? (Array.isArray(b.caps) ? b.caps : []).filter((c) => ALL_CAPS.includes(c)) : [], positionKey]);
    await setGroups(client, b.empid, b.groups);
    await client.query('COMMIT');
    await audit(req.user.empid, 'user.create', { empid: b.empid });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new HttpError(400, 'Bu EMPID var');
    throw e;
  } finally {
    client.release();
  }
}));

admin.put('/users/:id', needCap('users'), wrap(async (req, res) => {
  const b = req.body || {};
  const isAdmin = req.user.role === 'admin';
  const targetEmpid = await keyOf('user', req.params.id);
  const positionKey = b.position_id === undefined ? undefined : await keyOrNull('position', b.position_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM portal.users WHERE empid=$1 FOR UPDATE', [targetEmpid])).rows[0];
    if (!cur) throw new HttpError(404, 'İstifadəçi tapılmadı');
    if (!isAdmin && cur.role !== 'user') throw new HttpError(403, 'Dəstək hesabını yalnız admin dəyişir');
    const role = isAdmin ? b.role || cur.role : cur.role;
    const caps = isAdmin ? (Array.isArray(b.caps) ? b.caps : cur.caps).filter((c) => ALL_CAPS.includes(c)) : cur.caps;
    if (targetEmpid === req.user.empid && (b.active === false || role !== 'admin') && cur.role === 'admin') {
      throw new HttpError(400, 'Öz admin yetkinizi götürə bilməzsiniz');
    }
    await client.query(
      'UPDATE portal.users SET name=$2, role=$3, caps=$4, position_id=$5, active=$6 WHERE empid=$1',
      [cur.empid, b.name || cur.name, role, caps, positionKey === undefined ? cur.position_id : positionKey,
        b.active === undefined ? cur.active : !!b.active]);
    // Parol, rol, yetki və ya aktivlik dəyişəndə köhnə sessiyalar bağlanır
    if (b.password || role !== cur.role || b.active === false || JSON.stringify(caps) !== JSON.stringify(cur.caps)) {
      await client.query('UPDATE portal.users SET session_epoch = session_epoch + 1 WHERE empid=$1', [cur.empid]);
    }
    if (b.password) {
      if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128) throw new HttpError(400, 'Parol 8-128 simvol olmalıdır');
      await client.query('UPDATE portal.users SET password_hash=$2 WHERE empid=$1', [cur.empid, bcrypt.hashSync(b.password, 10)]);
    }
    if (Array.isArray(b.groups)) await setGroups(client, cur.empid, b.groups);
    await client.query('COMMIT');
    await audit(req.user.empid, 'user.update', { empid: cur.empid, role, caps });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Avtomatik blokdan yalnız admin çıxara bilər
admin.post('/users/:id/unblock', needAdmin, wrap(async (req, res) => {
  const empid = await keyOf('user', req.params.id);
  const r = await pool.query(
    'UPDATE portal.users SET blocked_at = NULL, blocked_reason = NULL WHERE empid = $1 AND blocked_at IS NOT NULL RETURNING empid', [empid]);
  if (!r.rowCount) throw new HttpError(400, 'İstifadəçi bloklanmayıb');
  await audit(req.user.empid, 'security.unblock', { empid });
  res.json({ ok: true });
}));

admin.post('/positions', needCap('users'), wrap(async (req, res) => {
  const { name, parent_id } = req.body || {};
  if (!name) throw new HttpError(400, 'Ad lazımdır');
  const parentKey = await keyOrNull('position', parent_id);
  const r = await pool.query('INSERT INTO portal.positions (name,parent_id) VALUES ($1,$2) RETURNING uid AS id, name', [name, parentKey]);
  res.json({ ...r.rows[0], parent_id: parent_id || null });
}));
admin.delete('/positions/:id', needCap('users'), wrap(async (req, res) => {
  const key = String(await keyOf('position', req.params.id));
  await pool.query('DELETE FROM portal.positions WHERE id=$1', [key]);
  await pool.query(`DELETE FROM portal.perm_report WHERE subject_type='position' AND subject_id=$1`, [key]);
  await pool.query(`DELETE FROM portal.perm_column WHERE subject_type='position' AND subject_id=$1`, [key]);
  await pool.query(`DELETE FROM portal.perm_value WHERE subject_type='position' AND subject_id=$1`, [key]);
  res.json({ ok: true });
}));
admin.post('/groups', needCap('users'), wrap(async (req, res) => {
  if (!req.body?.name) throw new HttpError(400, 'Ad lazımdır');
  const r = await pool.query('INSERT INTO portal.groups (name) VALUES ($1) RETURNING uid AS id, name', [req.body.name]);
  res.json(r.rows[0]);
}));
admin.delete('/groups/:id', needCap('users'), wrap(async (req, res) => {
  const key = String(await keyOf('group', req.params.id));
  await pool.query('DELETE FROM portal.groups WHERE id=$1', [key]);
  await pool.query(`DELETE FROM portal.perm_report WHERE subject_type='group' AND subject_id=$1`, [key]);
  await pool.query(`DELETE FROM portal.perm_column WHERE subject_type='group' AND subject_id=$1`, [key]);
  await pool.query(`DELETE FROM portal.perm_value WHERE subject_type='group' AND subject_id=$1`, [key]);
  res.json({ ok: true });
}));

// ---------- Bağlantılar (yalnız admin) ----------
const connKind = (req) => {
  if (!['sql', 'ldap'].includes(req.params.kind)) throw new HttpError(404, 'Naməlum bağlantı');
  return req.params.kind;
};

async function testConn(kind, body) {
  const config = cleanConfig(kind, body?.config);
  const stored = await loadConn(kind).catch(() => null);
  const password = body?.password || stored?.password || '';
  if (kind === 'sql') return { config, password, result: await testSql(config, password) };
  return { config, password, result: await testAd(config, String(body?.testLogin || '').trim(), String(body?.testPassword || '')) };
}

admin.get('/connections', needAdmin, wrap(async (_req, res) => res.json(await publicConns())));

admin.post('/connections/:kind/test', needAdmin, wrap(async (req, res) => {
  const kind = connKind(req);
  let out;
  try {
    out = (await testConn(kind, req.body)).result;
  } catch (e) {
    if (e instanceof HttpError && e.status >= 500) throw e;
    out = { ok: false, error: e.message, steps: kind === 'ldap' ? [{ step: 'connect', ok: false, error: e.message }] : undefined };
  }
  await audit(req.user.empid, 'conn_test', { kind, ok: out.ok });
  res.json(out);
}));

// Aktiv etməzdən əvvəl server özü yoxlayır: səhv məlumat girişi və ya hesabatları bağlamasın.
admin.put('/connections/:kind', needAdmin, wrap(async (req, res) => {
  const kind = connKind(req);
  const enabled = !!req.body?.enabled;
  const { config, password, result } = await testConn(kind, req.body);
  if (enabled && !result.ok) throw new HttpError(400, 'Test uğursuzdur, aktiv etmək olmaz. Əvvəlcə "Test" edin.');
  await saveConn(kind, config, req.body?.password || '', enabled, req.user.empid);
  await audit(req.user.empid, 'conn_save', { kind, enabled, host: config.host });
  void password;
  res.json({ ok: true, warnings: result.warnings || [] });
}));

admin.delete('/connections/:kind', needAdmin, wrap(async (req, res) => {
  const kind = connKind(req);
  await deleteConn(kind);
  await audit(req.user.empid, 'conn_delete', { kind });
  res.json({ ok: true });
}));

admin.get('/audit', needCap('audit'), wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const r = await pool.query(
    `SELECT a.at, a.empid, u.name, a.action, a.detail
     FROM portal.audit_log a LEFT JOIN portal.users u ON u.empid = a.empid
     ORDER BY a.id DESC LIMIT $1`, [limit]);
  res.json(r.rows);
}));

export { needAdmin, publicUser };
