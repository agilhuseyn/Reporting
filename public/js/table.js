import { h, clear, copyText, toast, download } from './dom.js';
import { t, lang, label, fmtNum } from './i18n.js';

function rawNum(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  return lang() === 'en' ? s : s.replace('.', ',');
}

function cellText(col, v) {
  if (v === null || v === undefined) return '';
  if (col.type === 'number') return fmtNum(v, col.dec ?? 2);
  return String(v);
}

// Nəticə cədvəli: çeşidləmə, sütun filtri, axtarış, səhifələmə, sətir seçimi, kopyalama.
// columns: [{code,label_*,type,masked}], rows: massiv massivi.
// drillColumn + onDrill: həmin sütunun dəyərinə basanda detal açılır (admin hesabatda təyin edir).
export function resultTable({ columns: cols, rows, canExport, fileName, onExport, drillColumn, onDrill }) {
  // Hamısı tam ədəddirsə, onluq göstərmirik (say, say-sütunları)
  const columns = cols.map((c, ci) => {
    if (c.type !== 'number' || c.masked) return c;
    const allInt = rows.every((r) => r[ci] === null || r[ci] === undefined || Number.isInteger(Number(r[ci])));
    return { ...c, dec: allInt ? 0 : 2 };
  });
  const state = { sort: null, filters: {}, search: '', page: 0, size: 100, selected: new Set() };
  let order = rows.map((_, i) => i);

  const colLabel = (c) => label(c, 'label') || c.code;

  function recompute() {
    const q = state.search.trim().toLowerCase();
    let idx = rows.map((_, i) => i);
    const active = Object.entries(state.filters).filter(([, v]) => v);
    if (active.length || q) {
      idx = idx.filter((i) => {
        const row = rows[i];
        for (const [ci, v] of active) {
          if (!cellText(columns[ci], row[ci]).toLowerCase().includes(v.toLowerCase())) return false;
        }
        if (q) {
          let hit = false;
          for (let ci = 0; ci < columns.length && !hit; ci++) {
            if (columns[ci].masked) continue;
            if (cellText(columns[ci], row[ci]).toLowerCase().includes(q)) hit = true;
          }
          if (!hit) return false;
        }
        return true;
      });
    }
    if (state.sort) {
      const { ci, dir } = state.sort;
      const num = columns[ci].type === 'number';
      idx.sort((a, b) => {
        const x = rows[a][ci];
        const y = rows[b][ci];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const r = num ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'az');
        return dir * r;
      });
    }
    order = idx;
  }

  const thead = h('thead');
  const tbody = h('tbody');
  const info = h('span');
  const pager = h('div', { class: 'row gap8' });
  const countEl = h('div', { class: 'strong' });

  function drawHead() {
    const head = h('tr');
    const filt = h('tr', { class: 'filters' });
    head.append(h('th', { class: 'rn' }, '#'));
    filt.append(h('th', { class: 'rn' }));
    columns.forEach((c, ci) => {
      const arrow = state.sort?.ci === ci ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : '';
      head.append(
        h('th', { class: c.type === 'number' ? 'n sortable' : 'sortable', onclick: () => {
          state.sort = state.sort?.ci === ci ? (state.sort.dir === 1 ? { ci, dir: -1 } : null) : { ci, dir: 1 };
          recompute();
          drawHead();
          drawBody();
        } }, colLabel(c), arrow)
      );
      filt.append(
        h('th', {}, c.masked
          ? h('span', { class: 'muted small' }, t('masked'))
          : h('input', { class: 'fi', 'aria-label': `${t('filter')}: ${colLabel(c)}`, placeholder: t('filter'),
              value: state.filters[ci] || '', oninput: (e) => {
                state.filters[ci] = e.target.value;
                state.page = 0;
                recompute();
                drawBody();
              } }))
      );
    });
    clear(thead, head, filt);
  }

  function drawBody() {
    const total = order.length;
    const pages = Math.max(1, Math.ceil(total / state.size));
    if (state.page >= pages) state.page = pages - 1;
    const from = state.page * state.size;
    const slice = order.slice(from, from + state.size);
    clear(
      tbody,
      slice.map((ri, k) => {
        const row = rows[ri];
        const tr = h('tr', { class: state.selected.has(ri) ? 'selrow' : '' });
        tr.append(h('td', { class: 'rn', title: t('selectRow'), onclick: () => {
          if (state.selected.has(ri)) state.selected.delete(ri);
          else state.selected.add(ri);
          tr.classList.toggle('selrow');
          drawInfo();
        } }, from + k + 1));
        columns.forEach((c, ci) => {
          const v = row[ci];
          if (c.masked) tr.append(h('td', { class: c.type === 'number' ? 'n' : '' }, h('span', { class: 'blur', 'aria-hidden': 'true' }, cellText(c, v))));
          else if (drillColumn && onDrill && c.code === drillColumn && v !== null && v !== undefined) {
            tr.append(h('td', { class: c.type === 'number' ? 'n' : '' },
              h('button', { class: 'drill', type: 'button', title: t('drillOpen'), onclick: (e) => { e.stopPropagation(); onDrill(v, row); } }, cellText(c, v))));
          } else tr.append(h('td', { class: c.type === 'number' ? 'n' : '' }, cellText(c, v)));
        });
        return tr;
      })
    );
    drawInfo();
    clear(
      pager,
      h('span', { class: 'muted small' }, t('perPage')),
      h('select', { 'aria-label': t('perPage'), onchange: (e) => {
        state.size = Number(e.target.value);
        state.page = 0;
        drawBody();
      } }, [50, 100, 500, 1000].map((n) => h('option', { value: n, selected: n === state.size }, n))),
      h('button', { class: 'btn sm', disabled: state.page === 0, onclick: () => { state.page--; drawBody(); } }, t('prev')),
      h('span', { class: 'muted small' }, `${state.page + 1} / ${pages}`),
      h('button', { class: 'btn sm', disabled: state.page >= pages - 1, onclick: () => { state.page++; drawBody(); } }, t('next'))
    );
  }

  function drawInfo() {
    const total = order.length;
    const from = total ? state.page * state.size + 1 : 0;
    const to = Math.min(total, (state.page + 1) * state.size);
    clear(info, `${fmtNum(from, 0)}–${fmtNum(to, 0)} / ${fmtNum(total, 0)}`, state.selected.size ? ` · ${t('selected')}: ${state.selected.size}` : '');
    clear(countEl, `${fmtNum(rows.length, 0)} ${t('rowsWord')}`);
  }

  function exportRows() {
    const src = state.selected.size ? order.filter((i) => state.selected.has(i)) : order;
    return src.map((i) => rows[i]);
  }

  function toTSV(sep = '\t') {
    const esc = (s) => (sep === ';' && /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [columns.map((c) => esc(colLabel(c))).join(sep)];
    for (const row of exportRows()) {
      lines.push(columns.map((c, ci) => {
        if (c.masked) return '***';
        const v = row[ci];
        if (v === null || v === undefined) return '';
        return esc(c.type === 'number' ? rawNum(v) : String(v).replace(/[\t\r\n]+/g, ' '));
      }).join(sep));
    }
    return lines.join('\n');
  }

  recompute();
  drawHead();
  drawBody();

  const search = h('input', { class: 'inp', style: { width: '200px' }, placeholder: t('searchTable'), 'aria-label': t('searchTable'),
    oninput: (e) => { state.search = e.target.value; state.page = 0; recompute(); drawBody(); } });

  const toolbar = h('div', { class: 'toolbar' },
    countEl,
    h('div', { class: 'grow' }),
    search,
    h('button', { class: 'btn', onclick: async () => {
      const ok = await copyText(toTSV('\t'));
      toast(ok ? `${t('copied')} (${exportRows().length} ${t('rowsWord')})` : t('copyFail'), ok ? 'ok' : 'err');
    } }, t('copy')),
    canExport ? h('button', { class: 'btn', onclick: () => {
      download(`${fileName || 'report'}.csv`, toTSV(';'));
      onExport?.(exportRows().length);
    } }, t('exportCsv')) : null
  );

  const el = h('div', { class: 'card clip' },
    toolbar,
    h('div', { class: 'xscroll' }, h('table', { class: 'tbl' }, thead, tbody)),
    h('div', { class: 'foot' }, info, h('div', { class: 'grow' }), pager)
  );
  return { el, toTSV, exportRows };
}
