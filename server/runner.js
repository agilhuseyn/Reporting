import { pool } from './db.js';
import { effective, visibleColumns, resolveToken } from './perms.js';
import { HttpError } from './errors.js';
import { getSqlSource, loadConn } from './connections.js';
import { guardMssql, canWrap, colType, normVal, buildWrapped, applyJs, dateInput } from './mssql-dialect.js';

export { HttpError };
export const MAX_ROWS = 50000;

// ---------- Postgres ----------
// Qoruma qatı: yalnız bir SELECT / WITH sorğusu. Əsas qoruma report_ro rolu və oxuma tranzaksiyasıdır.
const FORBIDDEN = new RegExp(
  '\\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|merge|vacuum|analyze|' +
    'reindex|listen|notify|lock|set|set_config|reset|do|portal|information_schema|dblink|lo_import|lo_export|query_to_xml)\\b|\\bpg_[a-z_]+',
  'i'
);

export function guardSql(sql) {
  const s = String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '');
  if (!s) throw new HttpError(400, 'SQL boşdur');
  if (s.includes(';')) throw new HttpError(400, 'Yalnız bir sorğu yazıla bilər');
  if (!/^(select|with)\b/i.test(s)) throw new HttpError(400, 'Sorğu SELECT və ya WITH ilə başlamalıdır');
  const m = FORBIDDEN.exec(s);
  if (m) throw new HttpError(400, `Qadağan söz: ${m[0]}`);
  return s;
}

export function detectParams(sql) {
  const set = new Set();
  for (const m of String(sql || '').matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) set.add(m[1]);
  return [...set];
}

const CASTS = { date: '::date', number: '::numeric', text: '::text', list: '::text' };

// @ad → $n::tip. Tip hesabatın parametr siyahısından gəlir (Postgres tipi özü tapa bilmədikdə xəta verir).
export function bindParams(sql, values = {}, types = {}) {
  const names = [];
  const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => {
    let i = names.indexOf(n);
    if (i < 0) {
      names.push(n);
      i = names.length - 1;
    }
    return '$' + (i + 1) + (CASTS[types[n]] || '');
  });
  const args = names.map((n) => {
    const v = values?.[n];
    return v === undefined || v === '' ? null : v;
  });
  return { text, args, names };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Sütunun real adı (SQL nəticəsindəki ad) təhlükəsiz dırnaqlanır
const pgq = (name) => `r."${String(name).replace(/"/g, '""')}"`;
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700, 26]);
const DATE_OIDS = new Set([1082, 1114, 1184]);
export const typeOf = (oid) => (NUMERIC_OIDS.has(oid) ? 'number' : DATE_OIDS.has(oid) ? 'date' : 'text');

async function execPg(src, query) {
  const client = await src.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 30000');
    const res = await client.query({ ...query, rowMode: 'array' });
    await client.query('ROLLBACK');
    return res;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw new HttpError(400, e.message);
  } finally {
    client.release();
  }
}

// ---------- MSSQL ----------
// inputs: [{name, type: 'text'|'number'|'date'|'list', value}]. Nəticə: { cols: [{code,type}], rows: [[...]] }
async function execMssql(src, text, inputs) {
  const { lib: m } = src;
  const req = src.pool.request();
  req.arrayRowMode = true;
  for (const i of inputs) {
    const empty = i.value === undefined || i.value === null || i.value === '';
    if (i.type === 'number') req.input(i.name, m.Decimal(38, 6), empty ? null : Number(i.value));
    else if (i.type === 'date') req.input(i.name, m.VarChar(8), empty ? null : dateInput(i.value));
    else req.input(i.name, m.NVarChar(4000), empty ? null : String(i.value));
  }
  let res;
  try {
    res = await req.query(text);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  const rs = res.recordsets?.[0] || res.recordset || [];
  const meta = rs.columns || res.recordset?.columns || {};
  const cols = Object.values(meta)
    .sort((a, b) => a.index - b.index)
    .map((c) => ({ code: c.name, type: colType(c.type?.declaration || c.type?.name) }));
  return { cols, rows: rs.map((r) => r.map(normVal)) };
}

const mssqlInputs = (inner, values, types) =>
  [...new Set([...inner.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].map((n) => ({
    name: n, type: types?.[n] || 'text', value: values?.[n],
  }));

// ---------- Ümumi ----------
// Maskalanmış sütun: həqiqi dəyər serverdən çıxmır. Yalnız uzunluq gedir, dəyər uydurulur.
function filler(len, type) {
  const n = Math.max(3, Math.min(Number(len) || 6, 40));
  const pool_ = type === 'number' ? '0123456789' : 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let k = 0; k < n; k++) out += pool_[Math.floor(Math.random() * pool_.length)];
  return type === 'number' ? Number(out) : out;
}

const paramTypes = (list) => Object.fromEntries((list || []).map((p) => [p.name, p.type]));

// İstifadəçiyə bazanın daxili xəta mətni (cədvəl/sütun adları) göstərilmir. Tam xəta yalnız jurnala yazılır.
function userSafe(e, report) {
  if (!(e instanceof HttpError) || e.status !== 400) return e;
  const m = String(e.message || '');
  console.error(`Hesabat xətası [${report.code}]: ${m}`);
  if (/statement timeout|canceling statement|timeout|Timeout/i.test(m)) {
    return new HttpError(400, 'Sorğu çox uzun çəkdi (30 san). Filtrləri daraldın.');
  }
  if (/invalid input syntax|out of range|Conversion failed|Invalid (date|number)/i.test(m)) {
    return new HttpError(400, 'Parametr dəyəri yanlışdır');
  }
  return new HttpError(400, 'Hesabat icra edilə bilmədi. Administrator ilə əlaqə saxlayın.');
}

export async function runForUser(empid, report, params) {
  try {
    return await runForUserInner(empid, report, params);
  } catch (e) {
    throw userSafe(e, report);
  }
}

// SQL-i sütun/qayda sarğısı ilə icra edir (hər iki baza üçün). Nəticə: sətirlər (maskalanmamış).
async function execWrapped({ src, sql: rawSql, kind, vis, rules, rcols, values, types, maxRows }) {
  if (src.dialect === 'mssql') {
    const inner = guardMssql(rawSql, kind);
    const inputs = mssqlInputs(inner, values, types);
    if (canWrap(inner, kind)) {
      const { sql, extra } = buildWrapped({ inner, vis, rules, rcols, top: maxRows + 1, resolve: resolveToken });
      return (await execMssql(src, sql, [...inputs, ...extra])).rows;
    }
    const raw = await execMssql(src, inner, inputs);
    return applyJs({
      cols: raw.cols.map((c) => c.code), rows: raw.rows, vis, rules, rcols, resolve: resolveToken, max: maxRows,
    });
  }
  const inner = guardSql(rawSql);
  const { text, args } = bindParams(inner, values, types);
  const where = [];
  for (const r of rules) {
    if (!IDENT.test(r.column)) throw new HttpError(500, 'Yanlış qayda sütunu');
    const rc = rcols.find((c) => c.code === r.column);
    if (!rc) throw new HttpError(500, `Qayda sütunu hesabatda yoxdur: ${r.column}`);
    const col = pgq(rc.src || rc.code);
    const raw = Array.isArray(r.value) ? r.value.map(resolveToken) : resolveToken(r.value);
    if (r.op === 'in') {
      args.push([].concat(raw).map(String));
      where.push(`${col}::text = ANY($${args.length}::text[])`);
    } else if (r.op === 'eq') {
      args.push(String(raw));
      where.push(`${col}::text = $${args.length}`);
    } else {
      const cast = rc.type === 'number' ? '::numeric' : rc.type === 'date' ? '::date' : '';
      args.push(String(raw));
      const lhs = cast ? col : `${col}::text`;
      where.push(`${lhs} ${r.op === 'gte' ? '>=' : '<='} $${args.length}${cast}`);
    }
  }
  const select = vis
    .map((c) => {
      if (!IDENT.test(c.code)) throw new HttpError(500, 'Yanlış sütun kodu');
      const from = pgq(c.src || c.code);
      return c.masked ? `length(${from}::text) AS "${c.code}"` : `${from} AS "${c.code}"`;
    })
    .join(', ');
  const sql = `SELECT ${select} FROM (${text}) AS r${where.length ? ' WHERE ' + where.join(' AND ') : ''} LIMIT ${maxRows + 1}`;
  return (await execPg(src, { text: sql, values: args })).rows;
}

const colInfo = (vis) => vis.map((c) => ({
  code: c.code, label_az: c.label_az, label_en: c.label_en, label_ru: c.label_ru, type: c.type, masked: c.masked,
}));

function maskRows(rows, vis) {
  vis.forEach((c, idx) => {
    if (!c.masked) return;
    for (const row of rows) row[idx] = row[idx] == null ? null : filler(row[idx], c.type);
  });
}

async function runForUserInner(empid, report, params, opts = {}) {
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const perm = await effective(empid, report.id);
  if (!perm.allowed) throw new HttpError(403, 'Bu hesabata yetkiniz yoxdur');
  const rcols = (
    await pool.query('SELECT * FROM portal.report_columns WHERE report_id = $1 ORDER BY pos, code', [report.id])
  ).rows;
  const vis = visibleColumns(perm, rcols);
  if (!vis.length) throw new HttpError(403, 'Heç bir sütuna yetkiniz yoxdur');
  const src = await getSqlSource();
  const t0 = Date.now();
  let rows = await execWrapped({
    src, sql: report.sql, kind: report.kind, vis, rules: [...perm.rules, ...(opts.extraRules || [])], rcols,
    values: params, types: paramTypes(report.params), maxRows,
  });

  const truncated = rows.length > maxRows;
  if (truncated) rows = rows.slice(0, maxRows);
  maskRows(rows, vis);
  return { columns: colInfo(vis), rows, truncated, ms: Date.now() - t0, canExport: perm.canExport };
}

// Detal (hesabatın ikinci SQL-i): əsas hesabata yetkisi olan istifadəçi üçün açılır.
// 1) Basılan dəyər istifadəçinin həmin hesabatda görə bildiyi sətirdən olmalıdır (yetki qaydaları və parametrlər daxil).
// 2) Əsas hesabatda gizli/maskalı olan sütunla eyni kodlu detal sütunu da gizli/maskalı olur.
export async function runDetailForUser(empid, report, params, key) {
  try {
    return await runDetailInner(empid, report, params, key);
  } catch (e) {
    throw userSafe(e, report);
  }
}

async function runDetailInner(empid, report, params, key) {
  const drill = report.drill;
  if (!drill?.sql || !drill.column) throw new HttpError(404, 'Detal yoxdur');
  if (typeof key !== 'string' && typeof key !== 'number') throw new HttpError(400, 'Dəyər yanlışdır');
  const keyStr = String(key);
  if (!keyStr || keyStr.length > 200) throw new HttpError(400, 'Dəyər yanlışdır');
  const perm = await effective(empid, report.id);
  if (!perm.allowed) throw new HttpError(403, 'Bu hesabata yetkiniz yoxdur');
  const rcols = (
    await pool.query('SELECT * FROM portal.report_columns WHERE report_id = $1 ORDER BY pos, code', [report.id])
  ).rows;
  const keyCol = visibleColumns(perm, rcols).find((c) => c.code === drill.column);
  if (!keyCol || keyCol.masked) throw new HttpError(403, 'Bu sütun üçün detal açıq deyil');

  // Basılan dəyər əsas hesabatda bu istifadəçiyə görünən sətirdən gəlirmi?
  const seen = await runForUserInner(empid, report, params, {
    maxRows: 1, extraRules: [{ column: drill.column, op: 'eq', value: keyStr, subject: { type: 'user', id: empid } }],
  });
  if (!seen.rows.length) throw new HttpError(404, 'Tapılmadı');

  const dcols = (drill.columns || []).map((c) => ({ ...c, masked: false }));
  const vis = dcols
    .map((c) => {
      if (!rcols.some((x) => x.code === c.code)) return c;
      const mode = perm.columns[c.code];
      return mode === 'show' ? c : mode === 'mask' ? { ...c, masked: true } : null;
    })
    .filter(Boolean);
  if (!vis.length) throw new HttpError(403, 'Heç bir sütuna yetkiniz yoxdur');
  const rules = perm.rules.filter((r) => dcols.some((c) => c.code === r.column));
  const src = await getSqlSource();
  const t0 = Date.now();
  let rows = await execWrapped({
    src, sql: drill.sql, kind: 'query', vis, rules, rcols: dcols,
    values: { ...params, deyer: keyStr }, types: { ...paramTypes(report.params), deyer: keyCol.type }, maxRows: MAX_ROWS,
  });
  const truncated = rows.length > MAX_ROWS;
  if (truncated) rows = rows.slice(0, MAX_ROWS);
  maskRows(rows, vis);
  return { columns: colInfo(vis), rows, truncated, ms: Date.now() - t0, canExport: perm.canExport };
}

// Admin testi: bütün sütunlar, 200 sətrə qədər.
export async function runTest(sql, params, types, kind) {
  const src = await getSqlSource();
  const t0 = Date.now();
  if (src.dialect === 'mssql') {
    const inner = guardMssql(sql, kind);
    const inputs = mssqlInputs(inner, params, types);
    const text = canWrap(inner, kind) ? `SELECT TOP (200) * FROM (${inner}) AS r` : inner;
    const res = await execMssql(src, text, inputs);
    return { columns: res.cols, rows: res.rows.slice(0, 200), ms: Date.now() - t0 };
  }
  const inner = guardSql(sql);
  const { text, args } = bindParams(inner, params, types);
  const res = await execPg(src, { text: `SELECT * FROM (${text}) AS r LIMIT 200`, values: args });
  return {
    columns: res.fields.map((f) => ({ code: f.name, type: typeOf(f.dataTypeID) })),
    rows: res.rows,
    ms: Date.now() - t0,
  };
}

export async function runOptions(sql) {
  const src = await getSqlSource();
  if (src.dialect === 'mssql') {
    const inner = guardMssql(sql, 'query');
    const text = canWrap(inner, 'query') ? `SELECT TOP (500) * FROM (${inner}) AS r` : inner;
    const res = await execMssql(src, text, []);
    return res.rows.slice(0, 500).map((r) => ({ value: String(r[0]), label: String(r[1] ?? r[0]) }));
  }
  const res = await execPg(src, { text: `SELECT * FROM (${guardSql(sql)}) AS r LIMIT 500`, values: [] });
  return res.rows.map((r) => ({ value: String(r[0]), label: String(r[1] ?? r[0]) }));
}

// Hesabatı saxlayanda: aktiv bazanın dialektinə görə yoxlayır (MSSQL aktivdirsə MSSQL qaydaları).
export async function guardAuto(sql, kind) {
  const c = await loadConn('sql').catch(() => null);
  return c?.enabled && c.config?.type === 'mssql' ? guardMssql(sql, kind) : guardSql(sql);
}
