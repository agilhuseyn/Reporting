// Brauzer ilə server arasında yalnız təsadüfi UUID işlədilir. Bazadakı ardıcıl nömrələr (və EMPID) çöldən görünmür.
import { pool } from './db.js';
import { HttpError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUid = (v) => typeof v === 'string' && UUID_RE.test(v);

// kind -> [cədvəl, daxili açar]
const TABLES = {
  report: ['portal.reports', 'id'],
  category: ['portal.report_categories', 'id'],
  position: ['portal.positions', 'id'],
  group: ['portal.groups', 'id'],
  user: ['portal.users', 'empid'],
};

// UUID -> daxili açar. Yanlış formatda və ya tapılmayanda eyni 404 cavabı (varlığı bildirmir).
export async function keyOf(kind, uid, db = pool) {
  if (!isUid(uid)) throw new HttpError(404, 'Tapılmadı');
  const [table, col] = TABLES[kind];
  const r = await db.query(`SELECT ${col} AS k FROM ${table} WHERE uid = $1`, [uid.toLowerCase()]);
  if (!r.rowCount) throw new HttpError(404, 'Tapılmadı');
  return r.rows[0].k;
}

// Boş dəyər (seçilməyib) null qaytarır.
export async function keyOrNull(kind, uid, db = pool) {
  if (uid === null || uid === undefined || uid === '') return null;
  return keyOf(kind, uid, db);
}

export async function keysOf(kind, uids, db = pool) {
  const out = [];
  for (const u of Array.isArray(uids) ? uids : []) out.push(await keyOf(kind, u, db));
  return out;
}
