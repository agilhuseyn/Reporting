import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { t, label } from './i18n.js';

const OPS = ['in', 'eq', 'gte', 'lte'];

export async function adminPerms(root) {
  const side = h('aside', { class: 'side' });
  const main = h('main', { class: 'content col gap16' });
  clear(root, h('div', { class: 'layout' }, side, main));

  let subjects;
  let reports;
  try {
    [subjects, reports] = await Promise.all([api('/api/admin/subjects'), api('/api/admin/reports')]);
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
    return;
  }

  let tab = 'position';
  let subject = null; // {type,id,name}
  let overview = new Map();
  let repId = null;
  let cfg = null; // {granted, canExport, columns:{code:mode}, rules:[]}
  let repCols = [];
  let effOut = null;
  let effUser = subjects.users.find((u) => u.role === 'user')?.id || '';

  function subjectList() {
    if (tab === 'position') {
      const out = [];
      const walk = (parent, level) => {
        for (const p of subjects.positions.filter((x) => (x.parent_id ?? null) === parent)) {
          out.push({ type: 'position', id: String(p.id), name: p.name, level, sub: `${p.members}` });
          walk(p.id, level + 1);
        }
      };
      walk(null, 0);
      return out;
    }
    if (tab === 'group') return subjects.groups.map((g) => ({ type: 'group', id: String(g.id), name: g.name, level: 0, sub: `${g.members}` }));
    return subjects.users.filter((u) => u.active).map((u) => ({ type: 'user', id: u.id, name: u.name, level: 0, sub: u.empid }));
  }

  function drawSide() {
    clear(
      side,
      h('div', { class: 'pad' }, h('b', {}, t('permWho'))),
      h('div', { class: 'pad tabs4' }, ['position', 'group', 'user'].map((k) => h('button', { class: `btn sm ${tab === k ? 'on' : ''}`,
        onclick: () => { tab = k; subject = null; cfg = null; repId = null; drawSide(); drawMain(); } }, t(`subj.${k}`)))),
      subjectList().map((s) => h('a', { href: '#/admin/permissions', class: `item ${subject?.type === s.type && subject?.id === s.id ? 'on' : ''}`,
        style: { paddingLeft: `${14 + s.level * 16}px` },
        onclick: (e) => { e.preventDefault(); pick(s); } }, h('span', {}, s.name), h('span', { class: 'muted small' }, s.sub))),
      h('div', { class: 'note foot' }, t('permInherit'))
    );
  }

  async function pick(s) {
    subject = s;
    repId = null;
    cfg = null;
    const ov = await api(`/api/admin/permissions/overview?subjectType=${s.type}&subjectId=${encodeURIComponent(s.id)}`);
    overview = new Map(ov.map((o) => [o.report_id, o]));
    drawSide();
    drawMain();
  }

  async function openRep(id) {
    repId = id;
    const [p, r] = await Promise.all([
      api(`/api/admin/permissions?subjectType=${subject.type}&subjectId=${encodeURIComponent(subject.id)}&reportId=${id}`),
      api(`/api/admin/reports/${id}`),
    ]);
    cfg = p;
    repCols = r.columns;
    drawMain();
  }

  async function save() {
    try {
      await api('/api/admin/permissions', { method: 'PUT', body: { subjectType: subject.type, subjectId: subject.id, reportId: repId, ...cfg } });
      if (cfg.granted) overview.set(repId, { report_id: repId, can_export: cfg.canExport });
      else overview.delete(repId);
      toast(t('saved'));
      drawMain();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function modeCell(code, mode) {
    const cur = cfg.columns[code] || 'none';
    return h('td', { class: 'c' }, h('input', { type: 'radio', name: `m_${code}`, checked: cur === mode, 'aria-label': t(`mode.${mode}`),
      onchange: () => {
        if (mode === 'none') delete cfg.columns[code];
        else cfg.columns[code] = mode;
      } }));
  }

  function rulesTable() {
    const colSel = (r) => h('select', { class: 'inp sm', onchange: (e) => { r.column = e.target.value; } },
      repCols.map((c) => h('option', { value: c.code, selected: c.code === r.column }, c.code)));
    const opSel = (r) => h('select', { class: 'inp sm', onchange: (e) => { r.op = e.target.value; } },
      OPS.map((o) => h('option', { value: o, selected: o === r.op }, t(`op.${o}`))));
    const valText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
    return h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, [t('column'), t('condition'), t('value'), ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, cfg.rules.map((r, i) => h('tr', {},
        h('td', {}, colSel(r)), h('td', {}, opSel(r)),
        h('td', {}, h('input', { class: 'inp sm', value: valText(r.value), placeholder: 'Bakı, Sumqayıt  |  $me  |  $ym-12',
          oninput: (e) => {
            const raw = e.target.value;
            r.value = r.op === 'in' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw.trim();
          } })),
        h('td', {}, h('button', { class: 'btn sm', 'aria-label': t('remove'), onclick: () => { cfg.rules.splice(i, 1); drawMain(); } }, '×')))))));
  }

  async function runEffective() {
    if (!repId || !effUser) return;
    try {
      effOut = await api(`/api/admin/effective?userId=${encodeURIComponent(effUser)}&reportId=${repId}`);
    } catch (e) {
      toast(e.message, 'err');
    }
    drawMain();
  }

  function effPanel() {
    return h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('b', {}, t('effective')), h('div', { class: 'grow' }),
        h('select', { class: 'inp sm', 'aria-label': t('user'), onchange: (e) => { effUser = e.target.value; effOut = null; } },
          subjects.users.filter((u) => u.active).map((u) => h('option', { value: u.id, selected: u.id === effUser }, `${u.name} · ${u.empid}`))),
        h('button', { class: 'btn sm', onclick: runEffective }, t('check'))),
      effOut ? h('div', { class: 'pad col gap8' },
        h('div', { class: effOut.allowed ? 'ok-text' : 'err-text' }, effOut.allowed ? t('reportAllowed') : t('reportDenied')),
        effOut.columns.map((c) => {
          const conflict = c.result === 'hide' && c.sources.some((s) => s.mode === 'show' || s.mode === 'mask');
          return h('div', { class: 'row gap8 top' },
            h('span', { class: `pill ${c.result}` }, t(`mode.${c.result}`)),
            h('span', {}, h('span', { class: 'mono' }, c.code), ' ',
              h('span', { class: 'muted small' }, c.sources.length ? c.sources.map((s) => `${s.from}: ${t(`mode.${s.mode}`)}`).join(' · ') : t('noGrant')),
              conflict ? h('div', { class: 'warn-text small' }, t('denyWins')) : null));
        }),
        effOut.rules.length ? h('div', { class: 'col gap6' }, h('b', { class: 'small' }, t('valueRules')),
          effOut.rules.map((r) => h('div', { class: 'small' }, `${r.column} ${t(`op.${r.op}`)} ${Array.isArray(r.value) ? r.value.join(', ') : r.value} (${r.from})`))) : null) : h('div', { class: 'note' }, t('effectiveHint')));
  }

  function drawMain() {
    if (!subject) {
      clear(main, h('div', { class: 'empty' }, t('pickSubject')));
      return;
    }
    const repList = h('div', { class: 'card pad col gap10' },
      h('div', { class: 'row gap10' }, h('h1', {}, subject.name), h('span', { class: 'tag' }, t(`subj.${subject.type}`))),
      h('div', { class: 'warnbox' }, t('denyRule')),
      h('div', { class: 'lbl' }, `1 · ${t('reportAccess')}`),
      h('div', { class: 'row wrap gap8' }, reports.map((r) => h('button', { class: `rbtn ${r.id === repId ? 'on' : ''} ${overview.has(r.id) ? 'has' : ''}`,
        onclick: () => openRep(r.id) }, label(r, 'name'), overview.has(r.id) ? ' ✓' : ''))));
    if (!cfg) {
      clear(main, repList, h('div', { class: 'note' }, t('pickReportForPerm')));
      return;
    }
    clear(
      main,
      repList,
      h('div', { class: 'card pad row wrap gap16' },
        h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: cfg.granted, onchange: (e) => { cfg.granted = e.target.checked; } }), h('b', {}, t('grantReport'))),
        h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: cfg.canExport, onchange: (e) => { cfg.canExport = e.target.checked; } }), t('canExport')),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary', onclick: save }, t('save'))),
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' }, h('b', {}, `2 · ${t('columnAccess')}`), h('div', { class: 'grow' }), h('span', { class: 'muted small' }, t('columnHint'))),
        h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, t('code')), h('th', {}, t('name')),
            ['none', 'show', 'mask', 'hide'].map((m) => h('th', { class: 'c' }, t(`mode.${m}`))))),
          h('tbody', {}, repCols.map((c) => h('tr', {}, h('td', { class: 'mono' }, c.code), h('td', {}, label(c, 'label')),
            ['none', 'show', 'mask', 'hide'].map((m) => modeCell(c.code, m)))))))),
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' }, h('b', {}, `3 · ${t('valueAccess')}`), h('div', { class: 'grow' }), h('span', { class: 'muted small' }, t('valueHint'))),
        cfg.rules.length ? rulesTable() : h('div', { class: 'note' }, t('noRules')),
        h('div', { class: 'foot' }, h('button', { class: 'btn sm', onclick: () => {
          cfg.rules.push({ column: repCols[0]?.code, op: 'in', value: [] });
          drawMain();
        } }, `+ ${t('addRule')}`))),
      effPanel()
    );
  }

  drawSide();
  drawMain();
}
