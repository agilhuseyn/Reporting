import bcrypt from 'bcryptjs';
import { pool, initReportPool, disableReportPool } from './db.js';

const DDL = [
  `CREATE SCHEMA IF NOT EXISTS portal`,
  `CREATE TABLE IF NOT EXISTS portal.positions (
     id serial PRIMARY KEY, name text NOT NULL UNIQUE,
     parent_id int REFERENCES portal.positions(id) ON DELETE SET NULL)`,
  `CREATE TABLE IF NOT EXISTS portal.groups (id serial PRIMARY KEY, name text NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS portal.users (
     empid text PRIMARY KEY, name text NOT NULL, password_hash text,
     role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','support','user')),
     caps text[] NOT NULL DEFAULT '{}',
     position_id int REFERENCES portal.positions(id) ON DELETE SET NULL,
     active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS portal.user_groups (
     empid text REFERENCES portal.users(empid) ON DELETE CASCADE,
     group_id int REFERENCES portal.groups(id) ON DELETE CASCADE,
     PRIMARY KEY (empid, group_id))`,
  `CREATE TABLE IF NOT EXISTS portal.report_categories (
     id serial PRIMARY KEY, name_az text NOT NULL, name_en text, name_ru text)`,
  `CREATE TABLE IF NOT EXISTS portal.reports (
     id serial PRIMARY KEY, code text UNIQUE NOT NULL,
     category_id int REFERENCES portal.report_categories(id) ON DELETE SET NULL,
     kind text NOT NULL DEFAULT 'query', name_az text NOT NULL, name_en text, name_ru text,
     description text, sql text NOT NULL DEFAULT '', params jsonb NOT NULL DEFAULT '[]',
     active boolean NOT NULL DEFAULT true, version int NOT NULL DEFAULT 1,
     updated_by text, updated_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS portal.report_columns (
     report_id int REFERENCES portal.reports(id) ON DELETE CASCADE, code text NOT NULL,
     label_az text, label_en text, label_ru text,
     type text NOT NULL DEFAULT 'text', sensitivity text NOT NULL DEFAULT 'normal',
     pos int NOT NULL DEFAULT 0, PRIMARY KEY (report_id, code))`,
  `CREATE TABLE IF NOT EXISTS portal.report_versions (
     id serial PRIMARY KEY, report_id int REFERENCES portal.reports(id) ON DELETE CASCADE,
     version int NOT NULL, sql text NOT NULL, changed_by text, changed_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS portal.perm_report (
     subject_type text NOT NULL, subject_id text NOT NULL,
     report_id int REFERENCES portal.reports(id) ON DELETE CASCADE,
     can_export boolean NOT NULL DEFAULT false,
     PRIMARY KEY (subject_type, subject_id, report_id))`,
  `CREATE TABLE IF NOT EXISTS portal.perm_column (
     subject_type text NOT NULL, subject_id text NOT NULL,
     report_id int REFERENCES portal.reports(id) ON DELETE CASCADE, column_code text NOT NULL,
     mode text NOT NULL CHECK (mode IN ('show','mask','hide')),
     PRIMARY KEY (subject_type, subject_id, report_id, column_code))`,
  `CREATE TABLE IF NOT EXISTS portal.perm_value (
     id serial PRIMARY KEY, subject_type text NOT NULL, subject_id text NOT NULL,
     report_id int REFERENCES portal.reports(id) ON DELETE CASCADE, column_code text NOT NULL,
     op text NOT NULL CHECK (op IN ('in','eq','gte','lte')), value jsonb NOT NULL)`,
  `ALTER TABLE portal.report_columns ADD COLUMN IF NOT EXISTS src text`,
  `CREATE TABLE IF NOT EXISTS portal.connections (
     kind text PRIMARY KEY, config jsonb NOT NULL, secret_enc text, enabled boolean NOT NULL DEFAULT false,
     updated_at timestamptz DEFAULT now(), updated_by text)`,
  `CREATE TABLE IF NOT EXISTS portal.audit_log (
     id bigserial PRIMARY KEY, at timestamptz DEFAULT now(), empid text, action text, detail jsonb)`,
];

const PATCH_DDL = [
  `ALTER TABLE portal.users ADD COLUMN IF NOT EXISTS session_epoch int NOT NULL DEFAULT 0`,
  `ALTER TABLE portal.reports ADD COLUMN IF NOT EXISTS drill jsonb`,
  // Çöldən görünən təsadüfi UUID. Mövcud sətirlər avtomatik UUID alır; daxili açarlar dəyişmir.
  ...['reports', 'report_categories', 'positions', 'groups', 'users'].flatMap((t) => [
    `ALTER TABLE portal.${t} ADD COLUMN IF NOT EXISTS uid uuid NOT NULL DEFAULT gen_random_uuid()`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${t}_uid ON portal.${t} (uid)`,
  ]),
];

const DEMO_DDL = [
  `CREATE SCHEMA IF NOT EXISTS demo`,
  `CREATE TABLE IF NOT EXISTS demo.filial (kod text PRIMARY KEY, ad text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS demo.musteri (
     id int PRIMARY KEY, ad text NOT NULL, telefon text,
     filial_kod text REFERENCES demo.filial(kod))`,
  `CREATE TABLE IF NOT EXISTS demo.satis (
     id bigserial PRIMARY KEY, tarix date NOT NULL, filial_kod text NOT NULL,
     sn_empid text NOT NULL, musteri_id int NOT NULL,
     mebleg numeric(14,2) NOT NULL, maya numeric(14,2) NOT NULL)`,
  `CREATE OR REPLACE FUNCTION demo.fn_sales_by_filial(d1 date, d2 date)
   RETURNS TABLE(filial_code text, filial_name text, sale_count bigint, amount numeric)
   LANGUAGE sql STABLE AS $f$
     SELECT f.kod, f.ad, count(*), sum(s.mebleg)
     FROM demo.satis s JOIN demo.filial f ON f.kod = s.filial_kod
     WHERE s.tarix BETWEEN d1 AND d2
     GROUP BY f.kod, f.ad
   $f$`,
];

async function seedDemo(client) {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM demo.satis');
  if (rows[0].n > 0) return;
  console.log('Nümunə satış datası yaradılır...');
  await client.query(
    `INSERT INTO demo.filial VALUES ('BK','Bakı'),('SM','Sumqayıt'),('GN','Gəncə'),('MG','Mingəçevir'),('SK','Şəki')
     ON CONFLICT DO NOTHING`
  );
  await client.query(`
    INSERT INTO demo.musteri (id, ad, telefon, filial_kod)
    SELECT g,
      (ARRAY['Aznar','Bravo','Neftçilər','Sahil','Yeni Həyat','Qala','Orxan','Kəpəz','Şirvan','Mərkəz','Günəş','Xəzər'])[1+(g%12)]
        || ' ' || (ARRAY['MMC','Market','Ticarət','Qida','Bazar'])[1+((g/12)%5)] || ' ' || g,
      '+994 ' || (ARRAY['50','51','55','70','77'])[1+(g%5)] || ' ' || lpad(((g*7919)%1000)::text,3,'0')
        || ' ' || lpad(((g*31)%100)::text,2,'0') || ' ' || lpad(((g*17)%100)::text,2,'0'),
      (ARRAY['BK','SM','GN','MG','SK'])[1+(g%5)]
    FROM generate_series(1,60) g
    ON CONFLICT DO NOTHING`);
  await client.query('SELECT setseed(0.42)');
  await client.query(`
    WITH g AS (
      SELECT n, date '2025-09-01' + (random()*413)::int AS d,
             1+(random()*59)::int AS mid, round((200+random()*20000)::numeric,2) AS amt
      FROM generate_series(1,9000) n)
    INSERT INTO demo.satis (tarix, filial_kod, sn_empid, musteri_id, mebleg, maya)
    SELECT g.d, m.filial_kod,
      (ARRAY['100211','100236','100317','100359','100482','100501','100517','100533'])[1+(g.n%8)],
      g.mid, g.amt, round((g.amt*(0.6+random()*0.2))::numeric,2)
    FROM g JOIN demo.musteri m ON m.id = g.mid`);
}

// Yalnız oxuma rolu. Alınmasa, hesabat icrası söndürülür.
async function ensureReportRole(client) {
  const pw = process.env.REPORT_RO_PASSWORD;
  if (!pw) {
    console.warn('REPORT_RO_PASSWORD yoxdur. Hesabat icrası söndürülüb.');
    return false;
  }
  try {
    await client.query(`DO $b$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'report_ro') THEN CREATE ROLE report_ro LOGIN; END IF;
    END $b$`);
    const q = await client.query(`SELECT format('ALTER ROLE report_ro WITH LOGIN PASSWORD %L', $1::text) AS q`, [pw]);
    await client.query(q.rows[0].q);
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    await client.query(`GRANT CONNECT ON DATABASE "${db}" TO report_ro`);
    await client.query(`ALTER ROLE report_ro SET statement_timeout = '30s'`);
    await client.query(`ALTER ROLE report_ro SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE report_ro SET search_path = demo`);
    await client.query(`REVOKE ALL ON SCHEMA portal FROM report_ro`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA portal FROM report_ro`);
    await client.query(`GRANT USAGE ON SCHEMA demo TO report_ro`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA demo TO report_ro`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA demo GRANT SELECT ON TABLES TO report_ro`);
    return true;
  } catch (e) {
    console.warn('report_ro rolu yaradıla bilmədi:', e.message);
    return false;
  }
}

const SALES_SQL = `SELECT
    f.kod                    AS filial_code,
    f.ad                     AS filial_name,
    s.sn_empid               AS sales_rep_id,
    m.ad                     AS customer_name,
    m.telefon                AS phone,
    to_char(s.tarix, 'YYYY-MM') AS sale_month,
    SUM(s.mebleg)            AS amount,
    SUM(s.maya)              AS cost_price
FROM demo.satis s
JOIN demo.filial f  ON f.kod = s.filial_kod
JOIN demo.musteri m ON m.id  = s.musteri_id
WHERE s.tarix BETWEEN @tarix_bas AND @tarix_son
  AND (@filial IS NULL OR s.filial_kod = @filial)
GROUP BY f.kod, f.ad, s.sn_empid, m.ad, m.telefon, to_char(s.tarix, 'YYYY-MM')`;

const CUSTOMER_SQL = `SELECT
    m.id                     AS customer_id,
    m.ad                     AS customer_name,
    f.ad                     AS filial_name,
    COUNT(*)                 AS sale_count,
    SUM(s.mebleg)            AS amount
FROM demo.satis s
JOIN demo.musteri m ON m.id = s.musteri_id
JOIN demo.filial f  ON f.kod = s.filial_kod
WHERE s.tarix BETWEEN @tarix_bas AND @tarix_son
GROUP BY m.id, m.ad, f.ad`;

const FUNC_SQL = `SELECT * FROM demo.fn_sales_by_filial(@tarix_bas, @tarix_son)`;

const DATE_PARAMS = [
  { name: 'tarix_bas', type: 'date', required: true, default: '$monthStart', label: 'Başlanğıc tarix' },
  { name: 'tarix_son', type: 'date', required: true, default: '$today', label: 'Son tarix' },
];
const FILIAL_PARAM = {
  name: 'filial', type: 'list', required: false, label: 'Filial',
  optionsSql: 'SELECT kod AS value, ad AS label FROM demo.filial ORDER BY ad',
};

const COLS = {
  SALES_MONTHLY: [
    ['filial_code', 'Filial kodu', 'Branch code', 'Код филиала', 'text', 'normal'],
    ['filial_name', 'Filial', 'Branch', 'Филиал', 'text', 'normal'],
    ['sales_rep_id', 'Satış nümayəndəsi (EMPID)', 'Sales rep (EMPID)', 'Торговый представитель', 'text', 'normal'],
    ['customer_name', 'Müştəri', 'Customer', 'Клиент', 'text', 'normal'],
    ['phone', 'Telefon', 'Phone', 'Телефон', 'text', 'sensitive'],
    ['sale_month', 'Ay', 'Month', 'Месяц', 'text', 'normal'],
    ['amount', 'Məbləğ', 'Amount', 'Сумма', 'number', 'normal'],
    ['cost_price', 'Maya dəyəri', 'Cost price', 'Себестоимость', 'number', 'sensitive'],
  ],
  SALES_BY_CUSTOMER: [
    ['customer_id', 'Müştəri kodu', 'Customer ID', 'Код клиента', 'text', 'normal'],
    ['customer_name', 'Müştəri', 'Customer', 'Клиент', 'text', 'normal'],
    ['filial_name', 'Filial', 'Branch', 'Филиал', 'text', 'normal'],
    ['sale_count', 'Satış sayı', 'Sales count', 'Кол-во продаж', 'number', 'normal'],
    ['amount', 'Məbləğ', 'Amount', 'Сумма', 'number', 'normal'],
  ],
  FUNC_SALES_FILIAL: [
    ['filial_code', 'Filial kodu', 'Branch code', 'Код филиала', 'text', 'normal'],
    ['filial_name', 'Filial', 'Branch', 'Филиал', 'text', 'normal'],
    ['sale_count', 'Satış sayı', 'Sales count', 'Кол-во продаж', 'number', 'normal'],
    ['amount', 'Məbləğ', 'Amount', 'Сумма', 'number', 'normal'],
  ],
};

async function seedPortal(client) {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM portal.users');
  if (rows[0].n > 0) return;
  console.log('Portal nümunə məlumatları yaradılır...');
  let seedPw = process.env.SEED_PASSWORD;
  if (!seedPw) {
    if (process.env.NODE_ENV === 'production') {
      // Zəif standart parol qoyma: təsadüfi parol yarat və jurnala yaz
      seedPw = (await import('node:crypto')).randomBytes(12).toString('base64url');
      console.warn(`SEED_PASSWORD yoxdur. İlkin parol (bir dəfə göstərilir): ${seedPw}`);
    } else {
      seedPw = 'ChangeMe123';
      console.warn('SEED_PASSWORD yoxdur. İlkin parol: ChangeMe123 (yalnız lokal test üçün)');
    }
  }
  const hash = bcrypt.hashSync(seedPw, 10);

  const pos = {};
  const addPos = async (name, parent) => {
    const r = await client.query(
      'INSERT INTO portal.positions (name, parent_id) VALUES ($1,$2) RETURNING id', [name, parent ?? null]);
    pos[name] = r.rows[0].id;
  };
  await addPos('Satış nümayəndəsi');
  await addPos('İç. SN', pos['Satış nümayəndəsi']);
  await addPos('Süd SN', pos['Satış nümayəndəsi']);
  await addPos('Ərzaq SN', pos['Satış nümayəndəsi']);
  await addPos('Filial müdiri');
  await addPos('Maliyyə mütəxəssisi');
  await addPos('Dəstək komandası');

  const users = [
    ['100001', 'Sistem Admini', 'admin', ['reports', 'permissions', 'users', 'audit'], 'Dəstək komandası'],
    ['100002', 'Nərminə Əhmədova', 'support', ['reports', 'permissions', 'audit'], 'Dəstək komandası'],
    ['100003', 'Rövşən Kazımov', 'support', ['permissions'], 'Dəstək komandası'],
    ['100317', 'Məmmədov Elçin', 'user', [], 'İç. SN'],
    ['100359', 'Rzayev Kamran', 'user', [], 'İç. SN'],
    ['100211', 'Həsənov Tural', 'user', [], 'Süd SN'],
    ['100482', 'Əliyev Rəşad', 'user', [], 'Süd SN'],
    ['100236', 'Quliyeva Leyla', 'user', [], 'Ərzaq SN'],
    ['100501', 'Bayramov Murad', 'user', [], 'Filial müdiri'],
  ];
  for (const [empid, name, role, caps, p] of users) {
    await client.query(
      'INSERT INTO portal.users (empid,name,password_hash,role,caps,position_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [empid, name, hash, role, caps, pos[p]]);
  }
  const g = await client.query(`INSERT INTO portal.groups (name) VALUES ('Satış şöbəsi') RETURNING id`);
  for (const e of ['100317', '100359', '100211', '100482', '100236']) {
    await client.query('INSERT INTO portal.user_groups VALUES ($1,$2)', [e, g.rows[0].id]);
  }

  const cat = {};
  for (const [k, az, en, ru] of [
    ['sales', 'Satış', 'Sales', 'Продажи'],
    ['finance', 'Maliyyə', 'Finance', 'Финансы'],
  ]) {
    const r = await client.query(
      'INSERT INTO portal.report_categories (name_az,name_en,name_ru) VALUES ($1,$2,$3) RETURNING id', [az, en, ru]);
    cat[k] = r.rows[0].id;
  }

  const rep = {};
  const addReport = async (code, kind, az, en, ru, desc, sql, params) => {
    const r = await client.query(
      `INSERT INTO portal.reports (code,category_id,kind,name_az,name_en,name_ru,description,sql,params,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'100001') RETURNING id`,
      [code, cat.sales, kind, az, en, ru, desc, sql, JSON.stringify(params)]);
    rep[code] = r.rows[0].id;
    await client.query('INSERT INTO portal.report_versions (report_id,version,sql,changed_by) VALUES ($1,1,$2,$3)',
      [rep[code], sql, '100001']);
    let i = 0;
    for (const [c, a, e, ru2, t, s] of COLS[code]) {
      await client.query(
        `INSERT INTO portal.report_columns (report_id,code,label_az,label_en,label_ru,type,sensitivity,pos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [rep[code], c, a, e, ru2, t, s, i++]);
    }
  };
  await addReport('SALES_MONTHLY', 'query', 'Satış hesabatı (aylıq)', 'Sales report (monthly)',
    'Отчёт по продажам (месяц)', 'Satışlar filial, nümayəndə və müştəri üzrə.', SALES_SQL,
    [...DATE_PARAMS, FILIAL_PARAM]);
  await addReport('SALES_BY_CUSTOMER', 'query', 'Müştəri üzrə satış', 'Sales by customer',
    'Продажи по клиентам', 'Müştəri üzrə cəm.', CUSTOMER_SQL, DATE_PARAMS);
  await addReport('FUNC_SALES_FILIAL', 'function', 'Filial üzrə satış (funksiya)', 'Sales by branch (function)',
    'Продажи по филиалам (функция)', 'Verilənlər bazası funksiyasından.', FUNC_SQL, DATE_PARAMS);

  // Nümunə yetkilər. Satış nümayəndəsi (üst kateqoriya): alt vəzifələr miras alır.
  const parent = String(pos['Satış nümayəndəsi']);
  const sud = String(pos['Süd SN']);
  const SM = rep.SALES_MONTHLY;
  for (const code of ['SALES_MONTHLY', 'SALES_BY_CUSTOMER']) {
    await client.query(`INSERT INTO portal.perm_report VALUES ('position',$1,$2,true)`, [parent, rep[code]]);
  }
  const colModes = {
    filial_code: 'show', filial_name: 'show', sales_rep_id: 'show', customer_name: 'show',
    phone: 'mask', sale_month: 'show', amount: 'show', cost_price: 'hide',
  };
  for (const [c, m] of Object.entries(colModes)) {
    await client.query(`INSERT INTO portal.perm_column VALUES ('position',$1,$2,$3,$4)`, [parent, SM, c, m]);
  }
  for (const c of ['customer_id', 'customer_name', 'filial_name', 'sale_count', 'amount']) {
    await client.query(`INSERT INTO portal.perm_column VALUES ('position',$1,$2,$3,'show')`,
      [parent, rep.SALES_BY_CUSTOMER, c]);
  }
  await client.query(
    `INSERT INTO portal.perm_value (subject_type,subject_id,report_id,column_code,op,value) VALUES
     ('position',$1,$2,'filial_name','in','["Bakı","Sumqayıt"]'),
     ('position',$1,$2,'sale_month','gte','"$ym-12"'),
     ('position',$3,$2,'filial_name','in','["Bakı"]')`, [parent, SM, sud]);
  // Süd SN: məbləğ gizlədilir (qadağan üstündür)
  await client.query(`INSERT INTO portal.perm_column VALUES ('position',$1,$2,'amount','hide')`, [sud, SM]);
  // Şəxsi əlavə yetki nümunəsi: Əliyev Rəşad üçün "Görsün" (qadağan üstün gəlir)
  await client.query(`INSERT INTO portal.perm_column VALUES ('user','100482',$1,'amount','show')`, [SM]);
}

export async function migrate() {
  const client = await pool.connect();
  try {
    // Eyni anda iki nüsxə başlasa (yenidən deploy), miqrasiya növbə ilə gedir
    await client.query('SELECT pg_advisory_lock(7770)');
    for (const q of DDL) await client.query(q);
    for (const q of PATCH_DDL) await client.query(q);
    for (const q of DEMO_DDL) await client.query(q);
    await seedDemo(client);
    const ok = await ensureReportRole(client);
    await seedPortal(client);
    if (ok) initReportPool();
    else disableReportPool();
    return ok;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7770)').catch(() => {});
    client.release();
  }
}
