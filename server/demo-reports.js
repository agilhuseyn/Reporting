// Yeni test cədvəlləri (demo sxemi) üçün nümunə hesabatlar. Təkrar işə düşəndə mövcud kodları atlayır.
// Yetki yalnız "Dəstək komandası" vəzifəsinə verilir (admin və dəstək hesabları). Başqalarına yetki admin ekranından verilir.

const DATES = [
  { name: 'tarix_bas', type: 'date', required: true, default: '$monthStart', label: 'Başlanğıc tarix' },
  { name: 'tarix_son', type: 'date', required: true, default: '$today', label: 'Son tarix' },
];
const FILIAL = {
  name: 'filial', type: 'list', required: false, label: 'Filial',
  optionsSql: 'SELECT kod AS value, ad AS label FROM demo.filial ORDER BY ad',
};
const ANBAR = {
  name: 'anbar', type: 'list', required: false, label: 'Anbar',
  optionsSql: 'SELECT kod AS value, ad AS label FROM demo.anbar ORDER BY ad',
};

// sütun: [kod, az, en, ru, tip, həssaslıq]
const R = [
  {
    code: 'SALES_ORDERS', cat: 'Satış', az: 'Satış sifarişləri', en: 'Sales orders', ru: 'Заказы клиентов',
    desc: 'Sifarişlər tarix, filial, müştəri və status üzrə.',
    params: [...DATES, FILIAL],
    sql: `SELECT
    s.tarix                  AS order_date,
    s.nomre                  AS order_no,
    f.ad                     AS filial_name,
    i.ad                     AS sales_rep,
    m.ad                     AS customer_name,
    s.status                 AS status,
    s.endirim_faiz           AS discount_pct,
    s.cemi                   AS amount
FROM demo.satis_sifaris s
JOIN demo.filial f  ON f.kod = s.filial_kod
JOIN demo.musteri m ON m.id = s.musteri_id
JOIN demo.isci i    ON i.empid = s.sn_empid
WHERE s.tarix BETWEEN @tarix_bas AND @tarix_son
  AND (@filial IS NULL OR s.filial_kod = @filial)`,
    cols: [
      ['order_date', 'Tarix', 'Date', 'Дата', 'date', 'normal'],
      ['order_no', 'Sifariş №', 'Order no', 'Заказ №', 'text', 'normal'],
      ['filial_name', 'Filial', 'Branch', 'Филиал', 'text', 'normal'],
      ['sales_rep', 'Satış nümayəndəsi', 'Sales rep', 'Торговый представитель', 'text', 'normal'],
      ['customer_name', 'Müştəri', 'Customer', 'Клиент', 'text', 'normal'],
      ['status', 'Status', 'Status', 'Статус', 'text', 'normal'],
      ['discount_pct', 'Endirim %', 'Discount %', 'Скидка %', 'number', 'normal'],
      ['amount', 'Məbləğ', 'Amount', 'Сумма', 'number', 'normal'],
    ],
  },
  {
    code: 'TOP_PRODUCTS', cat: 'Satış', az: 'Məhsul üzrə satış', en: 'Sales by product', ru: 'Продажи по товарам',
    desc: 'Satılan miqdar, məbləğ və qazanc məhsul üzrə (ləğv olunmuş sifarişlər çıxılır).',
    params: [...DATES, FILIAL],
    sql: `SELECT
    p.kod                    AS product_code,
    p.ad                     AS product_name,
    k.ad                     AS category_name,
    SUM(l.miqdar)            AS qty,
    SUM(l.mebleg)            AS amount,
    SUM(l.miqdar * p.alis_qiymeti) AS cost_price,
    SUM(l.mebleg - l.miqdar * p.alis_qiymeti) AS profit
FROM demo.satis_setir l
JOIN demo.satis_sifaris s ON s.id = l.sifaris_id
JOIN demo.mehsul p        ON p.id = l.mehsul_id
JOIN demo.kateqoriya k    ON k.id = p.kateqoriya_id
WHERE s.tarix BETWEEN @tarix_bas AND @tarix_son
  AND s.status <> 'Ləğv edilib'
  AND (@filial IS NULL OR s.filial_kod = @filial)
GROUP BY p.kod, p.ad, k.ad`,
    cols: [
      ['product_code', 'Məhsul kodu', 'Product code', 'Код товара', 'text', 'normal'],
      ['product_name', 'Məhsul', 'Product', 'Товар', 'text', 'normal'],
      ['category_name', 'Kateqoriya', 'Category', 'Категория', 'text', 'normal'],
      ['qty', 'Miqdar', 'Quantity', 'Количество', 'number', 'normal'],
      ['amount', 'Məbləğ', 'Amount', 'Сумма', 'number', 'normal'],
      ['cost_price', 'Maya dəyəri', 'Cost price', 'Себестоимость', 'number', 'sensitive'],
      ['profit', 'Qazanc', 'Profit', 'Прибыль', 'number', 'sensitive'],
    ],
  },
  {
    code: 'PLAN_VS_ACTUAL', cat: 'Satış', az: 'Plan icrası', en: 'Plan vs actual', ru: 'Выполнение плана',
    desc: 'Aylıq plan və faktiki satış satış nümayəndəsi üzrə.',
    params: [...DATES, FILIAL],
    sql: `SELECT
    pl.ay                    AS month,
    f.ad                     AS filial_name,
    i.ad                     AS sales_rep,
    pl.plan_mebleg           AS plan_amount,
    COALESCE(a.fakt, 0)      AS actual_amount,
    ROUND(COALESCE(a.fakt, 0) * 100.0 / NULLIF(pl.plan_mebleg, 0), 1) AS fulfil_pct
FROM demo.satis_plani pl
JOIN demo.filial f ON f.kod = pl.filial_kod
JOIN demo.isci i   ON i.empid = pl.sn_empid
LEFT JOIN (
    SELECT to_char(tarix, 'YYYY-MM') AS ay, filial_kod, sn_empid, SUM(cemi) AS fakt
    FROM demo.satis_sifaris
    WHERE status <> 'Ləğv edilib'
    GROUP BY to_char(tarix, 'YYYY-MM'), filial_kod, sn_empid
) a ON a.ay = pl.ay AND a.filial_kod = pl.filial_kod AND a.sn_empid = pl.sn_empid
WHERE pl.ay BETWEEN to_char(@tarix_bas::date, 'YYYY-MM') AND to_char(@tarix_son::date, 'YYYY-MM')
  AND (@filial IS NULL OR pl.filial_kod = @filial)`,
    cols: [
      ['month', 'Ay', 'Month', 'Месяц', 'text', 'normal'],
      ['filial_name', 'Filial', 'Branch', 'Филиал', 'text', 'normal'],
      ['sales_rep', 'Satış nümayəndəsi', 'Sales rep', 'Торговый представитель', 'text', 'normal'],
      ['plan_amount', 'Plan', 'Plan', 'План', 'number', 'normal'],
      ['actual_amount', 'Fakt', 'Actual', 'Факт', 'number', 'normal'],
      ['fulfil_pct', 'İcra %', 'Fulfilment %', 'Выполнение %', 'number', 'normal'],
    ],
  },
  {
    code: 'RECEIVABLES', cat: 'Maliyyə', az: 'Debitor borcu', en: 'Receivables', ru: 'Дебиторская задолженность',
    desc: 'Ödənilməmiş qaimələr və gecikmə günləri seçilmiş tarixə görə.',
    params: [{ name: 'hesabat_tarixi', type: 'date', required: true, default: '$today', label: 'Hesabat tarixi' }, FILIAL],
    sql: `SELECT
    m.id                     AS customer_id,
    m.ad                     AS customer_name,
    m.telefon                AS phone,
    f.ad                     AS filial_name,
    q.nomre                  AS invoice_no,
    q.tarix                  AS invoice_date,
    q.son_odenis_tarixi      AS due_date,
    q.yekun                  AS invoice_amount,
    COALESCE(o.paid, 0)      AS paid_amount,
    q.yekun - COALESCE(o.paid, 0) AS debt,
    GREATEST(@hesabat_tarixi::date - q.son_odenis_tarixi, 0) AS overdue_days
FROM demo.qaime q
JOIN demo.musteri m ON m.id = q.musteri_id
JOIN demo.filial f  ON f.kod = q.filial_kod
LEFT JOIN (
    SELECT qaime_id, SUM(mebleg) AS paid FROM demo.odenis
    WHERE tarix <= @hesabat_tarixi::date GROUP BY qaime_id
) o ON o.qaime_id = q.id
WHERE q.tarix <= @hesabat_tarixi::date
  AND q.yekun - COALESCE(o.paid, 0) > 0.005
  AND (@filial IS NULL OR q.filial_kod = @filial)`,
    cols: [
      ['customer_id', 'Müştəri kodu', 'Customer ID', 'Код клиента', 'text', 'normal'],
      ['customer_name', 'Müştəri', 'Customer', 'Клиент', 'text', 'normal'],
      ['phone', 'Telefon', 'Phone', 'Телефон', 'text', 'sensitive'],
      ['filial_name', 'Filial', 'Branch', 'Филиал', 'text', 'normal'],
      ['invoice_no', 'Qaimə №', 'Invoice no', 'Накладная №', 'text', 'normal'],
      ['invoice_date', 'Qaimə tarixi', 'Invoice date', 'Дата накладной', 'date', 'normal'],
      ['due_date', 'Son ödəniş tarixi', 'Due date', 'Срок оплаты', 'date', 'normal'],
      ['invoice_amount', 'Qaimə məbləği', 'Invoice amount', 'Сумма накладной', 'number', 'normal'],
      ['paid_amount', 'Ödənilib', 'Paid', 'Оплачено', 'number', 'normal'],
      ['debt', 'Borc', 'Debt', 'Долг', 'number', 'normal'],
      ['overdue_days', 'Gecikmə (gün)', 'Overdue (days)', 'Просрочка (дни)', 'number', 'normal'],
    ],
  },
  {
    code: 'RETURNS', cat: 'Satış', az: 'Qaytarmalar', en: 'Returns', ru: 'Возвраты',
    desc: 'Müştəri qaytarmaları məhsul və səbəb üzrə.',
    params: DATES,
    sql: `SELECT
    r.tarix                  AS return_date,
    q.nomre                  AS invoice_no,
    m.ad                     AS customer_name,
    p.ad                     AS product_name,
    r.sebeb                  AS reason,
    r.miqdar                 AS qty,
    r.mebleg                 AS amount
FROM demo.qaytarma r
JOIN demo.qaime q   ON q.id = r.qaime_id
JOIN demo.musteri m ON m.id = q.musteri_id
JOIN demo.mehsul p  ON p.id = r.mehsul_id
WHERE r.tarix BETWEEN @tarix_bas AND @tarix_son`,
    cols: [
      ['return_date', 'Tarix', 'Date', 'Дата', 'date', 'normal'],
      ['invoice_no', 'Qaimə №', 'Invoice no', 'Накладная №', 'text', 'normal'],
      ['customer_name', 'Müştəri', 'Customer', 'Клиент', 'text', 'normal'],
      ['product_name', 'Məhsul', 'Product', 'Товар', 'text', 'normal'],
      ['reason', 'Səbəb', 'Reason', 'Причина', 'text', 'normal'],
      ['qty', 'Miqdar', 'Quantity', 'Количество', 'number', 'normal'],
      ['amount', 'Məbləğ', 'Amount', 'Сумма', 'number', 'normal'],
    ],
  },
  {
    code: 'EXPENSES', cat: 'Maliyyə', az: 'Xərclər', en: 'Expenses', ru: 'Расходы',
    desc: 'Filial xərcləri ay və kateqoriya üzrə.',
    params: [...DATES, FILIAL],
    sql: `SELECT
    to_char(x.tarix, 'YYYY-MM') AS month,
    f.ad                     AS filial_name,
    x.kateqoriya             AS expense_category,
    SUM(x.mebleg)            AS amount
FROM demo.xerc x
JOIN demo.filial f ON f.kod = x.filial_kod
WHERE x.tarix BETWEEN @tarix_bas AND @tarix_son
  AND (@filial IS NULL OR x.filial_kod = @filial)
GROUP BY to_char(x.tarix, 'YYYY-MM'), f.ad, x.kateqoriya`,
    cols: [
      ['month', 'Ay', 'Month', 'Месяц', 'text', 'normal'],
      ['filial_name', 'Filial', 'Branch', 'Филиал', 'text', 'normal'],
      ['expense_category', 'Xərc növü', 'Expense type', 'Вид расхода', 'text', 'normal'],
      ['amount', 'Məbləğ', 'Amount', 'Сумма', 'number', 'normal'],
    ],
  },
  {
    code: 'PURCHASE_BY_SUPPLIER', cat: 'Satınalma', az: 'Təchizatçı üzrə satınalma', en: 'Purchases by supplier',
    ru: 'Закупки по поставщикам',
    desc: 'Satınalma sifarişləri, ödəniş və qalıq borc təchizatçı üzrə (ləğv olunmuşlar çıxılır).',
    params: DATES,
    sql: `SELECT
    t.id                     AS supplier_id,
    t.ad                     AS supplier_name,
    t.odenis_muddeti_gun     AS payment_term_days,
    x.order_count            AS order_count,
    x.total                  AS ordered_amount,
    x.paid                   AS paid_amount,
    x.total - x.paid         AS debt
FROM (
    SELECT s.tedarukcu_id, COUNT(*) AS order_count, SUM(s.cemi) AS total, SUM(COALESCE(p.paid, 0)) AS paid
    FROM demo.satinalma_sifaris s
    LEFT JOIN (SELECT sifaris_id, SUM(mebleg) AS paid FROM demo.tedarukcu_odenisi GROUP BY sifaris_id) p ON p.sifaris_id = s.id
    WHERE s.tarix BETWEEN @tarix_bas AND @tarix_son AND s.status <> 'Ləğv edilib'
    GROUP BY s.tedarukcu_id
) x
JOIN demo.tedarukcu t ON t.id = x.tedarukcu_id`,
    cols: [
      ['supplier_id', 'Təchizatçı kodu', 'Supplier ID', 'Код поставщика', 'text', 'normal'],
      ['supplier_name', 'Təchizatçı', 'Supplier', 'Поставщик', 'text', 'normal'],
      ['payment_term_days', 'Ödəniş müddəti (gün)', 'Payment term (days)', 'Срок оплаты (дни)', 'number', 'normal'],
      ['order_count', 'Sifariş sayı', 'Order count', 'Кол-во заказов', 'number', 'normal'],
      ['ordered_amount', 'Sifariş məbləği', 'Ordered amount', 'Сумма заказов', 'number', 'normal'],
      ['paid_amount', 'Ödənilib', 'Paid', 'Оплачено', 'number', 'normal'],
      ['debt', 'Qalıq borc', 'Debt', 'Остаток долга', 'number', 'normal'],
    ],
  },
  {
    code: 'LOW_STOCK', cat: 'Anbar', az: 'Minimumdan az qalıq', en: 'Low stock', ru: 'Остатки ниже минимума',
    desc: 'Qalığı minimum həddən az olan mallar.',
    params: [ANBAR],
    sql: `SELECT
    a.kod                    AS warehouse_code,
    a.ad                     AS warehouse_name,
    p.kod                    AS product_code,
    p.ad                     AS product_name,
    k.ad                     AS category_name,
    q.miqdar                 AS qty,
    q.min_miqdar             AS min_qty,
    q.min_miqdar - q.miqdar  AS shortage
FROM demo.anbar_qaliq q
JOIN demo.anbar a      ON a.id = q.anbar_id
JOIN demo.mehsul p     ON p.id = q.mehsul_id
JOIN demo.kateqoriya k ON k.id = p.kateqoriya_id
WHERE q.miqdar < q.min_miqdar
  AND (@anbar IS NULL OR a.kod = @anbar)`,
    cols: [
      ['warehouse_code', 'Anbar kodu', 'Warehouse code', 'Код склада', 'text', 'normal'],
      ['warehouse_name', 'Anbar', 'Warehouse', 'Склад', 'text', 'normal'],
      ['product_code', 'Məhsul kodu', 'Product code', 'Код товара', 'text', 'normal'],
      ['product_name', 'Məhsul', 'Product', 'Товар', 'text', 'normal'],
      ['category_name', 'Kateqoriya', 'Category', 'Категория', 'text', 'normal'],
      ['qty', 'Qalıq', 'Quantity', 'Остаток', 'number', 'normal'],
      ['min_qty', 'Minimum', 'Minimum', 'Минимум', 'number', 'normal'],
      ['shortage', 'Çatışmayan', 'Shortage', 'Не хватает', 'number', 'normal'],
    ],
  },
];

export async function seedDemoReports(client) {
  await client.query('SELECT pg_advisory_xact_lock(7772)');
  const catId = {};
  const pos = await client.query(`SELECT id FROM portal.positions WHERE name = 'Dəstək komandası'`);
  for (const r of R) {
    const exists = await client.query('SELECT 1 FROM portal.reports WHERE code = $1', [r.code]);
    if (exists.rowCount) continue;
    if (!catId[r.cat]) {
      const c = await client.query('SELECT id FROM portal.report_categories WHERE name_az = $1 ORDER BY id LIMIT 1', [r.cat]);
      catId[r.cat] = c.rowCount
        ? c.rows[0].id
        : (await client.query('INSERT INTO portal.report_categories (name_az) VALUES ($1) RETURNING id', [r.cat])).rows[0].id;
    }
    const ins = await client.query(
      `INSERT INTO portal.reports (code,category_id,kind,name_az,name_en,name_ru,description,sql,params,updated_by)
       VALUES ($1,$2,'query',$3,$4,$5,$6,$7,$8,'100001') RETURNING id`,
      [r.code, catId[r.cat], r.az, r.en, r.ru, r.desc, r.sql, JSON.stringify(r.params)]);
    const id = ins.rows[0].id;
    await client.query('INSERT INTO portal.report_versions (report_id,version,sql,changed_by) VALUES ($1,1,$2,$3)', [id, r.sql, '100001']);
    let i = 0;
    for (const [c, a, e, ru, t, s] of r.cols) {
      await client.query(
        `INSERT INTO portal.report_columns (report_id,code,label_az,label_en,label_ru,type,sensitivity,pos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, c, a, e, ru, t, s, i++]);
    }
    if (pos.rowCount) {
      const sid = String(pos.rows[0].id);
      await client.query(`INSERT INTO portal.perm_report VALUES ('position',$1,$2,true)`, [sid, id]);
      for (const [c] of r.cols) {
        await client.query(`INSERT INTO portal.perm_column VALUES ('position',$1,$2,$3,'show')`, [sid, id, c]);
      }
    }
  }
}
