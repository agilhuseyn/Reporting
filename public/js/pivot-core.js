// Pivot hesablaması (DOM yoxdur). Yalnız serverdən gələn yetkili sətirlərlə işləyir.

export const AGGS = ['sum', 'count', 'avg', 'min', 'max'];

function aggregate(items, field, agg) {
  if (agg === 'count') return items.filter((r) => r[field] !== null && r[field] !== undefined && r[field] !== '').length;
  const nums = items.map((r) => Number(r[field])).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === 'min') return Math.min(...nums);
  if (agg === 'max') return Math.max(...nums);
  return null;
}

const keyOf = (r, fields) => fields.map((f) => (r[f] ?? '')).join(' / ');

function cmp(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && a !== '' && b !== '') return na - nb;
  return String(a).localeCompare(String(b), 'az');
}

// rows: obyekt massivi. spec: { rowFields, colFields, values:[{field, agg}], subtotals, grandTotal }
export function computePivot(rows, spec) {
  const { rowFields = [], colFields = [], values = [], subtotals = true, grandTotal = true } = spec;
  const colKeys = [...new Set(rows.map((r) => keyOf(r, colFields)))].sort(cmp);
  const hasCols = colFields.length > 0;
  const cols = hasCols ? colKeys : [''];

  function cellsFor(items) {
    const byCol = new Map();
    for (const r of items) {
      const k = hasCols ? keyOf(r, colFields) : '';
      if (!byCol.has(k)) byCol.set(k, []);
      byCol.get(k).push(r);
    }
    const cells = cols.map((k) => values.map((v) => aggregate(byCol.get(k) || [], v.field, v.agg)));
    const total = values.map((v) => aggregate(items, v.field, v.agg));
    return { cells, total };
  }

  const out = [];
  function walk(items, level, path) {
    if (level >= rowFields.length) return;
    const field = rowFields[level];
    const groups = new Map();
    for (const r of items) {
      const k = r[field] ?? '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const keys = [...groups.keys()].sort(cmp);
    for (const k of keys) {
      const sub = groups.get(k);
      const leaf = level === rowFields.length - 1;
      const node = { level, label: String(k), path: [...path, String(k)], kind: leaf ? 'leaf' : 'group', ...cellsFor(sub) };
      if (leaf || subtotals) out.push(node);
      else if (!leaf) {
        /* alt yekun söndürülüb: yalnız uşaqlar göstərilir */
      }
      walk(sub, level + 1, [...path, String(k)]);
    }
  }
  if (rowFields.length) walk(rows, 0, []);
  else out.push({ level: 0, label: '', path: [], kind: 'leaf', ...cellsFor(rows) });

  const grand = grandTotal && rowFields.length ? { level: 0, label: '', path: [], kind: 'grand', ...cellsFor(rows) } : null;
  return { cols, hasCols, rows: out, grand };
}

// Hüceyrə rəngi üçün sinif: yalnız yarpaq sətirlər arasında sıralama.
export function heatClasses(result, valueIndex) {
  const nums = [];
  for (const r of result.rows) {
    if (r.kind !== 'leaf') continue;
    for (const c of r.cells) if (c[valueIndex] !== null && c[valueIndex] !== undefined) nums.push(c[valueIndex]);
  }
  if (nums.length < 4) return () => '';
  const sorted = [...nums].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const q90 = q(0.9);
  const q70 = q(0.7);
  const q30 = q(0.3);
  return (v) => (v === null || v === undefined ? '' : v >= q90 ? 'h1' : v >= q70 ? 'h2' : v <= q30 ? 'h3' : '');
}
