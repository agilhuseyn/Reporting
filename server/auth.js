import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { loadConn } from './connections.js';
import { adSignIn } from './ldap.js';
import { makeLimiter, makeGate } from './security.js';

let secret = process.env.JWT_SECRET;
if (!secret) {
  console.warn('JWT_SECRET yoxdur. Müvəqqəti açar yaradıldı (hər yenidən başlamada sessiyalar silinir).');
  secret = crypto.randomBytes(32).toString('hex');
}

export const ALL_CAPS = ['reports', 'permissions', 'users', 'audit'];

// Giriş provayderi. Active Directory aktivdirsə: domen adı + parol. Deyilsə: lokal parol.
// İstifadəçilər həmişə sistemdən (portal.users) gəlir, LDAP yalnız parolu yoxlayır.
// Admin hesabı LDAP düşəndə girə bilsin deyə lokal parolla da girə bilir.
async function localUser(empid) {
  const r = await pool.query('SELECT * FROM portal.users WHERE empid = $1 AND active', [empid]);
  return r.rows[0] || null;
}

async function verifyCredentials(login, password) {
  const ldap = await loadConn('ldap').catch(() => null);
  if (ldap?.enabled) {
    const local = await localUser(login);
    if (local?.role === 'admin' && local.password_hash && (await bcrypt.compare(password, local.password_hash))) return local;
    const found = await adSignIn(ldap.config, login, password);
    if (!found?.empid) return null;
    const u = await localUser(found.empid);
    if (!u) throw new HttpError(403, 'Bu istifadəçi portalda qeydiyyatda deyil');
    return u;
  }
  const u = await localUser(login);
  const ok = await bcrypt.compare(password, u?.password_hash || DUMMY_HASH);
  return u && u.password_hash && ok ? u : null;
}

// Giriş qorunması: IP+EMPID, yalnız EMPID və yalnız IP üzrə ayrıca limit.
const failPair = makeLimiter({ windowMs: 10 * 60 * 1000, max: 8 });
const failUser = makeLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const failIp = makeLimiter({ windowMs: 10 * 60 * 1000, max: 300 }); // ortaq IP (NAT) arxasında çox istifadəçi ola bilər
// bcrypt CPU yükləyir: eyni anda ən çox 3 yoxlama, qalanı növbədə gözləyir
const loginGate = makeGate({ max: 3, maxQueue: 400, waitMs: 30_000 });
const attempts = makeLimiter({ windowMs: 60 * 1000, max: 600 }); // IP başına dəqiqədə cəhd

// İstifadəçi tapılmayanda da bcrypt işlədilir ki, cavab vaxtı ilə EMPID-in varlığı bilinməsin.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 10);

export async function login(req, res) {
  const empid = String(req.body?.empid ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!empid || !password || empid.length > 64 || password.length > 256) throw new HttpError(401, 'Ad və ya parol yanlışdır');
  const ip = req.ip || '?';
  if (attempts.hit(ip)) throw new HttpError(429, 'Çox cəhd. Bir az gözləyin.');
  if (failPair.count(`${ip}|${empid}`) >= failPair.max || failUser.count(empid) >= failUser.max || failIp.count(ip) >= failIp.max) {
    throw new HttpError(429, 'Çox cəhd. 10 dəqiqə gözləyin.');
  }
  let u = null;
  try {
    u = await loginGate.run(() => verifyCredentials(empid, password));
  } catch (e) {
    // Xarici sistemin (AD) daxili xətası giriş ekranına çıxmasın
    if (e instanceof HttpError && [403, 503].includes(e.status)) throw e;
    console.error('Giriş yoxlama xətası:', e.message);
    throw new HttpError(503, 'Giriş xidməti müvəqqəti əlçatmazdır');
  }
  if (!u) {
    failPair.add(`${ip}|${empid}`);
    failUser.add(empid);
    failIp.add(ip);
    throw new HttpError(401, 'Ad və ya parol yanlışdır');
  }
  failPair.clear(`${ip}|${empid}`);
  const token = jwt.sign({ empid: u.empid, e: u.session_epoch || 0 }, secret, { expiresIn: '8h', algorithm: 'HS256' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 3600 * 1000,
    path: '/',
  });
  await audit(u.empid, 'login', {});
  res.json(publicUser(u));
}

export async function logout(req, res) {
  // Çıxışda bu istifadəçinin bütün köhnə tokenləri etibarsız olur
  try {
    const { empid } = jwt.verify(req.cookies?.token || '', secret, { algorithms: ['HS256'] });
    await pool.query('UPDATE portal.users SET session_epoch = session_epoch + 1 WHERE empid = $1', [empid]);
  } catch {
    /* token yoxdursa və ya etibarsızdırsa, yalnız cookie silinir */
  }
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
}

export function publicUser(u) {
  const caps = u.role === 'admin' ? ALL_CAPS : u.role === 'support' ? u.caps || [] : [];
  return { id: u.uid, empid: u.empid, name: u.name, role: u.role, caps };
}

export async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) throw new HttpError(401, 'Giriş tələb olunur');
    const { empid, e } = jwt.verify(token, secret, { algorithms: ['HS256'] });
    const r = await pool.query('SELECT * FROM portal.users WHERE empid = $1 AND active', [empid]);
    if (!r.rows[0] || (r.rows[0].session_epoch || 0) !== (e || 0)) throw new HttpError(401, 'Giriş tələb olunur');
    req.user = publicUser(r.rows[0]);
    next();
  } catch (e) {
    next(e instanceof HttpError ? e : new HttpError(401, 'Giriş tələb olunur'));
  }
}

export const needCap = (...caps) => (req, _res, next) => {
  if (caps.some((c) => req.user.caps.includes(c))) return next();
  next(new HttpError(403, 'Bu əməliyyat üçün yetkiniz yoxdur'));
};

export const needAdmin = (req, _res, next) =>
  req.user.role === 'admin' ? next() : next(new HttpError(403, 'Yalnız admin'));

function safeDetail(d) {
  const j = JSON.stringify(d ?? {});
  return j.length > 4000 ? JSON.stringify({ truncated: true, size: j.length }) : j;
}

export async function audit(empid, action, detail) {
  try {
    await pool.query('INSERT INTO portal.audit_log (empid, action, detail) VALUES ($1,$2,$3)', [
      empid, action, safeDetail(detail),
    ]);
  } catch (e) {
    console.warn('audit yazılmadı:', e.message);
  }
}
