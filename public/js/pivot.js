import { h, clear, copyText, toast } from './dom.js';
import { t, label, fmtNum } from './i18n.js';
import { AGGS, computePivot, heatClasses } from './pivot-core.js';

// columns: [{code,type,masked,label_*}], rows: massiv massivi. Gizli/maskalı sahələr pivotda iştirak etmir.
export function pivotView({ columns, rows }) {
  const fields = columns.map((c, i) => ({ ...c, i })).filter((c) => !c.masked);
  const byCode = Object.fromEntries(fields.map((f) => [f.code, f]));
  const fl = (code) => label(byCode[code], 'label') || code;

  const textFields = fields.filter((f) => f.type !== 'number');
  const numFields = fields.filter((f) => f.type === 'number');
  const cfg = {
    rowFields: textFields.slice(0, 1).map((f) => f.code),
    colFields: [],
    values: numFields.length
      ? [{ field: numFields[0].code, agg: 'sum' }]
      : fields.length ? [{ field: fields[0].code, agg: 'count' }] : [],
    subtotals: true,
    grandTotal: true,
  };

  const objects = rows.map((r) => {
    const o = {};
    for (const f of fields) o[f.code] = r[f.i];
    return o;
  });

  const intCache = {};
  const intField = (code) => (code in intCache ? intCache[code]
    : (intCache[code] = objects.every((o) => o[code] === null || o[code] === undefined || Number.isInteger(Number(o[code])))));

  const zones = h('div', { class: 'col gap14' });
  const out = h('div', { class: 'xscroll grow' });
  let lastTSV = '';

  function addTo(zone, code) {
    if (!byCode[code]) return;
    if (zone === 'values') {
      cfg.values.push({ field: code, agg: byCode[code].type === 'number' ? 'sum' : 'count' });
    } else if (!cfg[zone].includes(code)) {
      // bir sahə yalnız bir zonada: sətir ↔ sütun
      const other = zone === 'rowFields' ? 'colFields' : 'rowFields';
      cfg[other] = cfg[other].filter((c) => c !== code);
      cfg[zone].push(code);
    }
    redraw();
  }

  function fieldSelect(zone) {
    return h('select', { class: 'inp sm', 'aria-label': t('addField'), onchange: (e) => {
      if (e.target.value) addTo(zone, e.target.value);
    } },
    h('option', { value: '' }, `+ ${t('addField')}`),
    fields.map((f) => h('option', { value: f.code }, fl(f.code))));
  }

  function zoneBox(zone, title) {
    const chips = (zone === 'values' ? cfg.values : cfg[zone]).map((item, idx) => {
      const remove = () => {
        if (zone === 'values') cfg.values.splice(idx, 1);
        else cfg[zone].splice(idx, 1);
        redraw();
      };
      if (zone === 'values') {
        return h('span', { class: 'chip' },
          h('select', { class: 'chip-sel', 'aria-label': t('aggregate'), onchange: (e) => { item.agg = e.target.value; redraw(); } },
            AGGS.map((a) => h('option', { value: a, selected: a === item.agg }, t(`agg.${a}`)))),
          ` ${fl(item.field)} `,
          h('button', { class: 'x', 'aria-label': t('remove'), onclick: remove }, '×'));
      }
      return h('span', { class: 'chip' }, fl(item), ' ', h('button', { class: 'x', 'aria-label': t('remove'), onclick: remove }, '×'));
    });
    return h('div', {},
      h('div', { class: 'lbl' }, title),
      h('div', { class: 'zone',
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => { e.preventDefault(); addTo(zone, e.dataTransfer.getData('text/plain')); } },
        chips, fieldSelect(zone)));
  }

  function drawZones() {
    clear(
      zones,
      h('div', {},
        h('div', { class: 'lbl' }, t('fields')),
        h('div', { class: 'row wrap gap6' }, fields.map((f) => h('span', { class: 'fchip', draggable: true,
          ondragstart: (e) => e.dataTransfer.setData('text/plain', f.code) }, fl(f.code))),
        columns.filter((c) => c.masked).map((c) => h('span', { class: 'fchip off', title: t('maskedNoPivot') }, `${label(c, 'label')} (${t('masked')})`)))),
      zoneBox('rowFields', t('pivotRows')),
      zoneBox('colFields', t('pivotCols')),
      zoneBox('values', t('pivotValues')),
      h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: cfg.subtotals, onchange: (e) => { cfg.subtotals = e.target.checked; redraw(); } }), t('subtotals')),
      h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: cfg.grandTotal, onchange: (e) => { cfg.grandTotal = e.target.checked; redraw(); } }), t('grandTotal')),
      h('div', { class: 'note' }, t('pivotNote'))
    );
  }

  function drawTable() {
    if (!cfg.values.length) {
      clear(out, h('div', { class: 'empty' }, t('pivotNeedValue')));
      lastTSV = '';
      return;
    }
    const res = computePivot(objects, cfg);
    const vLabel = (v) => `${t(`agg.${v.agg}`)} · ${fl(v.field)}`;
    const multi = cfg.values.length > 1;
    const dec = (v) => (v.agg === 'count' ? 0 : v.agg === 'avg' ? 2 : intField(v.field) ? 0 : 2);

    const headCells = [];
    res.cols.forEach((ck) => {
      cfg.values.forEach((v) => headCells.push({ text: res.hasCols ? (multi ? `${ck} · ${vLabel(v)}` : ck) : vLabel(v) }));
    });
    const showTotals = res.hasCols;
    if (showTotals) cfg.values.forEach((v) => headCells.push({ text: `${t('total')} · ${vLabel(v)}`, total: true }));

    const heats = cfg.values.map((_, vi) => heatClasses(res, vi));
    const tsv = [[cfg.rowFields.map(fl).join(' / ') || ' ', ...headCells.map((c) => c.text)].join('\t')];

    const body = [];
    const pushRow = (r, cls) => {
      const labelText = r.kind === 'grand' ? t('grandTotalRow') : r.label;
      const cells = [];
      const flat = [];
      r.cells.forEach((cs, ci) => {
        cs.forEach((val, vi) => {
          cells.push(h('td', { class: `n ${r.kind === 'leaf' ? heats[vi](val) : ''}` }, val === null ? '' : fmtNum(val, dec(cfg.values[vi]))));
          flat.push(val === null ? '' : String(val));
        });
      });
      if (showTotals) {
        r.total.forEach((val, vi) => {
          cells.push(h('td', { class: 'n tot' }, val === null ? '' : fmtNum(val, dec(cfg.values[vi]))));
          flat.push(val === null ? '' : String(val));
        });
      }
      body.push(h('tr', { class: cls }, h('td', { style: { paddingLeft: `${12 + (r.kind === 'grand' ? 0 : r.level * 18)}px` } }, labelText), cells));
      tsv.push([' '.repeat(0) + labelText, ...flat].join('\t'));
    };
    res.rows.forEach((r) => pushRow(r, r.kind === 'group' ? 'g' : ''));
    if (res.grand) pushRow(res.grand, 't');

    lastTSV = tsv.join('\n');
    clear(out, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, cfg.rowFields.map(fl).join(' / ') || ''), headCells.map((c) => h('th', { class: 'n' }, c.text)))),
      h('tbody', {}, body)),
    h('div', { class: 'legend' },
      h('span', { class: 'sw h1' }), t('heatHigh'), h('span', { class: 'sw h3' }), t('heatLow'), h('span', { class: 'muted' }, t('pivotCopyHint'))));
  }

  function redraw() {
    drawZones();
    drawTable();
  }
  redraw();

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'muted small' }, t('pivotHint')),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn', onclick: async () => {
      const ok = await copyText(lastTSV);
      toast(ok ? t('copied') : t('copyFail'), ok ? 'ok' : 'err');
    } }, t('copy')));

  return h('div', { class: 'card clip' },
    toolbar,
    h('div', { class: 'pivot-layout' }, h('div', { class: 'pivot-side' }, zones), out));
}
