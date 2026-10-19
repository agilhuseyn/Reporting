// Active Directory girişi (LDAP protokolu ilə). Servis hesabı lazım deyil:
// istifadəçi öz domen adı və parolu ilə AD-yə qoşulur, parol düzdürsə qəbul edilir.
import { HttpError } from './errors.js';

async function lib() {
  try {
    return await import('ldapts');
  } catch {
    throw new HttpError(500, 'ldapts paketi quraşdırılmayıb (npm install)');
  }
}

const esc = (v) => String(v).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const first = (v) => (Array.isArray(v) ? first(v[0]) : v == null ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export const adUrl = (cfg) => cfg.url || `${cfg.ssl ? 'ldaps' : 'ldap'}://${cfg.host}:${cfg.port || (cfg.ssl ? 636 : 389)}`;

// company.local -> DC=company,DC=local
export function baseFromDomain(domain) {
  return domain && domain.includes('.') ? domain.split('.').map((p) => `DC=${p}`).join(',') : '';
}

// Daxil edilən ad: "ad", "DOMEN\ad" və ya "ad@domen.local" ola bilər.
export function bindName(cfg, login) {
  if (login.includes('\\') || login.includes('@')) return login;
  if (cfg.domain?.includes('.')) return `${login}@${cfg.domain}`;
  return cfg.domain ? `${cfg.domain}\\${login}` : login;
}
export const samName = (login) => (login.includes('\\') ? login.split('\\')[1] : login.includes('@') ? login.split('@')[0] : login);

async function open(cfg) {
  const { Client } = await lib();
  const c = new Client({ url: adUrl(cfg), timeout: 8000, connectTimeout: 8000, tlsOptions: { rejectUnauthorized: cfg.tlsReject !== false } });
  if (cfg.startTls) await c.startTLS({ rejectUnauthorized: cfg.tlsReject !== false });
  return c;
}

const wrapErr = (e) => (e instanceof HttpError ? e : new HttpError(502, `Active Directory xətası: ${e.message || e}`));
const badCreds = (e) => /invalid.?credentials|data 52e|49/i.test(`${e.name} ${e.code} ${e.message}`);

// Uğurlu olsa { empid, dn? } qaytarır. Parol səhvdirsə null. Boş parol anonim girişə çevrildiyi üçün rədd edilir.
export async function adSignIn(cfg, login, password) {
  if (!login || login.length > 128 || !password) return null;
  const c = await open(cfg).catch((e) => { throw wrapErr(e); });
  try {
    try {
      await c.bind(bindName(cfg, login), password);
    } catch (e) {
      if (badCreds(e)) return null;
      throw e;
    }
    if (!cfg.empidAttr) return { empid: samName(login) };
    const base = cfg.baseDn || baseFromDomain(cfg.domain);
    const { searchEntries } = await c.search(base, {
      scope: 'sub', filter: `(sAMAccountName=${esc(samName(login))})`, attributes: [cfg.empidAttr], sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null;
    const empid = first(searchEntries[0][cfg.empidAttr]);
    return empid ? { empid, dn: searchEntries[0].dn } : null;
  } catch (e) {
    throw wrapErr(e);
  } finally {
    await c.unbind().catch(() => {});
  }
}

export async function testAd(cfg, login, password) {
  const steps = [];
  const t0 = Date.now();
  const done = () => ({ ok: steps.every((s) => s.ok), steps, ms: Date.now() - t0 });
  try {
    const c = await open(cfg);
    await c.unbind().catch(() => {});
    steps.push({ step: 'connect', ok: true });
  } catch (e) {
    steps.push({ step: 'connect', ok: false, error: e.message });
    return done();
  }
  if (!login || !password) {
    steps.push({ step: 'userBind', ok: false, error: 'Test istifadəçi adı və parolunu yazın' });
    return done();
  }
  try {
    const u = await adSignIn(cfg, login.trim(), password);
    steps.push(u ? { step: 'userBind', ok: true } : { step: 'userBind', ok: false, error: cfg.empidAttr ? 'Parol səhvdir və ya EMPID atributu tapılmadı' : 'Ad və ya parol səhvdir' });
    if (u && cfg.empidAttr) steps.push({ step: 'search', ok: true, detail: `EMPID ${u.empid}` });
  } catch (e) {
    steps.push({ step: 'userBind', ok: false, error: e.message });
  }
  return done();
}
