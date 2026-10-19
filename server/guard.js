// Qanunsuz cəhd aşkarlananda: istifadəçi dərhal bloklanır, admin üçün jurnala nə etmək istədiyi yazılır.
// Blokdan yalnız admin çıxara bilər. Admin rolu avtomatik bloklanmır (tək admin özünü kilidləməsin), yalnız jurnala yazılır.
import { HttpError } from './errors.js';

export const BLOCKED_MSG = 'Hesabınız bloklandı. Administrator ilə əlaqə saxlayın.';
export const VIOLATION_MSG = 'Təhlükəsizlik pozuntusu aşkarlandı. Hesabınız bloklandı. Administrator ilə əlaqə saxlayın.';

// db.js tembel yüklənir: təhlükəsizlik köməkçiləri (security.js) bazasız test oluna bilsin
const getPool = async () => (await import('./db.js')).pool;

const clip = (v, n) => String(v ?? '').slice(0, n);

function context(req) {
  return {
    method: req.method,
    path: clip(req.originalUrl, 300),
    ip: req.ip,
    ua: clip(req.headers?.['user-agent'], 200),
  };
}

async function writeAudit(empid, action, detail) {
  try {
    const j = JSON.stringify(detail);
    await (await getPool()).query('INSERT INTO portal.audit_log (empid, action, detail) VALUES ($1,$2,$3)', [
      empid, action, j.length > 4000 ? JSON.stringify({ ...detail, sample: undefined, truncated: true }) : j,
    ]);
  } catch (e) {
    console.warn('təhlükəsizlik jurnalı yazılmadı:', e.message);
  }
}

// Autentifikasiya olunmuş istifadəçinin pozuntusu. Qaytardığı xətanı çağıran atır: throw await violation(...)
export async function violation(req, kind, what, sample, orig) {
  const empid = req.user?.empid;
  const detail = { kind, what: clip(what, 300), ...context(req) };
  if (sample !== undefined && sample !== null) detail.sample = clip(sample, 500);
  let blocked = false;
  if (empid) {
    try {
      const r = await (await getPool()).query(
        `UPDATE portal.users SET blocked_at = now(), blocked_reason = $2, session_epoch = session_epoch + 1
         WHERE empid = $1 AND role <> 'admin' AND blocked_at IS NULL RETURNING 1`, [empid, clip(what, 300)]);
      blocked = r.rowCount > 0;
    } catch (e) {
      console.error('Blok yazılmadı:', e.message);
    }
    if (!blocked && req.user.role === 'admin') detail.note = 'admin avtomatik bloklanmır';
    await writeAudit(empid, blocked ? 'security.block' : 'security.violation', detail);
  }
  // Admin bloklanmır: ona əsl səbəb (məs. "Qadağan söz: portal") göstərilir
  return blocked ? new HttpError(403, VIOLATION_MSG) : orig || new HttpError(403, 'Əməliyyat qadağandır');
}

// Autentifikasiyasız hadisə (saxta token, başqa saytdan sorğu). Kimin adından olduğu dəqiq bilinmir,
// ona görə heç kəs bloklanmır, yalnız jurnala yazılır. Eyni IP + növ üçün dəqiqədə bir yazı.
const seen = new Map();
export function anon(req, kind, what, extra = {}) {
  const key = `${req.ip}|${kind}`;
  const now = Date.now();
  if (now - (seen.get(key) || 0) < 60_000) return;
  seen.set(key, now);
  if (seen.size > 5000) seen.clear();
  void writeAudit(null, 'security.anon', { kind, what, ...context(req), ...extra });
}

// Parametrdə açıq-aydın SQL injection əlaməti. Adi mətn (O'Brien, vergül, tire) buna düşmür.
const INJECTION = new RegExp(
  [
    '\\bunion\\s+(all\\s+)?select\\b',
    ';\\s*(drop|delete|insert|update|alter|truncate|exec|execute|shutdown)\\b',
    '\\b(drop|truncate)\\s+table\\b',
    '\\bxp_cmdshell\\b',
    '\\bpg_sleep\\s*\\(',
    '\\bwaitfor\\s+delay\\b',
    "'\\s*or\\s+'?\\w+'?\\s*=\\s*'?\\w+",
    '\\bor\\s+1\\s*=\\s*1\\b',
  ].join('|'),
  'i'
);
export const looksLikeInjection = (v) => typeof v === 'string' && INJECTION.test(v);
