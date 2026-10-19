import { HttpError } from './errors.js';

// MSSQL üçün təmiz (sürücüsüz) köməkçilər: qoruma, sorğu qurma, JS tərəfdə süzgəc.

const FORBIDDEN = new RegExp(
  '\\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|exec|execute|into|dbcc|backup|restore|' +
    'shutdown|waitfor|openrowset|opendatasource|openquery|bulk|declare|use|kill|reconfigure|set)\\b|\\b(xp|sp)_\\w+',
  'i'
);
const ARG = '@[A-Za-z_]\\w*(?:\\s*=\\s*@[A-Za-z_]\\w*)?';
const PROC_RE = new RegExp(`^exec(?:ute)?\\s+(?:\\[?[A-Za-z_]\\w*\\]?\\.){0,2}\\[?[A-Za-z_]\\w*\\]?(?:\\s+${ARG}(?:\\s*,\\s*${ARG})*)?$`, 'i');

function clean(sql) {
  return String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '');
}

export function guardMssql(sql, kind) {
  const s = clean(sql);
  if (!s) throw new HttpError(400, 'SQL boşdur');
  if (s.includes(';')) throw new HttpError(400, 'Yalnız bir sorğu yazıla bilər');
  if (kind === 'procedure') {
    if (!PROC_RE.test(s)) throw new HttpError(400, 'Prosedur formatı: EXEC sxem.ad @a = @a, @b = @b');
    return s;
  }
  if (!/^(select|with)\b/i.test(s)) throw new HttpError(400, 'Sorğu SELECT və ya WITH ilə başlamalıdır');
  const m = FORBIDDEN.exec(s);
  if (m) throw new HttpError(400, `Qadağan söz: ${m[0]}`);
  return s;
}

// Alt sorğuya (derived table) sarımaq olarmı? WITH, ORDER BY və prosedur sarına bilməz.
export const canWrap = (inner, kind) =>
  kind !== 'procedure' && /^select\b/i.test(inner) && !/\border\s+by\b/i.test(inner);

const NUM = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'bit']);
const DATE = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);
export function colType(decl) {
  const d = String(decl || '').toLowerCase();
  return NUM.has(d) ? 'number' : DATE.has(d) ? 'date' : 'text';
}

export function normVal(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  if (Buffer.isBuffer(v)) return v.toString('hex');
  return v;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Kod (alias) yalnız hərf/rəqəm/_ ola bilər. Real ad ( src ) isə hər şey ola bilər, ] iki dəfə yazılır.
const q = (c) => `[${String(c).replace(/]/g, ']]')}]`;
const code = (c) => {
  if (!IDENT.test(c)) throw new HttpError(500, 'Yanlış sütun kodu');
  return `[${c}]`;
};
const ymd = (v) => String(v).replace(/-/g, '').slice(0, 8);

// Sarınmış sorğu: SELECT TOP (n) cols FROM (inner) r WHERE rules.
// Qaydalar üçün əlavə parametrlər qaytarır.
export function buildWrapped({ inner, vis, rules, rcols, top, resolve }) {
  const extra = [];
  const add = (type, value) => {
    const name = `__r${extra.length}`;
    extra.push({ name, type, value });
    return '@' + name;
  };
  const where = [];
  for (const r of rules) {
    const rc = rcols.find((c) => c.code === r.column);
    if (!rc) throw new HttpError(500, `Qayda sütunu hesabatda yoxdur: ${r.column}`);
    const col = `r.${q(rc.src || rc.code)}`;
    const txt = `CAST(${col} AS NVARCHAR(4000))`;
    const raw = Array.isArray(r.value) ? r.value.map(resolve) : resolve(r.value);
    if (r.op === 'in') {
      const list = [].concat(raw).map((v) => add('text', String(v)));
      where.push(list.length ? `${txt} IN (${list.join(', ')})` : '1 = 0');
    } else if (r.op === 'eq') {
      where.push(`${txt} = ${add('text', String(raw))}`);
    } else {
      const op = r.op === 'gte' ? '>=' : '<=';
      if (rc.type === 'number') where.push(`${col} ${op} ${add('number', Number(raw))}`);
      else if (rc.type === 'date') where.push(`CAST(${col} AS date) ${op} CAST(${add('date', raw)} AS date)`);
      else where.push(`${txt} ${op} ${add('text', String(raw))}`);
    }
  }
  const select = vis.map((c) => (c.masked ? `LEN(CAST(r.${q(c.src || c.code)} AS NVARCHAR(MAX))) AS ${code(c.code)}` : `r.${q(c.src || c.code)} AS ${code(c.code)}`)).join(', ');
  const sql = `SELECT TOP (${top}) ${select} FROM (${inner}) AS r${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  return { sql, extra };
}

export const dateInput = ymd;

// Sarımaq olmayan sorğular (WITH, ORDER BY, prosedur): nəticə JS tərəfdə süzülür.
export function applyJs({ cols, rows, vis, rules, rcols, resolve, max }) {
  const pos = (code) => {
    let i = cols.findIndex((c) => c === code);
    if (i < 0) i = cols.findIndex((c) => String(c).toLowerCase() === code.toLowerCase());
    if (i < 0) throw new HttpError(500, `Sütun nəticədə yoxdur: ${code}`);
    return i;
  };
  const checks = rules.map((r) => {
    const rc = rcols.find((c) => c.code === r.column);
    const i = pos(rc?.src || r.column);
    const type = rc?.type || 'text';
    const raw = Array.isArray(r.value) ? r.value.map(resolve) : resolve(r.value);
    const cmp = (v) => (type === 'number' ? Number(v) : type === 'date' ? String(v).slice(0, 10) : String(v));
    if (r.op === 'in') {
      const set = new Set([].concat(raw).map(String));
      return (row) => row[i] != null && set.has(String(row[i]));
    }
    if (r.op === 'eq') return (row) => row[i] != null && String(row[i]) === String(raw);
    return (row) => {
      if (row[i] == null) return false;
      const a = cmp(row[i]);
      const b = cmp(raw);
      return r.op === 'gte' ? a >= b : a <= b;
    };
  });
  const idx = vis.map((c) => pos(c.src || c.code));
  const out = [];
  for (const row of rows) {
    if (!checks.every((f) => f(row))) continue;
    out.push(vis.map((c, k) => (c.masked ? (row[idx[k]] == null ? null : String(row[idx[k]]).length) : row[idx[k]])));
    if (out.length > max) break;
  }
  return out;
}
