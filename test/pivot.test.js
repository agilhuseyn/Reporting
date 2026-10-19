import test from 'node:test';
import assert from 'node:assert/strict';
import { computePivot } from '../public/js/pivot-core.js';

const rows = [
  { filial: 'Bakı', rep: 'A', ay: '2026-07', amount: 100 },
  { filial: 'Bakı', rep: 'A', ay: '2026-08', amount: 50 },
  { filial: 'Bakı', rep: 'B', ay: '2026-07', amount: 25 },
  { filial: 'Sumqayıt', rep: 'C', ay: '2026-07', amount: 10 },
];

test('iki səviyyəli pivot: alt yekun və ümumi yekun', () => {
  const r = computePivot(rows, {
    rowFields: ['filial', 'rep'], colFields: ['ay'],
    values: [{ field: 'amount', agg: 'sum' }, { field: 'amount', agg: 'count' }],
  });
  assert.deepEqual(r.cols, ['2026-07', '2026-08']);
  const baki = r.rows.find((x) => x.kind === 'group' && x.label === 'Bakı');
  assert.equal(baki.total[0], 175);
  assert.equal(baki.cells[0][0], 125);
  assert.equal(baki.cells[1][0], 50);
  assert.equal(r.grand.total[0], 185);
  assert.equal(r.grand.total[1], 4);
  assert.equal(r.rows.filter((x) => x.kind === 'leaf').length, 3);
});

test('alt yekunsuz', () => {
  const r = computePivot(rows, { rowFields: ['filial', 'rep'], colFields: [], values: [{ field: 'amount', agg: 'avg' }], subtotals: false });
  assert.ok(r.rows.every((x) => x.kind === 'leaf'));
  assert.equal(r.rows.length, 3);
});

test('sətir sahəsi yoxdursa bir sətir', () => {
  const r = computePivot(rows, { rowFields: [], colFields: ['ay'], values: [{ field: 'amount', agg: 'max' }] });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].total[0], 100);
});
