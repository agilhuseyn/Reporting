// Satış şirkəti üçün genişləndirilmiş TEST datası (demo sxemi).
// Bütün data uydurmadır. Təkrar işə salınanda yenidən yaradılmır.

export const SALES_TABLES = [
  'filial', 'musteri', 'satis', 'kateqoriya', 'mehsul', 'tedarukcu', 'anbar', 'isci',
  'satis_sifaris', 'satis_setir', 'qaime', 'odenis', 'qaytarma',
  'satinalma_sifaris', 'satinalma_setir', 'tedarukcu_odenisi',
  'anbar_hereketi', 'anbar_qaliq', 'satis_plani', 'xerc',
];

const CATS = [
  ['Süd məhsulları', ['Süd', 'Qatıq', 'Ayran', 'Kefir', 'Smetana', 'Kərə yağı', 'Pendir', 'Süzmə']],
  ['Ət və quş məhsulları', ['Dana əti', 'Qoyun əti', 'Toyuq filesi', 'Kolbasa', 'Sosis', 'Hind əti', 'Ürək-ciyər', 'Qiymə']],
  ['Çörək və unlu məmulatlar', ['Çörək', 'Lavaş', 'Peçenye', 'Kek', 'Kruasan', 'Lahmacun xəmiri', 'Kökə', 'Un']],
  ['İçkilər', ['Su', 'Qazlı su', 'Şirə', 'Çay', 'Qəhvə', 'Kola', 'Limonad', 'Enerji içkisi']],
  ['Dondurma və dondurulmuş', ['Dondurma', 'Pelmeni', 'Dondurulmuş tərəvəz', 'Naget', 'Pizza', 'Kartof fri', 'Balıq filesi', 'Dondurulmuş meyvə']],
  ['Qənnadı', ['Şokolad', 'Konfet', 'Vafli', 'Paxlava', 'Şəkərbura', 'Marmelad', 'Halva', 'Jele']],
  ['Taxıl və makaron', ['Düyü', 'Qarabaşaq', 'Makaron', 'Mərci', 'Noxud', 'Yulaf', 'Manna', 'Lobya']],
  ['Konserv və souslar', ['Pomidor pastası', 'Ketçup', 'Mayonez', 'Zeytun', 'Xıyar turşusu', 'Lobya konservi', 'Qarğıdalı konservi', 'Tuna']],
  ['Meyvə və tərəvəz', ['Alma', 'Banan', 'Pomidor', 'Xıyar', 'Kartof', 'Soğan', 'Portağal', 'Üzüm']],
  ['Təmizlik vasitələri', ['Yuyucu toz', 'Qab yuyan', 'Döşəmə təmizləyici', 'Ağardıcı', 'Şüşə təmizləyici', 'Əl sabunu', 'Kir təmizləyici', 'Yumşaldıcı']],
  ['Şəxsi gigiyena', ['Şampun', 'Diş pastası', 'Duş geli', 'Dezodorant', 'Kağız dəsmal', 'Tualet kağızı', 'Islaq salfet', 'Krem']],
  ['Ev əşyaları', ['Qazan', 'Tava', 'Bıçaq dəsti', 'Stəkan dəsti', 'Boşqab dəsti', 'Termos', 'Plastik qab', 'Süfrə']],
];
const VARIANTS = ['Klassik', 'Premium', 'Ekonom', 'Ailə qablaşdırması'];
const SUPPLIERS = [
  'Azərsüd', 'Bakı Qida', 'Xəzər Ət', 'Gəncə Çörək', 'Şirvan Meyvə', 'Qafqaz İçki', 'Abşeron Konserv', 'Kürdəmir Taxıl',
  'Sumqayıt Kimya', 'Mingəçevir Plastik', 'Şəki Qənnadı', 'Lənkəran Çay', 'Naxçıvan Qida', 'Quba Alma', 'Şamaxı Pendir',
  'Dünya Ticarət', 'Avrasiya Distribyutor', 'Orxan İdxal', 'Kəpəz Təchizat', 'Sahil Logistika',
];

const q = (c, sql, params) => c.query(sql, params);

export async function seedSales(client) {
  await q(client, 'SELECT pg_advisory_xact_lock(7771)');
  const has = await q(client, `SELECT to_regclass('demo.satis_sifaris') IS NOT NULL AS t`);
  if (has.rows[0].t) {
    const n = await q(client, 'SELECT count(*)::int AS n FROM demo.satis_sifaris');
    if (n.rows[0].n > 0) return false;
  }
  const t0 = Date.now();

  // ---------- cədvəllər ----------
  await q(client, `ALTER TABLE demo.musteri
     ADD COLUMN IF NOT EXISTS voen text, ADD COLUMN IF NOT EXISTS sheher text,
     ADD COLUMN IF NOT EXISTS qrup text, ADD COLUMN IF NOT EXISTS kredit_limit numeric(14,2),
     ADD COLUMN IF NOT EXISTS qeydiyyat_tarixi date, ADD COLUMN IF NOT EXISTS aktiv boolean DEFAULT true`);
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS demo.kateqoriya (id int PRIMARY KEY, ad text NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS demo.tedarukcu (id int PRIMARY KEY, ad text NOT NULL, voen text, telefon text, sheher text,
       odenis_muddeti_gun int, aktiv boolean DEFAULT true)`,
    `CREATE TABLE IF NOT EXISTS demo.mehsul (id int PRIMARY KEY, kod text NOT NULL UNIQUE, ad text NOT NULL,
       kateqoriya_id int REFERENCES demo.kateqoriya(id), tedarukcu_id int REFERENCES demo.tedarukcu(id), vahid text,
       alis_qiymeti numeric(12,2) NOT NULL, satis_qiymeti numeric(12,2) NOT NULL, aktiv boolean DEFAULT true)`,
    `CREATE TABLE IF NOT EXISTS demo.anbar (id int PRIMARY KEY, kod text NOT NULL UNIQUE, ad text NOT NULL, filial_kod text)`,
    `CREATE TABLE IF NOT EXISTS demo.isci (empid text PRIMARY KEY, ad text NOT NULL, vezife text, filial_kod text,
       ise_baslama date, maas numeric(12,2), telefon text)`,
    `CREATE TABLE IF NOT EXISTS demo.satis_sifaris (id bigint PRIMARY KEY, nomre text NOT NULL, tarix date NOT NULL,
       musteri_id int NOT NULL, filial_kod text NOT NULL, sn_empid text NOT NULL, status text NOT NULL,
       valyuta text DEFAULT 'AZN', endirim_faiz numeric(5,2) DEFAULT 0, cemi numeric(14,2), catdirilma_tarixi date)`,
    `CREATE TABLE IF NOT EXISTS demo.satis_setir (id bigint PRIMARY KEY, sifaris_id bigint NOT NULL, mehsul_id int NOT NULL,
       miqdar numeric(12,3) NOT NULL, qiymet numeric(12,2) NOT NULL, endirim_faiz numeric(5,2) DEFAULT 0, mebleg numeric(14,2) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS demo.qaime (id bigint PRIMARY KEY, nomre text NOT NULL, tarix date NOT NULL, sifaris_id bigint,
       musteri_id int NOT NULL, filial_kod text NOT NULL, cemi numeric(14,2) NOT NULL, edv numeric(14,2) NOT NULL,
       yekun numeric(14,2) NOT NULL, son_odenis_tarixi date)`,
    `CREATE TABLE IF NOT EXISTS demo.odenis (id bigint PRIMARY KEY, tarix date NOT NULL, qaime_id bigint NOT NULL,
       musteri_id int NOT NULL, mebleg numeric(14,2) NOT NULL, usul text NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS demo.qaytarma (id bigint PRIMARY KEY, tarix date NOT NULL, qaime_id bigint NOT NULL,
       mehsul_id int NOT NULL, miqdar numeric(12,3) NOT NULL, mebleg numeric(14,2) NOT NULL, sebeb text)`,
    `CREATE TABLE IF NOT EXISTS demo.satinalma_sifaris (id bigint PRIMARY KEY, nomre text NOT NULL, tarix date NOT NULL,
       tedarukcu_id int NOT NULL, anbar_id int NOT NULL, status text NOT NULL, cemi numeric(14,2), gozlenilen_tarix date)`,
    `CREATE TABLE IF NOT EXISTS demo.satinalma_setir (id bigint PRIMARY KEY, sifaris_id bigint NOT NULL, mehsul_id int NOT NULL,
       miqdar numeric(12,3) NOT NULL, qiymet numeric(12,2) NOT NULL, mebleg numeric(14,2) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS demo.tedarukcu_odenisi (id bigint PRIMARY KEY, tarix date NOT NULL, tedarukcu_id int NOT NULL,
       sifaris_id bigint, mebleg numeric(14,2) NOT NULL, usul text NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS demo.anbar_hereketi (id bigint PRIMARY KEY, tarix date NOT NULL, anbar_id int NOT NULL,
       mehsul_id int NOT NULL, tip text NOT NULL, miqdar numeric(12,3) NOT NULL, sened_tipi text, sened_id bigint)`,
    `CREATE TABLE IF NOT EXISTS demo.anbar_qaliq (anbar_id int NOT NULL, mehsul_id int NOT NULL, miqdar numeric(12,3) NOT NULL,
       min_miqdar numeric(12,3), PRIMARY KEY (anbar_id, mehsul_id))`,
    `CREATE TABLE IF NOT EXISTS demo.satis_plani (ay text NOT NULL, filial_kod text NOT NULL, sn_empid text NOT NULL,
       plan_mebleg numeric(14,2) NOT NULL, PRIMARY KEY (ay, filial_kod, sn_empid))`,
    `CREATE TABLE IF NOT EXISTS demo.xerc (id bigint PRIMARY KEY, tarix date NOT NULL, filial_kod text NOT NULL,
       kateqoriya text NOT NULL, mebleg numeric(14,2) NOT NULL, qeyd text)`,
  ]) await q(client, ddl);

  await q(client, 'SELECT setseed(0.37)');

  // ---------- filial, anbar, işçi ----------
  await q(client, `INSERT INTO demo.filial VALUES ('LK','Lənkəran'),('QB','Quba') ON CONFLICT DO NOTHING`);
  await q(client, `INSERT INTO demo.anbar (id, kod, ad, filial_kod) VALUES
    (1,'BK-1','Bakı əsas anbar','BK'),(2,'BK-2','Bakı ikinci anbar','BK'),(3,'SM-1','Sumqayıt anbarı','SM'),
    (4,'GN-1','Gəncə anbarı','GN'),(5,'MG-1','Mingəçevir anbarı','MG'),(6,'SK-1','Şəki anbarı','SK'),
    (7,'LK-1','Lənkəran anbarı','LK'),(8,'QB-1','Quba anbarı','QB')`);

  const first = ['Elçin', 'Rəşad', 'Aysel', 'Nigar', 'Kamran', 'Leyla', 'Orxan', 'Səbinə', 'Tural', 'Günel', 'Vüsal', 'Fidan', 'Samir', 'Aygün', 'Emin', 'Nərmin'];
  const last = ['Əliyev', 'Məmmədov', 'Hüseynov', 'Quliyev', 'Həsənov', 'İsmayılov', 'Nəbiyev', 'Rzayev', 'Babayev', 'Səfərov'];
  await q(client, `
    INSERT INTO demo.isci (empid, ad, vezife, filial_kod, ise_baslama, maas, telefon)
    SELECT (100200 + g)::text,
      ($1::text[])[1 + (g % 16)] || ' ' || ($2::text[])[1 + ((g / 2) % 10)],
      (ARRAY['Satış nümayəndəsi','Satış nümayəndəsi','Satış nümayəndəsi','Satış nümayəndəsi','Anbardar','Satınalma meneceri','Mühasib','Filial müdiri'])[1 + (g % 8)],
      (ARRAY['BK','SM','GN','MG','SK','LK','QB','BK'])[1 + ((g / 3) % 8)],
      date '2019-01-01' + ((g * 97) % 2300),
      (900 + (g * 131) % 2600)::numeric,
      '+994 ' || (ARRAY['50','51','55','70','77'])[1 + (g % 5)] || ' ' || lpad(((g * 7919) % 1000)::text, 3, '0') || ' ' || lpad(((g * 31) % 100)::text, 2, '0') || ' ' || lpad(((g * 17) % 100)::text, 2, '0')
    FROM generate_series(1, 64) g
    ON CONFLICT DO NOTHING`, [first, last]);
  // əvvəlki nümunə satışlardakı EMPID-lər də işçi olsun
  await q(client, `
    INSERT INTO demo.isci (empid, ad, vezife, filial_kod, ise_baslama, maas)
    SELECT e, 'Satış nümayəndəsi ' || e, 'Satış nümayəndəsi', (ARRAY['BK','SM','GN','MG','SK'])[1 + (row_number() OVER ())::int % 5],
           date '2021-03-01', 1200
    FROM unnest(ARRAY['100211','100236','100317','100359','100482','100501','100517','100533']) e
    ON CONFLICT DO NOTHING`);

  // ---------- kateqoriya, təchizatçı, məhsul ----------
  await q(client, `INSERT INTO demo.kateqoriya (id, ad) SELECT i, c FROM unnest($1::text[]) WITH ORDINALITY AS t(c, i)`, [CATS.map((c) => c[0])]);
  await q(client, `
    INSERT INTO demo.tedarukcu (id, ad, voen, telefon, sheher, odenis_muddeti_gun)
    SELECT i, n || ' MMC', lpad(((i::bigint * 7919301) % 10000000000)::text, 10, '1'),
      '+994 12 ' || lpad(((i * 313) % 1000)::text, 3, '0') || ' ' || lpad(((i * 41) % 100)::text, 2, '0') || ' ' || lpad(((i * 59) % 100)::text, 2, '0'),
      (ARRAY['Bakı','Sumqayıt','Gəncə','Şəki','Lənkəran','Quba'])[1 + (i % 6)],
      (ARRAY[0, 7, 14, 30, 45])[1 + (i % 5)]
    FROM unnest($1::text[]) WITH ORDINALITY AS t(n, i)`, [SUPPLIERS]);
  const names = [];
  CATS.forEach((c, ci) => c[1].forEach((n) => VARIANTS.forEach((v) => names.push([ci + 1, `${n} ${v}`]))));
  await q(client, `
    WITH src AS (SELECT row_number() OVER () AS id, kid, nm FROM unnest($1::int[], $2::text[]) AS t(kid, nm))
    INSERT INTO demo.mehsul (id, kod, ad, kateqoriya_id, tedarukcu_id, vahid, alis_qiymeti, satis_qiymeti)
    SELECT id, 'P' || lpad(id::text, 5, '0'), nm, kid, 1 + ((id * 7) % ${SUPPLIERS.length}),
      (ARRAY['ədəd','kq','litr','qutu'])[1 + (id % 4)],
      ap, round((ap * (1.12 + random() * 0.28))::numeric, 2)
    FROM (SELECT *, round((0.4 + random() * 38)::numeric, 2) AS ap FROM src) s`,
  [names.map((x) => x[0]), names.map((x) => x[1])]);

  // ---------- müştərilər (2500) ----------
  await q(client, `
    INSERT INTO demo.musteri (id, ad, telefon, filial_kod)
    SELECT g,
      (ARRAY['Aznar','Bravo','Neftçilər','Sahil','Yeni Həyat','Qala','Orxan','Kəpəz','Şirvan','Mərkəz','Günəş','Xəzər','Araz','Dəniz','Qızılgül','Nur'])[1 + (g % 16)]
        || ' ' || (ARRAY['MMC','Market','Ticarət','Qida','Bazar','Univermaq','Restoran','Kafe'])[1 + ((g / 16) % 8)] || ' ' || g,
      '+994 ' || (ARRAY['50','51','55','70','77'])[1 + (g % 5)] || ' ' || lpad(((g * 7919) % 1000)::text, 3, '0')
        || ' ' || lpad(((g * 31) % 100)::text, 2, '0') || ' ' || lpad(((g * 17) % 100)::text, 2, '0'),
      (ARRAY['BK','SM','GN','MG','SK','LK','QB','BK','BK'])[1 + (g % 9)]
    FROM generate_series(61, 2500) g ON CONFLICT DO NOTHING`);
  await q(client, `
    UPDATE demo.musteri m SET
      voen = lpad(((m.id::bigint * 9100313) % 10000000000)::text, 10, '2'),
      sheher = (SELECT ad FROM demo.filial f WHERE f.kod = m.filial_kod),
      qrup = (ARRAY['Pərakəndə','Topdan','Horeca','Zəncir market'])[1 + (m.id % 4)],
      kredit_limit = ((m.id % 9) * 2500)::numeric,
      qeydiyyat_tarixi = date '2021-01-01' + ((m.id * 37) % 1700),
      aktiv = (m.id % 23 <> 0)`);

  // ---------- satış sifarişləri (60 000) ----------
  await q(client, `
    WITH reps AS (
      SELECT filial_kod, array_agg(empid ORDER BY empid) AS a FROM demo.isci WHERE vezife = 'Satış nümayəndəsi' GROUP BY filial_kod)
    INSERT INTO demo.satis_sifaris (id, nomre, tarix, musteri_id, filial_kod, sn_empid, status, endirim_faiz, catdirilma_tarixi)
    SELECT n, 'SS-' || to_char(d, 'YYMM') || '-' || lpad(n::text, 6, '0'), d, mid, m.filial_kod,
      COALESCE(rp.a[1 + (n % cardinality(rp.a))], '100211'),
      CASE WHEN r < 0.04 THEN 'Ləğv edilib' WHEN r < 0.10 THEN 'Təsdiqlənib' WHEN r < 0.18 THEN 'Göndərilib' ELSE 'Çatdırılıb' END,
      (ARRAY[0, 0, 0, 2, 5, 10])[1 + (n % 6)],
      d + (n % 4)
    FROM (SELECT n, date '2025-09-01' + (random() * 413)::int AS d, 1 + (random() * 2499)::int AS mid, random() AS r
          FROM generate_series(1, 60000) n) g
    JOIN demo.musteri m ON m.id = g.mid
    LEFT JOIN reps rp ON rp.filial_kod = m.filial_kod`);

  await q(client, `
    INSERT INTO demo.satis_setir (id, sifaris_id, mehsul_id, miqdar, qiymet, endirim_faiz, mebleg)
    SELECT row_number() OVER (), s.id, p.id, s.qty, p.satis_qiymeti, s.endirim_faiz,
           round((s.qty * p.satis_qiymeti * (1 - s.endirim_faiz / 100))::numeric, 2)
    FROM (SELECT o.id, o.endirim_faiz, gs, 1 + (random() * (SELECT max(id) - 1 FROM demo.mehsul))::int AS pid,
                 round((1 + random() * 49)::numeric, 0) AS qty
          FROM demo.satis_sifaris o CROSS JOIN LATERAL generate_series(1, 1 + (abs(hashint4(o.id::int)) % 7)) gs) s
    JOIN demo.mehsul p ON p.id = s.pid`);
  await q(client, `UPDATE demo.satis_sifaris o SET cemi = COALESCE(t.s, 0) FROM (SELECT sifaris_id, sum(mebleg) AS s FROM demo.satis_setir GROUP BY sifaris_id) t WHERE t.sifaris_id = o.id`);
  await q(client, `UPDATE demo.satis_sifaris SET cemi = 0 WHERE cemi IS NULL`);

  // ---------- qaimə, ödəniş, qaytarma ----------
  await q(client, `
    INSERT INTO demo.qaime (id, nomre, tarix, sifaris_id, musteri_id, filial_kod, cemi, edv, yekun, son_odenis_tarixi)
    SELECT id, 'QM-' || to_char(catdirilma_tarixi, 'YYMM') || '-' || lpad(id::text, 6, '0'), catdirilma_tarixi, id, musteri_id, filial_kod,
      cemi, round(cemi * 0.18, 2), round(cemi * 1.18, 2), catdirilma_tarixi + (ARRAY[7, 14, 30, 45])[1 + (id % 4)]
    FROM demo.satis_sifaris WHERE status <> 'Ləğv edilib' AND status <> 'Təsdiqlənib'`);
  await q(client, `
    INSERT INTO demo.odenis (id, tarix, qaime_id, musteri_id, mebleg, usul)
    SELECT row_number() OVER (), tarix, id, musteri_id, amt, (ARRAY['Nağd','Köçürmə','Kart','Köçürmə'])[1 + (id % 4)]
    FROM (
      SELECT q.id, q.musteri_id, q.tarix + (random() * 40)::int AS tarix,
        CASE WHEN part = 1 THEN (CASE WHEN k.r < 0.70 THEN q.yekun WHEN k.r < 0.85 THEN round((q.yekun * 0.5)::numeric, 2) ELSE NULL END)
             ELSE (CASE WHEN k.r BETWEEN 0.70 AND 0.78 THEN round((q.yekun * 0.25)::numeric, 2) ELSE NULL END) END AS amt
      FROM demo.qaime q CROSS JOIN generate_series(1, 2) part
      CROSS JOIN LATERAL (SELECT (abs(hashint4(q.id::int)) % 1000) / 1000.0 AS r) k
    ) x WHERE amt IS NOT NULL AND tarix <= date '2026-10-19'`);
  await q(client, `
    INSERT INTO demo.qaytarma (id, tarix, qaime_id, mehsul_id, miqdar, mebleg, sebeb)
    SELECT row_number() OVER (), q.tarix + 1 + (l.id % 10)::int, q.id, l.mehsul_id, round((l.miqdar * 0.3)::numeric, 0) + 1,
           round((l.mebleg * 0.3)::numeric, 2),
           (ARRAY['Zədəli mal','Vaxtı keçib','Səhv sifariş','Keyfiyyət','Müştəri imtinası'])[1 + (l.id % 5)]
    FROM demo.qaime q JOIN demo.satis_setir l ON l.sifaris_id = q.id
    WHERE abs(hashint4(l.id::int)) % 40 = 0`);

  // ---------- satınalma ----------
  await q(client, `
    INSERT INTO demo.satinalma_sifaris (id, nomre, tarix, tedarukcu_id, anbar_id, status, gozlenilen_tarix)
    SELECT n, 'SA-' || to_char(d, 'YYMM') || '-' || lpad(n::text, 5, '0'), d,
      1 + (n * 7 % ${SUPPLIERS.length}), 1 + (n % 8),
      CASE WHEN r < 0.03 THEN 'Ləğv edilib' WHEN r < 0.08 THEN 'Gözləyir' WHEN r < 0.14 THEN 'Yolda' ELSE 'Qəbul edilib' END,
      d + 3 + (n % 12)
    FROM (SELECT n, date '2025-08-15' + (random() * 420)::int AS d, random() AS r FROM generate_series(1, 7000) n) g`);
  await q(client, `
    INSERT INTO demo.satinalma_setir (id, sifaris_id, mehsul_id, miqdar, qiymet, mebleg)
    SELECT row_number() OVER (), s.id, p.id, s.qty, round((p.alis_qiymeti * (0.97 + random() * 0.06))::numeric, 2),
           round((s.qty * p.alis_qiymeti)::numeric, 2)
    FROM (SELECT o.id, 1 + (random() * (SELECT max(id) - 1 FROM demo.mehsul))::int AS pid, round((20 + random() * 480)::numeric, 0) AS qty
          FROM demo.satinalma_sifaris o CROSS JOIN LATERAL generate_series(1, 3 + (abs(hashint4(o.id::int)) % 8)) gs) s
    JOIN demo.mehsul p ON p.id = s.pid`);
  await q(client, `UPDATE demo.satinalma_sifaris o SET cemi = COALESCE(t.s, 0) FROM (SELECT sifaris_id, sum(mebleg) AS s FROM demo.satinalma_setir GROUP BY sifaris_id) t WHERE t.sifaris_id = o.id`);
  await q(client, `UPDATE demo.satinalma_sifaris SET cemi = 0 WHERE cemi IS NULL`);
  await q(client, `
    INSERT INTO demo.tedarukcu_odenisi (id, tarix, tedarukcu_id, sifaris_id, mebleg, usul)
    SELECT row_number() OVER (), o.tarix + t.odenis_muddeti_gun + (o.id % 6)::int, o.tedarukcu_id, o.id, o.cemi,
           (ARRAY['Köçürmə','Köçürmə','Akkreditiv'])[1 + (o.id % 3)]
    FROM demo.satinalma_sifaris o JOIN demo.tedarukcu t ON t.id = o.tedarukcu_id
    WHERE o.status = 'Qəbul edilib' AND o.id % 10 < 8 AND o.tarix + t.odenis_muddeti_gun <= date '2026-10-19'`);

  // ---------- anbar hərəkəti və qalıq ----------
  await q(client, `
    INSERT INTO demo.anbar_hereketi (id, tarix, anbar_id, mehsul_id, tip, miqdar, sened_tipi, sened_id)
    SELECT row_number() OVER (), tarix, anbar_id, mehsul_id, tip, miqdar, sened_tipi, sened_id FROM (
      SELECT o.gozlenilen_tarix AS tarix, o.anbar_id, l.mehsul_id, 'Giriş' AS tip, l.miqdar, 'Satınalma' AS sened_tipi, o.id AS sened_id
      FROM demo.satinalma_sifaris o JOIN demo.satinalma_setir l ON l.sifaris_id = o.id WHERE o.status = 'Qəbul edilib'
      UNION ALL
      SELECT o.catdirilma_tarixi, a.id, l.mehsul_id, 'Çıxış', l.miqdar, 'Satış', o.id
      FROM demo.satis_sifaris o JOIN demo.satis_setir l ON l.sifaris_id = o.id
      JOIN demo.anbar a ON a.filial_kod = o.filial_kod AND a.id = (SELECT min(id) FROM demo.anbar b WHERE b.filial_kod = o.filial_kod)
      WHERE o.status IN ('Göndərilib', 'Çatdırılıb')
      UNION ALL
      SELECT q.tarix, a.id, r.mehsul_id, 'Qaytarma girişi', r.miqdar, 'Qaytarma', r.id
      FROM demo.qaytarma r JOIN demo.qaime q ON q.id = r.qaime_id
      JOIN demo.anbar a ON a.id = (SELECT min(id) FROM demo.anbar b WHERE b.filial_kod = q.filial_kod)
    ) u`);
  await q(client, 'CREATE INDEX IF NOT EXISTS ix_hereket_am ON demo.anbar_hereketi(anbar_id, mehsul_id)');
  await q(client, 'ANALYZE demo.anbar_hereketi');
  await q(client, `
    INSERT INTO demo.anbar_qaliq (anbar_id, mehsul_id, miqdar, min_miqdar)
    SELECT a.id, p.id,
      greatest(round((500 + (abs(hashint4(a.id * 1000 + p.id)) % 3000))::numeric, 0) +
        COALESCE((SELECT sum(CASE WHEN h.tip = 'Çıxış' THEN -h.miqdar ELSE h.miqdar END) FROM demo.anbar_hereketi h WHERE h.anbar_id = a.id AND h.mehsul_id = p.id), 0), 0),
      (50 + (p.id % 10) * 25)::numeric
    FROM demo.anbar a CROSS JOIN demo.mehsul p`);

  // ---------- plan və xərc ----------
  await q(client, `
    INSERT INTO demo.satis_plani (ay, filial_kod, sn_empid, plan_mebleg)
    SELECT to_char(m, 'YYYY-MM'), i.filial_kod, i.empid, round((40000 + (abs(hashint4(i.empid::int + extract(month FROM m)::int)) % 60000))::numeric, -2)
    FROM generate_series(date '2025-09-01', date '2026-10-01', interval '1 month') m
    JOIN demo.isci i ON i.vezife = 'Satış nümayəndəsi'`);
  await q(client, `
    INSERT INTO demo.xerc (id, tarix, filial_kod, kateqoriya, mebleg, qeyd)
    SELECT row_number() OVER (), (m + (c.i * 3) * interval '1 day')::date, f.kod, c.k,
           round((300 + (abs(hashint4(ascii(f.kod) * 100 + c.i + extract(month FROM m)::int)) % 9000))::numeric, 2), 'Aylıq xərc'
    FROM generate_series(date '2025-09-01', date '2026-10-01', interval '1 month') m
    CROSS JOIN demo.filial f
    CROSS JOIN (SELECT i, (ARRAY['İcarə','Maaş','Yanacaq','Daşınma','Kommunal','Marketinq','Təmir','İnternet'])[i] AS k FROM generate_series(1, 8) i) c`);

  // ---------- indekslər ----------
  for (const ix of [
    'satis_sifaris(tarix)', 'satis_sifaris(musteri_id)', 'satis_sifaris(filial_kod, tarix)', 'satis_setir(sifaris_id)', 'satis_setir(mehsul_id)',
    'qaime(tarix)', 'qaime(musteri_id)', 'odenis(qaime_id)', 'odenis(tarix)', 'qaytarma(qaime_id)',
    'satinalma_sifaris(tarix)', 'satinalma_sifaris(tedarukcu_id)', 'satinalma_setir(sifaris_id)', 'tedarukcu_odenisi(tedarukcu_id)',
    'anbar_hereketi(tarix)', 'anbar_hereketi(anbar_id, mehsul_id)', 'musteri(filial_kod)', 'satis(tarix)',
  ]) await q(client, `CREATE INDEX IF NOT EXISTS ${('ix_' + ix).replace(/[^a-z_0-9]/gi, '_')} ON demo.${ix}`);
  await q(client, 'ANALYZE');
  await q(client, `DO $g$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'report_ro') THEN
      EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA demo TO report_ro';
    END IF; END $g$`);
  console.log(`Satış test datası hazırdır (${((Date.now() - t0) / 1000).toFixed(1)} san).`);
  return true;
}
