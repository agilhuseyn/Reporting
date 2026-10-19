import test from 'node:test';
import assert from 'node:assert/strict';
import { guardMssql, canWrap, buildWrapped, applyJs, colType, normVal } from '../server/mssql-dialect.js';
import { encrypt, decrypt } from '../server/secret.js';

test('guardMssql: SELECT keçir, yazma və təhlükəli sözlər bloklanır', () => {
  assert.equal(guardMssql('SELECT a FROM t WHERE d >= @d;', 'query'), 'SELECT a FROM t WHERE d >= @d');
  assert.equal(guardMssql('WITH x AS (SELECT 1 a) SELECT * FROM x', 'query').startsWith('WITH'), true);
  for (const bad of ['DELETE FROM t', 'SELECT * INTO t2 FROM t', 'SELECT 1; DROP TABLE t', 'SELECT * FROM t; EXEC xp_cmdshell', "SELECT * FROM OPENROWSET('a')", 'EXEC sp_who']) {
    assert.throws(() => guardMssql(bad, 'query'), `${bad}`);
  }
  assert.ok(!/created_at/.test('')); // created_at sütunu bloklanmamalıdır
  assert.doesNotThrow(() => guardMssql('SELECT created_at, updated FROM t', 'query'));
});

test('guardMssql: prosedur yalnız EXEC ad @a = @a formatında', () => {
  assert.doesNotThrow(() => guardMssql('EXEC dbo.sp_sales @bas = @bas, @son = @son', 'procedure'));
  assert.doesNotThrow(() => guardMssql('exec rpt.Sales', 'procedure'));
  assert.throws(() => guardMssql("EXEC dbo.p @a = 'x'; DROP TABLE t", 'procedure'));
  assert.throws(() => guardMssql('SELECT 1', 'procedure'));
});

test('canWrap: WITH, ORDER BY və prosedur sarınmır', () => {
  assert.equal(canWrap('SELECT a FROM t', 'query'), true);
  assert.equal(canWrap('SELECT a FROM t ORDER BY a', 'query'), false);
  assert.equal(canWrap('WITH x AS (SELECT 1 a) SELECT * FROM x', 'query'), false);
  assert.equal(canWrap('EXEC p', 'procedure'), false);
});

test('buildWrapped: sütunlar, maska, qaydalar və TOP', () => {
  const vis = [{ code: 'filial', masked: false }, { code: 'phone', masked: true }];
  const rcols = [{ code: 'filial', type: 'text' }, { code: 'dt', type: 'date' }, { code: 'amt', type: 'number' }];
  const rules = [
    { column: 'filial', op: 'in', value: ['Bakı', 'Sumqayıt'] },
    { column: 'dt', op: 'gte', value: '2026-01-01' },
    { column: 'amt', op: 'lte', value: 50 },
  ];
  const { sql, extra } = buildWrapped({ inner: 'SELECT 1 x', vis, rules, rcols, top: 11, resolve: (v) => v });
  assert.match(sql, /^SELECT TOP \(11\) r\.\[filial\], LEN\(CAST\(r\.\[phone\] AS NVARCHAR\(MAX\)\)\) AS \[phone\] FROM \(SELECT 1 x\) AS r WHERE /);
  assert.match(sql, /CAST\(r\.\[filial\] AS NVARCHAR\(4000\)\) IN \(@__r0, @__r1\)/);
  assert.match(sql, /CAST\(r\.\[dt\] AS date\) >= CAST\(@__r2 AS date\)/);
  assert.match(sql, /r\.\[amt\] <= @__r3/);
  assert.deepEqual(extra.map((e) => e.type), ['text', 'text', 'date', 'number']);
  assert.throws(() => buildWrapped({ inner: 'x', vis: [{ code: 'a]; DROP', masked: false }], rules: [], rcols: [], top: 1, resolve: (v) => v }));
});

test('applyJs: qayda süzgəci, maska uzunluğu və limit', () => {
  const cols = ['filial', 'phone', 'amt'];
  const rows = [['Bakı', '050123', 10], ['Gəncə', '055999', 20], ['Bakı', null, 30]];
  const vis = [{ code: 'filial', masked: false }, { code: 'phone', masked: true }];
  const out = applyJs({ cols, rows, vis, rcols: [{ code: 'filial', type: 'text' }, { code: 'amt', type: 'number' }],
    rules: [{ column: 'filial', op: 'in', value: ['Bakı'] }, { column: 'amt', op: 'gte', value: 5 }], resolve: (v) => v, max: 10 });
  assert.deepEqual(out, [['Bakı', 6], ['Bakı', null]]);
});

test('colType və normVal', () => {
  assert.equal(colType('nvarchar'), 'text');
  assert.equal(colType('decimal'), 'number');
  assert.equal(colType('datetime2'), 'date');
  assert.equal(normVal(new Date('2026-03-01T00:00:00Z')), '2026-03-01');
  assert.equal(normVal(new Date('2026-03-01T10:20:30Z')), '2026-03-01 10:20:30');
});

test('secret: şifrələ / aç', () => {
  process.env.JWT_SECRET = 'test-secret';
  const e = encrypt('p@ss/Wörd');
  assert.notEqual(e, 'p@ss/Wörd');
  assert.equal(decrypt(e), 'p@ss/Wörd');
  const [iv, tag, enc] = e.split('.');
  assert.throws(() => decrypt([iv, Buffer.alloc(16).toString('base64'), enc].join('.')));
});
