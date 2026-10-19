import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { t, label, fmtNum } from './i18n.js';
import { resultTable } from './table.js';
import { pivotView } from './pivot.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function defaultFor(p) {
  const now = new Date();
  if (p.default === '$today') return ymd(now);
  if (p.default === '$monthStart') return ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  return p.default ?? '';
}

export async function userPage(root, reportId) {
  const side = h('aside', { class: 'side' });
  const main = h('main', { class: 'content col gap16' });
  clear(root, h('div', { class: 'layout' }, side, main));

  let list = [];
  try {
    list = await api('/api/reports');
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
    return;
  }
  let q = '';

  function drawSide() {
    const groups = new Map();
    for (const r of list) {
      if (q && !label(r, 'name').toLowerCase().includes(q.toLowerCase())) continue;
      const key = r.category_id ? label({ n_az: r.cat_az, n_en: r.cat_en, n_ru: r.cat_ru }, 'n') : t('other');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    clear(
      side,
      h('div', { class: 'pad' }, h('input', { class: 'inp', placeholder: t('searchReport'), 'aria-label': t('searchReport'),
        oninput: (e) => { q = e.target.value; drawSide(); } })),
      list.length === 0 ? h('div', { class: 'note' }, t('noReports')) : null,
      [...groups.entries()].map(([g, items]) => h('div', {},
        h('div', { class: 'grp' }, g.toUpperCase()),
        items.map((r) => h('a', { href: `#/reports/${r.id}`, class: `item ${String(r.id) === String(reportId) ? 'on' : ''}` }, label(r, 'name'))))),
      h('div', { class: 'note foot' }, t('onlyYourReports'))
    );
  }
  drawSide();

  const id = reportId || list[0]?.id;
  if (!id) {
    clear(main, h('div', { class: 'empty' }, t('noReports')));
    return;
  }
  if (!reportId) {
    history.replaceState(null, '', `#/reports/${id}`);
    drawSide();
  }

  let meta;
  try {
    meta = await api(`/api/reports/${id}/meta`);
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
    return;
  }

  const values = {};
  const options = {};
  for (const p of meta.params) values[p.name] = defaultFor(p);
  for (const p of meta.params.filter((x) => x.type === 'list' && x.hasOptions)) {
    api(`/api/reports/${id}/options/${p.name}`).then((o) => { options[p.name] = o; drawParams(); }).catch(() => {});
  }

  const paramsBox = h('div', { class: 'card pad row wrap gap16 end' });
  const resultBox = h('div', { class: 'col gap12' });
  let result = null;
  let mode = 'table';
  let running = false;

  function paramInput(p) {
    const common = { 'aria-label': p.label || p.name };
    if (p.type === 'list') {
      return h('select', { ...common, class: 'inp', onchange: (e) => { values[p.name] = e.target.value; } },
        h('option', { value: '' }, t('all')),
        (options[p.name] || []).map((o) => h('option', { value: o.value, selected: o.value === values[p.name] }, o.label)));
    }
    return h('input', { ...common, class: 'inp', type: p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text',
      value: values[p.name], oninput: (e) => { values[p.name] = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') run(); } });
  }

  function drawParams() {
    clear(
      paramsBox,
      meta.params.map((p) => h('label', { class: 'fld' }, h('span', {}, p.label || p.name, p.required ? h('span', { class: 'req' }, ' *') : null), paramInput(p))),
      h('button', { class: 'btn primary', disabled: running, onclick: run }, running ? t('running') : t('run')),
      h('div', { class: 'grow' }),
      meta.restricted || meta.hiddenCount
        ? h('div', { class: 'lock-note' }, [
            meta.restricted ? t('rowsRestricted') : '',
            meta.hiddenCount ? ` ${meta.hiddenCount} ${t('hiddenCols')}` : '',
          ].join(''))
        : null
    );
  }

  function drawResult() {
    if (!result) {
      clear(resultBox);
      return;
    }
    const seg = h('div', { class: 'seg' },
      h('button', { class: mode === 'table' ? 'on' : '', onclick: () => { mode = 'table'; drawResult(); } }, t('viewTable')),
      h('button', { class: mode === 'pivot' ? 'on' : '', onclick: () => { mode = 'pivot'; drawResult(); } }, t('viewPivot')));
    const info = h('div', { class: 'muted small' }, `${fmtNum(result.rows.length, 0)} ${t('rowsWord')} · ${(result.ms / 1000).toFixed(2)} ${t('sec')}`);
    const body = mode === 'table'
      ? resultTable({
          columns: result.columns, rows: result.rows, canExport: result.canExport, fileName: label(meta, 'name'),
          onExport: (n) => api(`/api/reports/${id}/export-log`, { method: 'POST', body: { rows: n } }).catch(() => {}),
        }).el
      : pivotView({ columns: result.columns, rows: result.rows });
    clear(
      resultBox,
      h('div', { class: 'row gap12' }, seg, info),
      result.truncated ? h('div', { class: 'warn' }, t('truncated')) : null,
      body
    );
  }

  async function run() {
    if (running) return;
    running = true;
    drawParams();
    clear(resultBox, h('div', { class: 'empty' }, t('running')));
    try {
      result = await api(`/api/reports/${id}/run`, { method: 'POST', body: { params: values } });
      drawResult();
    } catch (e) {
      result = null;
      clear(resultBox, h('div', { class: 'err' }, e.message));
      toast(e.message, 'err');
    } finally {
      running = false;
      drawParams();
    }
  }

  drawParams();
  clear(
    main,
    h('div', { class: 'row wrap gap12 base' },
      h('h1', {}, label(meta, 'name')),
      h('div', { class: 'muted' }, meta.description || '')),
    paramsBox,
    resultBox
  );
}
