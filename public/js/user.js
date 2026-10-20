import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { t, label, fmtNum } from './i18n.js';
import { resultTable } from './table.js';
import { pivotView } from './pivot.js';
import { collapsible } from './sidelist.js';

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
  const main = h('main', { class: 'content col gap16 fit' });
  clear(root, h('div', { class: 'layout' }, side, main));

  let list = [];
  try {
    list = await api('/api/reports');
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
    return;
  }
  let q = '';
  const cat = collapsible('hp.closed.user');
  const search = h('input', { class: 'inp', placeholder: t('searchReport'), 'aria-label': t('searchReport'),
    oninput: (e) => { q = e.target.value; drawSide(); } });
  const listBox = h('div');
  const foot = h('div', { class: 'note foot' }, t('onlyYourReports'));
  clear(side, h('div', { class: 'pad side-search' }, search), listBox, foot);

  function drawSide() {
    const groups = new Map();
    for (const r of list) {
      if (q && !label(r, 'name').toLowerCase().includes(q.toLowerCase())) continue;
      const key = r.category_id ? label({ n_az: r.cat_az, n_en: r.cat_en, n_ru: r.cat_ru }, 'n') : t('other');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const searching = !!q.trim();
    clear(
      listBox,
      list.length === 0 ? h('div', { class: 'note' }, t('noReports')) : null,
      [...groups.entries()].map(([g, items]) => h('div', {},
        cat.header(g, items.length, searching, drawSide),
        cat.isOpen(g, searching) ? items.map((r) => h('a', { href: `#/reports/${r.id}`, class: `item ${String(r.id) === String(reportId) ? 'on' : ''}` }, label(r, 'name'))) : null)),
      list.length && !groups.size ? h('div', { class: 'note' }, t('noMatch')) : null
    );
  }
  drawSide();

  // Ünvandakı ID yalnız sizin siyahınızdadırsa açılır (köhnə və ya başqasından gələn link səhv sorğu göndərməsin)
  const id = list.some((r) => r.id === reportId) ? reportId : list[0]?.id;
  if (!id) {
    clear(main, h('div', { class: 'empty' }, t('noReports')));
    return;
  }
  if (reportId !== id) {
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
  const resultBox = h('div', { class: 'col gap12 fill' });
  let result = null;
  let usedParams = {}; // nəticənin alındığı parametrlər (detal eyni parametrlərlə açılır)
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
          drillColumn: meta.drill?.column, onDrill: openDetail, fill: true,
        }).el
      : h('div', { class: 'scrollbox fill' }, pivotView({ columns: result.columns, rows: result.rows }));
    clear(
      resultBox,
      h('div', { class: 'row gap12' }, seg, info),
      result.truncated ? h('div', { class: 'warn' }, t('truncated')) : null,
      body
    );
  }

  // Detal pəncərəsi: basılan dəyər serverə göndərilir, server həmin sətrin sizə görünən olduğunu yoxlayır.
  async function openDetail(key) {
    const body = h('div', { class: 'modal-body' }, h('div', { class: 'empty' }, t('running')));
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const col = result.columns.find((c) => c.code === meta.drill.column);
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'toolbar' }, h('b', {}, `${col ? label(col, 'label') : ''}: ${key}`), h('div', { class: 'grow' }),
          h('button', { class: 'btn sm', onclick: close }, t('close'))),
        body));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    try {
      const d = await api(`/api/reports/${id}/detail`, { method: 'POST', body: { key, params: usedParams } });
      clear(body, h('div', { class: 'muted small pad' }, `${fmtNum(d.rows.length, 0)} ${t('rowsWord')} · ${(d.ms / 1000).toFixed(2)} ${t('sec')}`),
        d.truncated ? h('div', { class: 'warn' }, t('truncated')) : null,
        resultTable({ columns: d.columns, rows: d.rows, canExport: false, fileName: label(meta, 'name') }).el);
    } catch (e) {
      clear(body, h('div', { class: 'err' }, e.message));
    }
  }

  async function run() {
    if (running) return;
    running = true;
    drawParams();
    clear(resultBox, h('div', { class: 'empty' }, t('running')));
    try {
      result = await api(`/api/reports/${id}/run`, { method: 'POST', body: { params: values } });
      usedParams = { ...values };
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
