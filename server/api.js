import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { login, logout, requireAuth, needCap, needAdmin, audit, publicUser, ALL_CAPS } from './auth.js';
import { reportsFor, effective, visibleColumns } from './perms.js';
import { publicConns, loadConn, saveConn, deleteConn, cleanConfig, testSql } from './connections.js';
import { testLdap } from './ldap.js';
import { analyze, slug } from './sqlparse.js';
import { runForUser, runTest, runOptions, detectParams, guardAuto, HttpError } from './runner.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const api = express.Router();

api.post('/auth/login', wrap(login));
api.post('/auth/logout', logout);

api.use(wrap(requireAuth));

api.get('/me', (req, res) => res.json(req.user));

// ---------- İstifadəçi ekranı ----------
api.get('/reports', wrap(async (req, res) => res.json(await reportsFor(req.user.empid))));

async function loadReport(id) {
  const r = await pool.query('SELECT * FROM portal.reports WHERE id = $1 AND active', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Hesabat tapılmadı');
  return r.rows[0];
}

api.get('/reports/:id/meta', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const perm = await effective(req.user.empid, report.id);
  if (!perm.allowed) throw new HttpError(403, 'Bu hesabata yetkiniz yoxdur');
  const rcols = (await pool.query(
    'SELECT * FROM portal.report_columns WHERE report_id = $1 ORDER BY pos, code', [report.id])).rows;
  const vis = visibleColumns(perm, rcols);
  res.json({
    id: report.id, kind: report.kind, name_az: report.name_az, name_en: report.name_en, name_ru: report.name_ru,
    description: report.description,
    params: report.params.map((p) => ({ ...p, optionsSql: undefined, hasOptions: !!p.optionsSql })),
    columns: vis.map((c) => ({
      code: c.code, label_az: c.label_az, label_en: c.label_en, label_ru: c.label_ru, type: c.type, masked: c.masked,
    })),
    hiddenCount: rcols.length - vis.length,
    restricted: perm.rules.length > 0,
    canExport: perm.canExport,
  });
}));

api.get('/reports/:id/options/:param', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const perm = await effective(req.user.empid, report.id);
  if (!perm.allowed) throw new HttpError(403, 'Bu hesabata yetkiniz yoxdur');
  const p = report.params.find((x) => x.name === req.params.param);
  if (!p?.optionsSql) throw new HttpError(404, 'Siyahı yoxdur');
  res.json(await runOptions(p.optionsSql));
}));

api.post('/reports/:id/run', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const given = req.body?.params || {};
  const params = {};
  for (const p of report.params) {
    const v = given[p.name];
    if (p.required && (v === undefined || v === '' || v === null)) {
      throw new HttpError(400, `Parametr məcburidir: ${p.label || p.name}`);
    }
    params[p.name] = v;
  }
  const out = await runForUser(req.user.empid, report, params);
  await audit(req.user.empid, 'run', { report: report.code, rows: out.rows.length, ms: out.ms, params });
  res.json(out);
}));

api.post('/reports/:id/export-log', wrap(async (req, res) => {
  const report = await loadReport(req.params.id);
  const perm = await effective(req.user.empid, report.id);
  if (!perm.canExport) throw new HttpError(403, 'Export üçün yetkiniz yoxdur');
  await audit(req.user.empid, 'export', { report: report.code, rows: req.body?.rows ?? null });
  res.json({ ok: true });
}));

// ---------- Admin: hesabatlar ----------
const admin = express.Router();
api.use('/admin', admin);

admin.get('/categories', needCap('reports', 'permissions'), wrap(async (_req, res) => {
  res.json((await pool.query('SELECT * FROM portal.report_categories ORDER BY id')).rows);
}));
admin.post('/categories', needCap('reports'), wrap(async (req, res) => {
  const { name_az, name_en, name_ru } = req.body || {};
  if (!name_az) throw new HttpError(400, 'Ad lazımdır');
  const r = await pool.query(
    'INSERT INTO portal.report_categories (name_az,name_en,name_ru) VALUES ($1,$2,$3) RETURNING *',
    [name_az, name_en || name_az, name_ru || name_az]);
  res.json(r.rows[0]);
}));

admin.get('/reports', needCap('reports', 'permissions'), wrap(async (_req, res) => {
  const r = await pool.query(
    `SELECT r.id, r.code, r.kind, r.name_az, r.name_en, r.name_ru, r.active, r.version, r.category_id,
            (SELECT count(*)::int FROM portal.report_columns c WHERE c.report_id = r.id) AS columns
     FROM portal.reports r ORDER BY r.category_id NULLS LAST, r.name_az`);
  res.json(r.rows);
}));

admin.get('/reports/:id', needCap('reports', 'permissions'), wrap(async (req, res) => {
  const r = await pool.query('SELECT * FROM portal.reports WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) throw new HttpError(404, 'Tapılmadı');
  const cols = await pool.query('SELECT * FROM portal.report_columns WHERE report_id = $1 ORDER BY pos, code', [req.params.id]);
  const ver = await pool.query(
    `SELECT v.version, v.changed_by, u.name AS changed_name, v.changed_at
     FROM portal.report_versions v LEFT JOIN portal.users u ON u.empid = v.changed_by
     WHERE v.report_id = $1 ORDER BY v.version DESC LIMIT 20`, [req.params.id]);
  res.json({ ...r.rows[0], columns: cols.rows, versions: ver.rows });
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO portal.reports (code,category_id,kind,name_az,name_en,name_ru,description,sql,params,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [code, b.category_id || null, b.kind || 'query', b.name_az, b.name_en || b.name_az, b.name_ru || b.name_az,
        b.description || '', b.sql, JSON.stringify(b.params || []), req.user.empid]);
    const id = r.rows[0].id;
    await client.query('INSERT INTO portal.report_versions (report_id,version,sql,changed_by) VALUES ($1,1,$2,$3)',
      [id, b.sql, req.user.empid]);
    await saveColumns(client, id, b.columns || []);
    await client.query('COMMIT');
    await audit(req.user.empid, 'report.create', { code });
    res.json({ id });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new HttpError(400, 'Bu kodlu hesabat var');
    throw e;
  } finally {
    client.release();
  }
}));

admin.put('/reports/:id', needCap('reports'), wrap(async (req, res) => {
  const b = req.body || {};
  await guardAuto(b.sql, b.kind || 'query');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM portal.reports WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!cur) throw new HttpError(404, 'Tapılmadı');
    const changed = cur.sql !== b.sql;
    const version = changed ? cur.version + 1 : cur.version;
    await client.query(
      `UPDATE portal.reports SET category_id=$2, kind=$3, name_az=$4, name_en=$5, name_ru=$6, description=$7,
         sql=$8, params=$9, active=$10, version=$11, updated_by=$12, updated_at=now() WHERE id=$1`,
      [cur.id, b.category_id || null, b.kind || cur.kind, b.name_az || cur.name_az, b.name_en || b.name_az,
        b.name_ru || b.name_az, b.description ?? '', b.sql, JSON.stringify(b.params || []), b.active !== false,
        version, req.user.empid]);
    if (changed) {
      await client.query('INSERT INTO portal.report_versions (report_id,version,sql,changed_by) VALUES ($1,$2,$3,$4)',
        [cur.id, version, b.sql, req.user.empid]);
    }
    if (Array.isArray(b.columns)) await saveColumns(client, cur.id, b.columns);
    await client.query('COMMIT');
    await audit(req.user.empid, 'report.update', { id: cur.id, version });
    res.json({ id: cur.id, version });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---------- Admin: yetkilər ----------
const SUBJECT_TYPES = ['position', 'group', 'user'];
function subj(q) {
  const type = String(q.subjectType || '');
  const id = String(q.subjectId || '');
  if (!SUBJECT_TYPES.includes(type) || !id) throw new HttpError(400, 'Subyekt yanlışdır');
  return [type, id];
}

admin.get('/permissions', needCap('permissions'), wrap(async (req, res) => {
  const [type, id] = subj(req.query);
  const rid = Number(req.query.reportId);
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
    rules: rules.rows.map((r) => ({ id: r.id, column: r.column_code, op: r.op, value: r.value })),
  });
}));

admin.get('/permissions/overview', needCap('permissions'), wrap(async (req, res) => {
  const [type, id] = subj(req.query);
  const r = await pool.query(
    'SELECT report_id, can_export FROM portal.perm_report WHERE subject_type=$1 AND subject_id=$2', [type, id]);
  res.json(r.rows);
}));

admin.put('/permissions', needCap('permissions'), wrap(async (req, res) => {
  const [type, id] = subj(req.body || {});
  const b = req.body;
  const rid = Number(b.reportId);
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
  const empid = String(req.query.empid || '');
  const rid = Number(req.query.reportId);
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
    `SELECT p.id, p.name, p.parent_id, (SELECT count(*)::int FROM portal.users u WHERE u.position_id = p.id AND u.active) AS members
     FROM portal.positions p ORDER BY p.parent_id NULLS FIRST, p.name`)).rows;
  const groups = (await pool.query(
    `SELECT g.id, g.name, (SELECT count(*)::int FROM portal.user_groups ug WHERE ug.group_id = g.id) AS members
     FROM portal.groups g ORDER BY g.name`)).rows;
  const users = (await pool.query(
    'SELECT empid, name, position_id, role, active FROM portal.users ORDER BY name')).rows;
  res.json({ positions, groups, users });
}));

admin.get('/users', needCap('users'), wrap(async (_req, res) => {
  const r = await pool.query(
    `SELECT u.empid, u.name, u.role, u.caps, u.position_id, u.active,
            COALESCE((SELECT array_agg(ug.group_id) FROM portal.user_groups ug WHERE ug.empid = u.empid), '{}') AS groups
     FROM portal.users u ORDER BY u.name`);
  res.json(r.rows);
}));

async function setGroups(client, empid, groups) {
  await client.query('DELETE FROM portal.user_groups WHERE empid = $1', [empid]);
  for (const g of groups || []) await client.query('INSERT INTO portal.user_groups VALUES ($1,$2) ON CONFLICT DO NOTHING', [empid, g]);
}

admin.post('/users', needCap('users'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!/^[A-Za-z0-9_.-]{2,30}$/.test(b.empid || '')) throw new HttpError(400, 'EMPID yanlışdır');
  if (!b.name) throw new HttpError(400, 'Ad lazımdır');
  if (!b.password || b.password.length < 8) throw new HttpError(400, 'Parol ən azı 8 simvol');
  const isAdmin = req.user.role === 'admin';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO portal.users (empid,name,password_hash,role,caps,position_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [b.empid, b.name, bcrypt.hashSync(b.password, 10), isAdmin ? b.role || 'user' : 'user',
        isAdmin ? (b.caps || []).filter((c) => ALL_CAPS.includes(c)) : [], b.position_id || null]);
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

admin.put('/users/:empid', needCap('users'), wrap(async (req, res) => {
  const b = req.body || {};
  const isAdmin = req.user.role === 'admin';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM portal.users WHERE empid=$1 FOR UPDATE', [req.params.empid])).rows[0];
    if (!cur) throw new HttpError(404, 'İstifadəçi tapılmadı');
    if (!isAdmin && cur.role !== 'user') throw new HttpError(403, 'Dəstək hesabını yalnız admin dəyişir');
    const role = isAdmin ? b.role || cur.role : cur.role;
    const caps = isAdmin ? (b.caps || cur.caps).filter((c) => ALL_CAPS.includes(c)) : cur.caps;
    if (req.params.empid === req.user.empid && (b.active === false || role !== 'admin') && cur.role === 'admin') {
      throw new HttpError(400, 'Öz admin yetkinizi götürə bilməzsiniz');
    }
    await client.query(
      'UPDATE portal.users SET name=$2, role=$3, caps=$4, position_id=$5, active=$6 WHERE empid=$1',
      [cur.empid, b.name || cur.name, role, caps, b.position_id === undefined ? cur.position_id : b.position_id || null,
        b.active === undefined ? cur.active : !!b.active]);
    if (b.password) {
      if (b.password.length < 8) throw new HttpError(400, 'Parol ən azı 8 simvol');
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

admin.post('/positions', needCap('users'), wrap(async (req, res) => {
  const { name, parent_id } = req.body || {};
  if (!name) throw new HttpError(400, 'Ad lazımdır');
  const r = await pool.query('INSERT INTO portal.positions (name,parent_id) VALUES ($1,$2) RETURNING *', [name, parent_id || null]);
  res.json(r.rows[0]);
}));
admin.delete('/positions/:id', needCap('users'), wrap(async (req, res) => {
  await pool.query('DELETE FROM portal.positions WHERE id=$1', [req.params.id]);
  await pool.query(`DELETE FROM portal.perm_report WHERE subject_type='position' AND subject_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM portal.perm_column WHERE subject_type='position' AND subject_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM portal.perm_value WHERE subject_type='position' AND subject_id=$1`, [req.params.id]);
  res.json({ ok: true });
}));
admin.post('/groups', needCap('users'), wrap(async (req, res) => {
  if (!req.body?.name) throw new HttpError(400, 'Ad lazımdır');
  const r = await pool.query('INSERT INTO portal.groups (name) VALUES ($1) RETURNING *', [req.body.name]);
  res.json(r.rows[0]);
}));
admin.delete('/groups/:id', needCap('users'), wrap(async (req, res) => {
  await pool.query('DELETE FROM portal.groups WHERE id=$1', [req.params.id]);
  await pool.query(`DELETE FROM portal.perm_report WHERE subject_type='group' AND subject_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM portal.perm_column WHERE subject_type='group' AND subject_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM portal.perm_value WHERE subject_type='group' AND subject_id=$1`, [req.params.id]);
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
  return { config, password, result: await testLdap(config, password, String(body?.testLogin || '').trim(), String(body?.testPassword || '')) };
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
  await audit(req.user.empid, 'conn_save', { kind, enabled, host: config.host || config.url });
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
    `SELECT a.id, a.at, a.empid, u.name, a.action, a.detail
     FROM portal.audit_log a LEFT JOIN portal.users u ON u.empid = a.empid
     ORDER BY a.id DESC LIMIT $1`, [limit]);
  res.json(r.rows);
}));

export { needAdmin, publicUser };
