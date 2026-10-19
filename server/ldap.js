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

async function open(cfg) {
  const { Client } = await lib();
  const c = new Client({
    url: cfg.url, timeout: 8000, connectTimeout: 8000,
    tlsOptions: { rejectUnauthorized: cfg.tlsReject !== false },
  });
  if (cfg.startTls) await c.startTLS({ rejectUnauthorized: cfg.tlsReject !== false });
  return c;
}

const wrapErr = (e) => (e instanceof HttpError ? e : new HttpError(502, `LDAP xətası: ${e.message || e}`));

// Servis hesabı ilə girişi axtarır. Tapılmasa null qaytarır.
export async function ldapFindUser(cfg, bindPassword, login) {
  if (!login || login.length > 128) return null;
  const c = await open(cfg).catch((e) => {
    throw wrapErr(e);
  });
  try {
    if (cfg.bindDn) await c.bind(cfg.bindDn, bindPassword);
    const attrs = ['dn', ...(cfg.empidAttr ? [cfg.empidAttr] : [])];
    let entries;
    try {
      ({ searchEntries: entries } = await c.search(cfg.baseDn, {
        scope: 'sub', filter: cfg.userFilter.replaceAll('{login}', esc(login)), attributes: attrs, sizeLimit: 3,
      }));
    } catch (e) {
      if (/size.?limit/i.test(`${e.name} ${e.message}`)) return null; // bir neçə nəticə: qeyri-müəyyən
      throw e;
    }
    if (entries.length !== 1) return null;
    const e = entries[0];
    return { dn: e.dn, empid: cfg.empidAttr ? first(e[cfg.empidAttr]) || null : login };
  } catch (e) {
    throw wrapErr(e);
  } finally {
    await c.unbind().catch(() => {});
  }
}

// İstifadəçinin öz parolu ilə giriş. Boş parol anonim girişə çevrildiyi üçün rədd edilir.
export async function ldapVerify(cfg, dn, password) {
  if (!password) return false;
  const c = await open(cfg).catch((e) => {
    throw wrapErr(e);
  });
  try {
    await c.bind(dn, password);
    return true;
  } catch (e) {
    if (/invalid.?credentials|49/i.test(`${e.name} ${e.code} ${e.message}`)) return false;
    throw wrapErr(e);
  } finally {
    await c.unbind().catch(() => {});
  }
}

export async function testLdap(cfg, bindPassword, login, password) {
  const steps = [];
  const t0 = Date.now();
  try {
    const c = await open(cfg);
    steps.push({ step: 'connect', ok: true });
    try {
      if (cfg.bindDn) await c.bind(cfg.bindDn, bindPassword);
      steps.push({ step: 'bind', ok: true });
    } catch (e) {
      steps.push({ step: 'bind', ok: false, error: e.message });
      await c.unbind().catch(() => {});
      return { ok: false, steps, ms: Date.now() - t0 };
    }
    await c.unbind().catch(() => {});
  } catch (e) {
    steps.push({ step: steps.length ? 'bind' : 'connect', ok: false, error: e.message });
    return { ok: false, steps, ms: Date.now() - t0 };
  }
  if (login) {
    try {
      const u = await ldapFindUser(cfg, bindPassword, login);
      steps.push(u ? { step: 'search', ok: true, detail: `${u.dn}${u.empid ? ' · EMPID ' + u.empid : ''}` } : { step: 'search', ok: false, error: 'not found' });
      if (u && password) {
        const ok = await ldapVerify(cfg, u.dn, password);
        steps.push({ step: 'userBind', ok, ...(ok ? {} : { error: 'invalid credentials' }) });
      }
    } catch (e) {
      steps.push({ step: 'search', ok: false, error: e.message });
    }
  }
  return { ok: steps.every((s) => s.ok), steps, ms: Date.now() - t0 };
}
