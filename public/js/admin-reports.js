import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { t, label, fmtNum } from './i18n.js';

const blank = () => ({
  id: null, code: '', name_az: '', name_en: '', name_ru: '', category_id: null, kind: 'query', description: '',
  sql: '', params: [], columns: [], active: true, version: 0, versions: [], drill: null,
});

export async function adminReports(root, me) {
  const canEdit = me.caps.includes('reports');
  const isAdmin = me.role === 'admin'; // kodları yalnız admin görür
  const side = h('aside', { class: 'side' });
  const main = h('main', { class: 'content col gap16' });
  clear(root, h('div', { class: 'layout' }, side, main));

  let list = [];
  let cats = [];
  let rep = null;
  let testOut = null;
  const testVals = {};
  let drillTest = null;
  let drillVal = '';

  async function loadList() {
    [list, cats] = await Promise.all([api('/api/admin/reports'), api('/api/admin/categories')]);
    drawSide();
  }

  function drawSide() {
    const groups = new Map();
    for (const r of list) {
      const c = cats.find((x) => x.id === r.category_id);
      const key = c ? label(c, 'name') : t('other');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    clear(
      side,
      h('div', { class: 'pad row' }, h('b', {}, t('reports')), h('div', { class: 'grow' }),
        canEdit ? h('button', { class: 'btn primary sm', onclick: () => { rep = blank(); testOut = null; drawEditor(); } }, `+ ${t('new')}`) : null),
      [...groups.entries()].map(([g, items]) => h('div', {},
        h('div', { class: 'grp' }, g.toUpperCase()),
        items.map((r) => h('a', { href: '#/admin/reports', class: `item ${rep?.id === r.id ? 'on' : ''}`,
          onclick: (e) => { e.preventDefault(); openReport(r.id); } },
        h('span', {}, label(r, 'name'), r.active ? '' : ` (${t('inactive')})`),
        h('span', { class: 'tag' }, t(`kind.${r.kind}`))))))
    );
  }

  async function openReport(id) {
    rep = await api(`/api/admin/reports/${id}`);
    testOut = null;
    drawSide();
    drawEditor();
  }

  const field = (title, input) => h('label', { class: 'fld' }, title, input);
  const text = (key, extra = {}) => h('input', { class: 'inp', value: rep[key] ?? '', readOnly: !canEdit || extra.readOnly,
    oninput: (e) => { rep[key] = e.target.value; } });

  const known = () => rep.columns.map((c) => ({ code: c.code, src: c.src, type: c.type, label_az: c.label_az }));
  const analyzeSql = () => api('/api/admin/reports/analyze', {
    method: 'POST',
    body: { sql: rep.sql, known: known(), columns: testOut && !testOut.error ? testOut.columns : null },
  });

  // Parametrlər SQL-dən tapılır. Ad və tip müqayisə olunan sütundan götürülür (məs. filial_kod = @filial → "Filial").
  async function syncParams() {
    const a = await analyzeSql();
    const old = Object.fromEntries(rep.params.map((p) => [p.name, p]));
    rep.params = a.detected.map((n) => {
      const hit = a.params[n];
      return old[n] || {
        name: n, required: false, label: hit?.label || n,
        type: hit?.type || (n.includes('tarix') || n.includes('date') ? 'date' : 'text'),
      };
    });
    return a;
  }

  async function runTest() {
    try {
      const a = await syncParams();
      if (!rep.columns.length && a.columns.length && !a.star) {
        rep.columns = a.columns.map((c) => ({ code: c.code, src: c.src, label_az: c.label, label_en: c.label, label_ru: c.label, type: c.type, sensitivity: 'normal' }));
      }
      for (const p of rep.params) if (testVals[p.name] === undefined) testVals[p.name] = p.default && !String(p.default).startsWith('$') ? p.default : (p.type === 'date' ? new Date().toISOString().slice(0, 10) : '');
      drawEditor();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
  }

  async function execTest() {
    try {
      testOut = await api('/api/admin/reports/test', { method: 'POST', body: { sql: rep.sql, params: testVals, types: Object.fromEntries(rep.params.map((p) => [p.name, p.type])) } });
    } catch (e) {
      testOut = { error: e.message };
    }
    drawEditor();
  }

  // Sütun kodu və adı SQL-dən: filial_kod AS Filial → kod filial_kod, ad Filial.
  async function mergeColumns() {
    try {
      const a = await analyzeSql();
      const old = Object.fromEntries(rep.columns.map((c) => [c.code, c]));
      rep.columns = a.columns.map((c) => {
        const o = old[c.code];
        return o
          ? { ...o, src: c.src, type: c.type }
          : { code: c.code, src: c.src, label_az: c.label, label_en: c.label, label_ru: c.label, type: c.type, sensitivity: 'normal' };
      });
      drawEditor();
      toast(t('columnsFound'));
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  const drillKeyType = () => rep.columns.find((c) => c.code === rep.drill?.column)?.type || 'text';

  // Detal sütunları detal SQL-dən (və ya test nəticəsindən) götürülür; əvvəl yazılmış adlar saxlanır.
  async function drillFind(silent) {
    try {
      const a = await api('/api/admin/reports/analyze', {
        method: 'POST',
        body: { sql: rep.drill.sql, known: rep.drill.columns, columns: drillTest && !drillTest.error ? drillTest.columns : null },
      });
      const old = Object.fromEntries(rep.drill.columns.map((c) => [c.code, c]));
      rep.drill.columns = a.columns.map((c) => {
        const o = old[c.code];
        return o ? { ...o, src: c.src, type: c.type } : { code: c.code, src: c.src, label_az: c.label, label_en: c.label, label_ru: c.label, type: c.type };
      });
      if (!silent) {
        drawEditor();
        toast(t('columnsFound'));
      }
    } catch (e) {
      if (!silent) toast(e.message, 'err');
    }
  }

  async function drillExecTest() {
    try {
      drillTest = await api('/api/admin/reports/test', { method: 'POST', body: {
        sql: rep.drill.sql, params: { ...testVals, deyer: drillVal },
        types: { ...Object.fromEntries(rep.params.map((p) => [p.name, p.type])), deyer: drillKeyType() },
      } });
      if (!rep.drill.columns.length) await drillFind(true);
    } catch (e) {
      drillTest = { error: e.message };
    }
    drawEditor();
  }

  function drillCard() {
    const d = rep.drill;
    const dcol = (c) => {
      const inp = (k) => h('input', { class: 'inp sm', value: c[k] || '', readOnly: !canEdit, oninput: (e) => { c[k] = e.target.value; } });
      return h('tr', {}, isAdmin ? h('td', { class: 'mono' }, c.code) : null, h('td', {}, inp('label_az')), h('td', {}, inp('label_en')), h('td', {}, inp('label_ru')),
        h('td', {}, h('select', { class: 'inp sm', disabled: !canEdit, onchange: (e) => { c.type = e.target.value; } },
          ['text', 'number', 'date'].map((x) => h('option', { value: x, selected: x === c.type }, t(`ptype.${x}`))))));
    };
    return h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('b', {}, t('drillTitle')), h('div', { class: 'grow' }), h('span', { class: 'muted small' }, t('drillHint'))),
      h('div', { class: 'pad col gap12' },
        h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: !!d, disabled: !canEdit, onchange: (e) => {
          rep.drill = e.target.checked ? { column: rep.columns[0]?.code || '', sql: '', columns: [] } : null;
          drillTest = null;
          drawEditor();
        } }), t('drillEnable')),
        d ? h('div', { class: 'col gap12' },
          field(t('drillColumn'), h('select', { class: 'inp', disabled: !canEdit, onchange: (e) => { d.column = e.target.value; } },
            rep.columns.map((c) => h('option', { value: c.code, selected: c.code === d.column }, c.label_az || c.code)))),
          field(t('drillSql'), h('textarea', { class: 'sql', spellcheck: 'false', readOnly: !canEdit, value: d.sql, oninput: (e) => { d.sql = e.target.value; } })),
          canEdit ? h('div', { class: 'row wrap gap12 end' },
            field(t('drillTestValue'), h('input', { class: 'inp', value: drillVal, oninput: (e) => { drillVal = e.target.value; } })),
            h('button', { class: 'btn primary', onclick: drillExecTest }, t('test')),
            h('button', { class: 'btn', onclick: () => drillFind(false) }, t('drillFind'))) : null,
          drillTest ? previewTable(drillTest, () => drillFind(false)) : null,
          d.columns.length ? h('div', { class: 'col gap6' },
            h('b', {}, t('drillColumns')), h('div', { class: 'muted small' }, t('drillColumnsNote')),
            h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
              h('thead', {}, h('tr', {}, [...(isAdmin ? [t('code')] : []), 'AZ', 'EN', 'RU', t('type')].map((x) => h('th', {}, x)))),
              h('tbody', {}, d.columns.map(dcol))))) : null) : null));
  }

  async function save() {
    try {
      if (rep.drill?.sql && !rep.drill.columns.length) await drillFind(true);
      await syncParams();
      const body = { ...rep };
      if (rep.id) await api(`/api/admin/reports/${rep.id}`, { method: 'PUT', body });
      else {
        const r = await api('/api/admin/reports', { method: 'POST', body });
        rep.id = r.id;
      }
      toast(t('saved'));
      await loadList();
      await openReport(rep.id);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function paramRow(p) {
    return h('tr', {},
      h('td', { class: 'mono' }, `@${p.name}`),
      h('td', {}, h('input', { class: 'inp sm', value: p.label || '', oninput: (e) => { p.label = e.target.value; } })),
      h('td', {}, h('select', { class: 'inp sm', onchange: (e) => { p.type = e.target.value; drawEditor(); } },
        ['text', 'number', 'date', 'list'].map((x) => h('option', { value: x, selected: x === p.type }, t(`ptype.${x}`))))),
      h('td', {}, h('input', { type: 'checkbox', checked: !!p.required, 'aria-label': t('required'), onchange: (e) => { p.required = e.target.checked; } })),
      h('td', {}, p.type === 'list'
        ? h('input', { class: 'inp sm mono', placeholder: 'SELECT value_col AS value, label_col AS label FROM ...', value: p.optionsSql || '', oninput: (e) => { p.optionsSql = e.target.value; } })
        : h('input', { class: 'inp sm', placeholder: '$today / $monthStart', value: p.default || '', oninput: (e) => { p.default = e.target.value; } })));
  }

  function columnRow(c) {
    const inp = (k) => h('input', { class: 'inp sm', value: c[k] || '', oninput: (e) => { c[k] = e.target.value; } });
    return h('tr', {},
      isAdmin ? h('td', { class: 'mono' }, c.code) : null, isAdmin ? h('td', { class: 'mono small muted' }, c.src || '') : null, h('td', {}, inp('label_az')), h('td', {}, inp('label_en')), h('td', {}, inp('label_ru')),
      h('td', {}, h('select', { class: 'inp sm', onchange: (e) => { c.type = e.target.value; } },
        ['text', 'number', 'date'].map((x) => h('option', { value: x, selected: x === c.type }, t(`ptype.${x}`))))),
      h('td', {}, h('select', { class: 'inp sm', onchange: (e) => { c.sensitivity = e.target.value; } },
        ['normal', 'sensitive'].map((x) => h('option', { value: x, selected: x === c.sensitivity }, t(`sens.${x}`))))));
  }

  function previewTable(out, onUse = mergeColumns) {
    if (out.error) return h('div', { class: 'err' }, out.error);
    return h('div', { class: 'col gap8' },
      h('div', { class: 'muted small' }, `${out.rows.length} ${t('rowsWord')} · ${(out.ms / 1000).toFixed(2)} ${t('sec')}`),
      h('div', { class: 'xscroll card' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, out.columns.map((c) => h('th', {}, c.code)))),
        h('tbody', {}, out.rows.slice(0, 20).map((r) => h('tr', {}, out.columns.map((c, i) => h('td', { class: c.type === 'number' ? 'n' : '' },
          r[i] === null ? '' : c.type === 'number' ? fmtNum(r[i]) : String(r[i]))))))),
      h('div', {}, canEdit ? h('button', { class: 'btn', onclick: onUse }, t('useColumns')) : null)));
  }

  function drawEditor() {
    if (!rep) {
      clear(main, h('div', { class: 'empty' }, t('pickReport')));
      return;
    }
    const catSel = h('select', { class: 'inp', disabled: !canEdit, onchange: (e) => { rep.category_id = e.target.value || null; } },
      h('option', { value: '' }, t('other')),
      cats.map((c) => h('option', { value: c.id, selected: c.id === rep.category_id }, label(c, 'name'))));
    clear(
      main,
      h('div', { class: 'card pad col gap12' },
        h('div', { class: 'row wrap gap10' },
          h('h1', {}, rep.id ? label(rep, 'name') : t('newReport')),
          rep.id ? h('span', { class: 'tag' }, `v${rep.version}`) : null,
          h('div', { class: 'grow' }),
          canEdit ? h('button', { class: 'btn primary', onclick: save }, t('save')) : null),
        h('div', { class: 'grid3' }, field(`${t('name')} (AZ)`, text('name_az')), field(`${t('name')} (EN)`, text('name_en')), field(`${t('name')} (RU)`, text('name_ru'))),
        h('div', { class: 'row wrap gap16 end' },
          isAdmin && rep.id ? field(t('code'), h('span', { class: 'mono tag' }, rep.code)) : null,
          field(t('category'), h('div', { class: 'row gap6' }, catSel, canEdit ? h('button', { class: 'btn sm', onclick: async () => {
            const n = prompt(t('categoryName'));
            if (!n) return;
            await api('/api/admin/categories', { method: 'POST', body: { name_az: n } });
            cats = await api('/api/admin/categories');
            drawEditor();
          } }, '+') : null)),
          field(t('kind'), h('select', { class: 'inp', disabled: !canEdit, onchange: (e) => { rep.kind = e.target.value; } },
            ['query', 'procedure', 'function'].map((k) => h('option', { value: k, selected: k === rep.kind }, t(`kind.${k}`))))),
          h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: rep.active, disabled: !canEdit, onchange: (e) => { rep.active = e.target.checked; } }), t('active'))),
        field(t('description'), text('description'))),
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' }, h('b', {}, t('sqlTitle')), h('div', { class: 'grow' }),
          h('span', { class: 'muted small' }, t('sqlHint'))),
        h('textarea', { class: 'sql', spellcheck: 'false', readOnly: !canEdit, value: rep.sql, oninput: (e) => { rep.sql = e.target.value; } }),
        h('div', { class: 'foot' }, h('span', { class: 'muted small' }, t('sqlGuard')), h('div', { class: 'grow' }),
          canEdit ? h('button', { class: 'btn', onclick: runTest }, `${t('detectParams')}`) : null)),
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' }, h('b', {}, t('params'))),
        rep.params.length
          ? h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
              h('thead', {}, h('tr', {}, [t('param'), t('label'), t('type'), t('required'), t('defaultOrOptions')].map((x) => h('th', {}, x)))),
              h('tbody', {}, rep.params.map(paramRow))))
          : h('div', { class: 'note' }, t('noParams'))),
      canEdit ? h('div', { class: 'card pad col gap12' },
        h('b', {}, t('testTitle')),
        h('div', { class: 'row wrap gap12 end' },
          rep.params.map((p) => h('label', { class: 'fld' }, p.label || p.name,
            h('input', { class: 'inp', type: p.type === 'date' ? 'date' : 'text', value: testVals[p.name] ?? '', oninput: (e) => { testVals[p.name] = e.target.value; } }))),
          h('button', { class: 'btn primary', onclick: execTest }, t('test'))),
        testOut ? previewTable(testOut) : null) : null,
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' }, h('b', {}, t('columns')), h('div', { class: 'grow' }), h('span', { class: 'muted small' }, t('columnsHint'))),
        rep.columns.length
          ? h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
              h('thead', {}, h('tr', {}, [...(isAdmin ? [t('code'), t('srcName')] : []), 'AZ', 'EN', 'RU', t('type'), t('sensitivity')].map((x) => h('th', {}, x)))),
              h('tbody', {}, rep.columns.map(columnRow))))
          : h('div', { class: 'note' }, t('noColumns'))),
      drillCard(),
      rep.versions?.length ? h('div', { class: 'card pad' },
        h('b', {}, t('versions')),
        h('div', { class: 'col gap6 mt8' }, rep.versions.map((v) => h('div', { class: 'small' },
          `v${v.version} · ${v.changed_name || v.changed_by || ''} · ${new Date(v.changed_at).toLocaleString()}`)))) : null
    );
  }

  try {
    await loadList();
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
    return;
  }
  drawEditor();
}
