// Təhlükəsizlik qatları: başlıqlar, CSRF, sürət limiti, paralel icra limiti, "yalnız tətbiq" qapısı.
import zlib from 'node:zlib';
import { HttpError } from './errors.js';
import { anon } from './guard.js';

const PROD = process.env.NODE_ENV === 'production';

// ---------- Başlıqlar ----------
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (PROD || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if ((req.url || '').startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
}

// ---------- CSRF: başqa saytdan gələn dəyişdirici sorğuları rədd edir ----------
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export function sameOrigin(req, _res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && origin !== 'null') {
    let oh = '';
    try {
      oh = new URL(origin).host;
    } catch {
      return next(new HttpError(403, 'Qadağan olunmuş mənbə'));
    }
    if (oh !== host) { anon(req, 'csrf', 'Başqa saytdan dəyişdirici sorğu', { origin: String(origin).slice(0, 200) }); return next(new HttpError(403, 'Qadağan olunmuş mənbə')); }
  } else if (origin === 'null') {
    anon(req, 'csrf', 'Origin=null ilə dəyişdirici sorğu');
    return next(new HttpError(403, 'Qadağan olunmuş mənbə'));
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) {
    anon(req, 'csrf', 'Başqa saytdan dəyişdirici sorğu', { site });
    return next(new HttpError(403, 'Qadağan olunmuş mənbə'));
  }
  next();
}

// ---------- Sürət limiti (yaddaşda, sürüşən pəncərə) ----------
const buckets = new Set();
export function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  buckets.add(hits);
  return {
    hit(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      list.push(now);
      hits.set(key, list);
      return list.length > max;
    },
    count(key) {
      const now = Date.now();
      return (hits.get(key) || []).filter((t) => now - t < windowMs).length;
    },
    add(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      list.push(now);
      hits.set(key, list);
    },
    clear(key) {
      hits.delete(key);
    },
    windowMs,
    max,
  };
}
// Yaddaş sızmasın: köhnə açarları təmizlə
setInterval(() => {
  for (const m of buckets) {
    if (m.size > 20000) m.clear();
  }
}, 60_000).unref();

export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Çox sorğu. Bir az gözləyin.' }) {
  const lim = makeLimiter({ windowMs, max });
  return (req, _res, next) => (lim.hit(key(req)) ? next(new HttpError(429, message)) : next());
}

// ---------- Paralel icra limiti (yaddaşı və bazanı qorumaq üçün) ----------
export function makeGate({ max, maxQueue, waitMs }) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const w = queue.shift();
    if (w) {
      active++;
      clearTimeout(w.timer);
      w.resolve();
    }
  };
  return {
    stats: () => ({ active, queued: queue.length }),
    async run(fn) {
      if (active >= max) {
        if (queue.length >= maxQueue) throw new HttpError(503, 'Server məşğuldur. Bir az sonra yenidən cəhd edin.');
        await new Promise((resolve, reject) => {
          const w = { resolve };
          w.timer = setTimeout(() => {
            const i = queue.indexOf(w);
            if (i >= 0) queue.splice(i, 1);
            reject(new HttpError(503, 'Server məşğuldur. Bir az sonra yenidən cəhd edin.'));
          }, waitMs);
          queue.push(w);
        });
      } else {
        active++;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

// ---------- "Yalnız tətbiq" qapısı ----------
// Quraşdırılmış tətbiq (standalone) hər sorğuya X-Portal-App başlığı əlavə edir.
// Qeyd: bu, adi brauzer tabını bağlayır, lakin qərarlı istifadəçi başlığı saxtalaşdıra bilər.
// Əsl qorunma: parol, cihaz təsdiqi və şəbəkə (IP) məhdudiyyətidir.
export const appOnly = () => (process.env.APP_ONLY ? process.env.APP_ONLY === '1' : PROD);

export function appGate(req, _res, next) {
  if (!appOnly()) return next();
  const url = (req.url || '').split('?')[0];
  if (url === '/app-config') return next();
  if (req.headers['x-portal-app'] === '1') return next();
  next(new HttpError(403, 'Bu portal yalnız quraşdırılmış tətbiq vasitəsilə açılır'));
}

// ---------- JSON cavabının sıxılması (20 000-50 000 sətirlik nəticə 4 MB-dan 400-500 KB-a düşür) ----------
export function gzipJson(req, res, next) {
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  res.json = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!accepts || body.length < 8192) return res.end(body);
    zlib.gzip(body, { level: 4 }, (err, buf) => {
      if (err) return res.end(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      return res.end(buf);
    });
  };
  next();
}
