import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { loadConn } from './connections.js';
import { adSignIn } from './ldap.js';

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
  if (!u || !u.password_hash) return null;
  return (await bcrypt.compare(password, u.password_hash)) ? u : null;
}

const fails = new Map();
function tooMany(key) {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  fails.set(key, list);
  return list.length >= 8;
}

export async function login(req, res) {
  const empid = String(req.body?.empid || '').trim();
  const password = String(req.body?.password || '');
  const key = `${req.ip}|${empid}`;
  if (tooMany(key)) throw new HttpError(429, 'Çox cəhd. 10 dəqiqə gözləyin.');
  const u = await verifyCredentials(empid, password);
  if (!u) {
    fails.get(key).push(Date.now());
    throw new HttpError(401, 'Ad və ya parol yanlışdır');
  }
  const token = jwt.sign({ empid: u.empid }, secret, { expiresIn: '8h' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 3600 * 1000,
  });
  await audit(u.empid, 'login', {});
  res.json(publicUser(u));
}

export function logout(_req, res) {
  res.clearCookie('token');
  res.json({ ok: true });
}

export function publicUser(u) {
  const caps = u.role === 'admin' ? ALL_CAPS : u.role === 'support' ? u.caps || [] : [];
  return { empid: u.empid, name: u.name, role: u.role, caps, position_id: u.position_id };
}

export async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) throw new HttpError(401, 'Giriş tələb olunur');
    const { empid } = jwt.verify(token, secret);
    const r = await pool.query('SELECT * FROM portal.users WHERE empid = $1 AND active', [empid]);
    if (!r.rows[0]) throw new HttpError(401, 'Giriş tələb olunur');
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

export async function audit(empid, action, detail) {
  try {
    await pool.query('INSERT INTO portal.audit_log (empid, action, detail) VALUES ($1,$2,$3)', [
      empid, action, JSON.stringify(detail ?? {}),
    ]);
  } catch (e) {
    console.warn('audit yazılmadı:', e.message);
  }
}
