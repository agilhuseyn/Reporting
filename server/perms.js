import { pool } from './db.js';

// Yetki qaydaları:
//  - Subyektlər: istifadəçi, vəzifə (və üst vəzifələri), qruplar.
//  - Hesabat: subyektlərdən biri icazə verirsə, açıqdır.
//  - Sütun: hide > mask > show. Heç bir "show/mask" yoxdursa, sütun gizlidir.
//  - Dəyər qaydaları: eyni sütunda bütün qaydalar birlikdə tətbiq olunur (kəsişmə).
//  - Qadağan həmişə üstün gəlir.

const RANK = { hide: 3, mask: 2, show: 1 };

export async function subjectsFor(empid) {
  const u = await pool.query('SELECT position_id FROM portal.users WHERE empid = $1', [empid]);
  const subjects = [{ type: 'user', id: empid }];
  const posId = u.rows[0]?.position_id;
  if (posId) {
    const r = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, name FROM portal.positions WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_id, p.name FROM portal.positions p JOIN up ON p.id = up.parent_id)
       SELECT id, name FROM up`, [posId]);
    for (const row of r.rows) subjects.push({ type: 'position', id: String(row.id), label: row.name });
  }
  const g = await pool.query(
    `SELECT g.id, g.name FROM portal.user_groups ug JOIN portal.groups g ON g.id = ug.group_id
     WHERE ug.empid = $1`, [empid]);
  for (const row of g.rows) subjects.push({ type: 'group', id: String(row.id), label: row.name });
  return subjects;
}

function arrays(subjects) {
  return [subjects.map((s) => s.type), subjects.map((s) => s.id)];
}

export function resolveToken(v) {
  if (typeof v !== 'string') return v;
  const m = /^\$ym-(\d+)$/.exec(v);
  if (m) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - Number(m[1]));
    return d.toISOString().slice(0, 7);
  }
  return v;
}

export async function reportsFor(empid) {
  const subjects = await subjectsFor(empid);
  const [t, i] = arrays(subjects);
  // Çöldən yalnız UUID görünür; kateqoriya sırası daxili nömrə ilə saxlanır və cavaba düşmür
  const r = await pool.query(
    `SELECT x.id, x.code, x.kind, x.name_az, x.name_en, x.name_ru, x.description,
            x.category_id, x.cat_az, x.cat_en, x.cat_ru
     FROM (
       SELECT DISTINCT r.uid AS id, r.code, r.kind, r.name_az, r.name_en, r.name_ru, r.description,
              c.uid AS category_id, c.name_az AS cat_az, c.name_en AS cat_en, c.name_ru AS cat_ru, c.id AS cat_ord
       FROM portal.perm_report p
       JOIN portal.reports r ON r.id = p.report_id AND r.active
       LEFT JOIN portal.report_categories c ON c.id = r.category_id
       WHERE (p.subject_type, p.subject_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
     ) x
     ORDER BY x.cat_ord NULLS LAST, x.name_az`, [t, i]);
  return r.rows;
}

// Bir istifadəçi və hesabat üçün effektiv yetki.
export async function effective(empid, reportId) {
  const subjects = await subjectsFor(empid);
  const [t, i] = arrays(subjects);
  const sub = `(subject_type, subject_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`;
  const grants = await pool.query(
    `SELECT subject_type, subject_id, can_export FROM portal.perm_report
     WHERE report_id = $3 AND ${sub}`, [t, i, reportId]);
  const cols = await pool.query(
    `SELECT subject_type, subject_id, column_code, mode FROM portal.perm_column
     WHERE report_id = $3 AND ${sub}`, [t, i, reportId]);
  const rules = await pool.query(
    `SELECT subject_type, subject_id, column_code, op, value FROM portal.perm_value
     WHERE report_id = $3 AND ${sub}`, [t, i, reportId]);

  const columns = {};
  const sources = {};
  for (const c of cols.rows) {
    (sources[c.column_code] ||= []).push({ type: c.subject_type, id: c.subject_id, mode: c.mode });
    const cur = columns[c.column_code];
    if (!cur || RANK[c.mode] > RANK[cur]) columns[c.column_code] = c.mode;
  }
  return {
    subjects,
    allowed: grants.rowCount > 0,
    canExport: grants.rows.some((g) => g.can_export),
    columns, // code -> show|mask|hide (yalnız yazılanlar)
    sources,
    rules: rules.rows.map((r) => ({
      column: r.column_code, op: r.op, value: r.value, subject: { type: r.subject_type, id: r.subject_id },
    })),
  };
}

export function visibleColumns(perm, reportColumns) {
  return reportColumns
    .filter((c) => perm.columns[c.code] === 'show' || perm.columns[c.code] === 'mask')
    .map((c) => ({ ...c, masked: perm.columns[c.code] === 'mask' }));
}
