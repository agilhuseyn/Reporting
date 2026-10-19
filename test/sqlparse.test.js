import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColumns, paramColumns, analyze, slug } from '../server/sqlparse.js';

test('parseColumns: AS, T-SQL alias, boş ad, funksiya, CASE', () => {
  const c = parseColumns(`SELECT f.filial_kod AS Filial, m.ad musteri, SUM(s.mebleg) AS "Cəm məbləğ",
    [Tarix] = s.tarix, CASE WHEN a > 1 THEN 'x' ELSE 'y' END AS Qrup, s.id FROM satis s`);
  assert.deepEqual(c.map((x) => [x.source, x.alias, x.simple]), [
    ['filial_kod', 'Filial', true], ['ad', 'musteri', true], [null, 'Cəm məbləğ', false],
    ['tarix', 'Tarix', true], [null, 'Qrup', false], ['id', null, true],
  ]);
});

test('parseColumns: DISTINCT, TOP, WITH, alt sorğu və vergül mötərizədə', () => {
  assert.equal(parseColumns('SELECT DISTINCT TOP 5 a, b FROM t').length, 2);
  assert.equal(parseColumns('SELECT coalesce(a, b) AS x, (SELECT max(z) FROM q) AS y FROM t').length, 2);
  const w = parseColumns('WITH x AS (SELECT 1 AS zzz) SELECT x.zzz AS Ad FROM x');
  assert.equal(w[0].alias, 'Ad');
  assert.equal(parseColumns('SELECT * FROM t')[0].star, true);
});

test('slug: azərbaycan hərfləri', () => {
  assert.equal(slug('Cəm məbləğ'), 'cem_mebleg');
  assert.equal(slug('Şöbə (SN)'), 'sobe_sn');
  assert.equal(slug('2026 satış'), 'c_2026_satis');
});

test('analyze: filial_kod AS Filial → kod filial_kod, ad Filial', () => {
  const r = analyze('SELECT filial_kod AS Filial, SUM(m) AS Cem FROM t GROUP BY filial_kod', [
    { code: 'filial', type: 'text' }, { code: 'cem', type: 'number' }]);
  assert.deepEqual(r.columns.map((c) => [c.code, c.src, c.label, c.type]), [
    ['filial_kod', 'filial', 'Filial', 'text'], ['cem', 'cem', 'Cem', 'number']]);
});

test('analyze: nəticə yoxdursa SQL-dən oxuyur, təkrar kodlara şumar əlavə edir', () => {
  const r = analyze('SELECT a.ad AS Ad1, b.ad AS Ad2 FROM a, b');
  assert.deepEqual(r.columns.map((c) => c.code), ['ad', 'ad_2']);
});

test('paramColumns: müqayisə, IN, BETWEEN', () => {
  const p = paramColumns('SELECT 1 FROM s WHERE s.filial_kod = @filial AND tarix BETWEEN @bas AND @son AND x IN (@x)');
  assert.deepEqual(p, { filial: 'filial_kod', bas: 'tarix', son: 'tarix', x: 'x' });
});

test('analyze: parametr sütunun adını və tipini alır', () => {
  const r = analyze('SELECT f.filial_kod AS Filial, s.tarix AS Tarix FROM s WHERE f.filial_kod = @filial AND s.tarix >= @bas',
    [{ code: 'filial', type: 'text' }, { code: 'tarix', type: 'date' }]);
  assert.equal(r.params.filial.label, 'Filial');
  assert.equal(r.params.bas.label, 'Tarix');
  assert.equal(r.params.bas.type, 'date');
});
