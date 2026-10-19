// SQL mətnindən sütun və parametr məlumatını çıxarır (sürücüsüz, təmiz funksiyalar).
// Məqsəd: admin SQL yazır, sütun kodu və adı avtomatik təyin olunur.
//   filial_kod AS Filial   →  kod: filial_kod, ad: Filial
//   SUM(amount) AS Cəm      →  kod: cem (addan), ad: Cəm

const RESERVED = new Set(['end', 'null', 'true', 'false', 'asc', 'desc', 'distinct', 'then', 'else', 'when', 'and', 'or', 'not', 'is', 'in', 'like', 'between', 'over']);

function stripComments(sql) {
  return String(sql || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// Dərinlik 0-da (mötərizə və dırnaq xaricində) simvol-simvol gəzir.
function scan(sql, fn) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (q) {
      if (ch === q.close) {
        if (sql[i + 1] === q.close && q.close !== ']') i++;
        else q = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') q = { close: ch };
    else if (ch === '[') q = { close: ']' };
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (fn(i, ch, depth) === false) return;
  }
}

const wordAt = (sql, i, w) =>
  sql.slice(i, i + w.length).toLowerCase() === w && !/[\w$]/.test(sql[i - 1] || ' ') && !/[\w$]/.test(sql[i + w.length] || ' ');

function selectList(sql) {
  let start = -1;
  let end = sql.length;
  scan(sql, (i, ch, depth) => {
    if (depth !== 0) return true;
    if (start < 0 && wordAt(sql, i, 'select')) {
      start = i + 6;
      return true;
    }
    if (start >= 0 && wordAt(sql, i, 'from')) {
      end = i;
      return false;
    }
    return true;
  });
  if (start < 0) return null;
  let body = sql.slice(start, end).trim();
  body = body.replace(/^distinct\s+/i, '').replace(/^top\s*(\(\s*[^)]*\)|\d+)(\s+percent)?\s+/i, '');
  return body;
}

function splitCommas(body) {
  const parts = [];
  let last = 0;
  scan(body, (i, ch, depth) => {
    if (ch === ',' && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
    return true;
  });
  parts.push(body.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const unquote = (s) => {
  const t = String(s).trim();
  if (/^".*"$|^`.*`$|^\[.*\]$|^'.*'$/s.test(t)) return t.slice(1, -1);
  return t;
};

const ALIAS = '("[^"]+"|\\[[^\\]]+\\]|`[^`]+`|\'[^\']+\'|[\\p{L}_][\\p{L}\\p{N}_$]*)';

export function parseItem(item) {
  let m = new RegExp(`^(.*\\S)\\s+as\\s+${ALIAS}$`, 'isu').exec(item);
  if (m) return { expr: m[1].trim(), alias: unquote(m[2]) };
  m = new RegExp(`^${ALIAS}\\s*=\\s*(?!=)(.+)$`, 'isu').exec(item); // T-SQL: alias = expr
  if (m) return { expr: m[2].trim(), alias: unquote(m[1]) };
  m = new RegExp(`^(.*[\\p{L}\\p{N}_)\\]"\`])\\s+${ALIAS}$`, 'isu').exec(item); // boş ad: expr alias
  if (m && !RESERVED.has(unquote(m[2]).toLowerCase()) && !/[+\-*/%|&^<>=]\s*$/.test(m[1])) {
    return { expr: m[1].trim(), alias: unquote(m[2]) };
  }
  return { expr: item.trim(), alias: null };
}

const SIMPLE = /^(?:(?:"[^"]+"|\[[^\]]+\]|`[^`]+`|[\w$]+)\.)*("[^"]+"|\[[^\]]+\]|`[^`]+`|[\p{L}_][\p{L}\p{N}_$]*)$/u;

const MAP = { ə: 'e', Ə: 'e', ı: 'i', İ: 'i', ö: 'o', Ö: 'o', ü: 'u', Ü: 'u', ç: 'c', Ç: 'c', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g' };
export function slug(text) {
  let s = String(text || '').replace(/[əƏıİöÖüÜçÇşŞğĞ]/g, (c) => MAP[c]);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return '';
  return /^[0-9]/.test(s) ? `c_${s}` : s;
}

export function parseColumns(sql) {
  const body = selectList(stripComments(sql));
  if (!body) return [];
  return splitCommas(body)
    .map((item) => {
      if (item === '*' || /\.\*$/.test(item)) return { star: true };
      const { expr, alias } = parseItem(item);
      const sm = SIMPLE.exec(expr);
      const base = sm ? unquote(sm[1]) : null;
      return { expr, alias, source: base, simple: !!sm };
    });
}

// Parametr hansı sütunla müqayisə olunur: col = @p, col >= @p, col IN (@p), col BETWEEN @a AND @b
export function paramColumns(sql) {
  const text = stripComments(sql);
  const out = {};
  const ref = '((?:(?:"[^"]+"|\\[[^\\]]+\\]|`[^`]+`|[\\w$]+)\\.)*(?:"[^"]+"|\\[[^\\]]+\\]|`[^`]+`|[\\p{L}_][\\p{L}\\p{N}_$]*))';
  const re = new RegExp(`${ref}\\s*(?:=|<>|!=|>=|<=|>|<|(?:not\\s+)?like|(?:not\\s+)?in\\s*\\(|between)\\s*@([A-Za-z_]\\w*)(?:\\s+and\\s+@([A-Za-z_]\\w*))?`, 'giu');
  for (const m of text.matchAll(re)) {
    const col = unquote(m[1].split('.').pop()).toLowerCase();
    if (RESERVED.has(col)) continue;
    if (!out[m[2]]) out[m[2]] = col;
    if (m[3] && !out[m[3]]) out[m[3]] = col;
  }
  return out;
}

const pretty = (n) => String(n).replace(/_/g, ' ').replace(/^\p{L}/u, (c) => c.toUpperCase());

// resultCols: test nəticəsindəki real sütunlar [{code: ad, type}] (varsa). known: hesabatdakı mövcud sütunlar.
export function analyze(sql, resultCols = null, known = []) {
  const parsed = parseColumns(sql);
  const used = new Set();
  const uniq = (c) => {
    let x = c || 'col';
    let n = 2;
    while (used.has(x)) x = `${c}_${n++}`;
    used.add(x);
    return x;
  };
  const byAlias = new Map(parsed.filter((p) => !p.star).map((p) => [String(p.alias ?? p.source ?? '').toLowerCase(), p]));
  let columns = [];
  if (resultCols?.length) {
    columns = resultCols.map((rc, i) => {
      const p = byAlias.get(String(rc.code).toLowerCase());
      const label = p?.alias || rc.code;
      let code = p?.simple && p.source ? slug(p.source) || slug(label) : slug(label);
      code = uniq(code || `col_${i + 1}`);
      return { code, src: rc.code, label, type: rc.type || 'text' };
    });
  } else {
    columns = parsed.filter((p) => !p.star).map((p, i) => {
      const label = p.alias || p.source || `col_${i + 1}`;
      const code = uniq((p.simple && p.source ? slug(p.source) : slug(label)) || `col_${i + 1}`);
      return { code, src: p.alias || p.source || null, label, type: 'text' };
    });
  }
  const pool = [...known, ...columns];
  const bind = paramColumns(sql);
  const params = {};
  for (const [name, col] of Object.entries(bind)) {
    const c = pool.find((x) => x.code === col || String(x.src ?? '').toLowerCase() === col)
      || parsed.map((p) => ({ p, code: slug(p.source || '') })).find((x) => x.p.source && x.p.source.toLowerCase() === col)?.p;
    const k = c && (c.code ? c : columns.find((x) => x.src && String(x.src).toLowerCase() === String(c.alias ?? c.source).toLowerCase()));
    params[name] = {
      column: col,
      label: (k && (k.label_az || k.label)) || (c && (c.alias || c.source)) || pretty(col),
      type: k?.type && k.type !== 'text' ? k.type : /tarix|date/i.test(col) ? 'date' : null,
    };
  }
  return { columns, params, star: parsed.some((p) => p.star) };
}

export const prettyName = pretty;
