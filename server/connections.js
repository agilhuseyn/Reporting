import pg from 'pg';
import { pool, reportPool } from './db.js';
import { HttpError } from './errors.js';
import { encrypt, decrypt } from './secret.js';

const KINDS = ['sql', 'ldap'];

export async function loadConn(kind) {
  const r = await pool.query('SELECT * FROM portal.connections WHERE kind = $1', [kind]);
  const row = r.rows[0];
  if (!row) return null;
  return { config: row.config, password: decrypt(row.secret_enc), enabled: row.enabled, updated_at: row.updated_at, updated_by: row.updated_by };
}

export async function publicConns() {
  const out = {};
  for (const k of KINDS) {
    const c = await loadConn(k).catch(() => null);
    out[k] = c ? { config: c.config, hasPassword: !!c.password, enabled: c.enabled, updated_at: c.updated_at, updated_by: c.updated_by } : null;
  }
  return out;
}

// ---------- doğrulama ----------
const str = (v, max = 255) => String(v ?? '').trim().slice(0, max);

export function cleanConfig(kind, c = {}) {
  if (kind === 'sql') {
    const type = c.type === 'mssql' ? 'mssql' : 'postgres';
    const host = str(c.host, 255);
    if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new HttpError(400, 'Server (host) yanlışdır');
    const port = Number(c.port) || (type === 'mssql' ? 1433 : 5432);
    if (!(port >= 1 && port <= 65535)) throw new HttpError(400, 'Port yanlışdır');
    const database = str(c.database, 128);
    const user = str(c.user, 128);
    if (!database || !user) throw new HttpError(400, 'Baza və istifadəçi adı məcburidir');
    return { type, host, port, database, user, encrypt: !!c.encrypt, trustServerCertificate: !!c.trustServerCertificate, ssl: !!c.ssl };
  }
  const url = str(c.url, 255);
  if (!/^ldaps?:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, 'LDAP ünvanı ldap:// və ya ldaps:// ilə başlamalıdır');
  const userFilter = str(c.userFilter, 500) || '(sAMAccountName={login})';
  if (!userFilter.includes('{login}')) throw new HttpError(400, 'Axtarış filtrində {login} olmalıdır');
  const baseDn = str(c.baseDn, 500);
  if (!baseDn) throw new HttpError(400, 'Base DN məcburidir');
  return {
    url, baseDn, bindDn: str(c.bindDn, 500), userFilter, empidAttr: str(c.empidAttr, 100),
    startTls: !!c.startTls, tlsReject: c.tlsReject !== false,
  };
}

export async function saveConn(kind, config, password, enabled, by) {
  if (!KINDS.includes(kind)) throw new HttpError(404, 'Naməlum bağlantı');
  const old = await loadConn(kind).catch(() => null);
  const pw = password ? password : old?.password || '';
  await pool.query(
    `INSERT INTO portal.connections (kind, config, secret_enc, enabled, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,now(),$5)
     ON CONFLICT (kind) DO UPDATE SET config = $2, secret_enc = $3, enabled = $4, updated_at = now(), updated_by = $5`,
    [kind, JSON.stringify(config), pw ? encrypt(pw) : null, !!enabled, by]
  );
  if (kind === 'sql') await dropSource();
}

export async function deleteConn(kind) {
  await pool.query('DELETE FROM portal.connections WHERE kind = $1', [kind]);
  if (kind === 'sql') await dropSource();
}

// ---------- SQL mənbəyi ----------
let cached = null; // { key, source }

async function dropSource() {
  const old = cached;
  cached = null;
  if (old?.source.close) await old.source.close().catch(() => {});
}

async function buildMssql(cfg, password) {
  let mssql;
  try {
    mssql = (await import('mssql')).default;
  } catch {
    throw new HttpError(500, 'mssql paketi quraşdırılmayıb (npm install)');
  }
  const p = new mssql.ConnectionPool({
    server: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate, readOnlyIntent: true },
    requestTimeout: 30000, connectionTimeout: 10000, pool: { max: 5 },
  });
  p.on('error', (e) => console.error('mssql xətası:', e.message));
  await p.connect().catch((e) => {
    throw new HttpError(400, `MSSQL qoşulma xətası: ${e.message}`);
  });
  return { dialect: 'mssql', lib: mssql, pool: p, close: () => p.close() };
}

function buildPg(cfg, password) {
  const p = new pg.Pool({
    host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false, max: 5, connectionTimeoutMillis: 10000,
  });
  p.on('error', (e) => console.error('sql pool xətası:', e.message));
  return { dialect: 'pg', pool: p, close: () => p.end() };
}

export async function buildSource(cfg, password) {
  return cfg.type === 'mssql' ? buildMssql(cfg, password) : buildPg(cfg, password);
}

// Hesabatların işləyəcəyi baza. Xarici bağlantı aktivdirsə o, yoxsa daxili test bazası (report_ro).
export async function getSqlSource() {
  const c = await loadConn('sql').catch(() => null);
  if (c?.enabled) {
    const key = String(c.updated_at);
    if (cached?.key !== key) {
      await dropSource();
      cached = { key, source: await buildSource(c.config, c.password) };
    }
    return cached.source;
  }
  if (!reportPool) throw new HttpError(503, 'Hesabat bazası qoşulmayıb (report_ro rolu yoxdur). README-yə baxın.');
  return { dialect: 'pg', pool: reportPool, builtin: true };
}

// Bağlantı testi: qoşulur, hansı hesabla girdiyini və yazma yetkisi olub-olmadığını yoxlayır.
export async function testSql(config, password) {
  const t0 = Date.now();
  const src = await buildSource(config, password);
  try {
    const warnings = [];
    let info;
    if (src.dialect === 'mssql') {
      const r = await src.pool.request().query(
        `SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50)) AS version, SUSER_NAME() AS who, DB_NAME() AS db,
                IS_MEMBER('db_datawriter') AS w, IS_MEMBER('db_owner') AS o, IS_SRVROLEMEMBER('sysadmin') AS sa`
      );
      const x = r.recordset[0];
      info = `MSSQL ${x.version} · ${x.db} · ${x.who}`;
      if (x.sa === 1) warnings.push('sysadmin');
      if (x.o === 1) warnings.push('db_owner');
      if (x.w === 1) warnings.push('db_datawriter');
    } else {
      const c = await src.pool.connect();
      try {
        const r = await c.query(
          `SELECT version() AS version, current_user AS who, current_database() AS db,
                  (SELECT rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = current_user) AS powerful`
        );
        const x = r.rows[0];
        info = `${x.version.split(' ').slice(0, 2).join(' ')} · ${x.db} · ${x.who}`;
        if (x.powerful) warnings.push('superuser');
      } finally {
        c.release();
      }
    }
    return { ok: true, info, warnings, ms: Date.now() - t0 };
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, e.message);
  } finally {
    await src.close().catch(() => {});
  }
}
