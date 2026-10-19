import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';

const CAPS = ['reports', 'permissions', 'users', 'audit'];

export async function adminUsers(root, me) {
  const isAdmin = me.role === 'admin';
  const main = h('main', { class: 'content col gap16 wide' });
  clear(root, h('div', { class: 'single' }, main));

  let tab = 'users';
  let users = [];
  let positions = [];
  let groups = [];
  let edit = null; // redaktə olunan istifadəçi (kopya) və ya {isNew:true}

  async function load() {
    const [u, s] = await Promise.all([api('/api/admin/users'), api('/api/admin/subjects')]);
    users = u;
    positions = s.positions;
    groups = s.groups;
  }

  const posName = (id) => positions.find((p) => p.id === id)?.name || '—';

  function editor() {
    const u = edit;
    const inp = (key, type = 'text') => h('input', { class: 'inp', type, value: u[key] ?? '', readOnly: key === 'empid' && !u.isNew,
      oninput: (e) => { u[key] = e.target.value; } });
    return h('div', { class: 'card pad col gap12' },
      h('div', { class: 'row gap10' }, h('h1', {}, u.isNew ? t('newUser') : u.name), h('div', { class: 'grow' }),
        h('button', { class: 'btn', onclick: () => { edit = null; draw(); } }, t('cancel')),
        h('button', { class: 'btn primary', onclick: saveUser }, t('save'))),
      h('div', { class: 'grid3' },
        h('label', { class: 'fld' }, 'EMPID', inp('empid')),
        h('label', { class: 'fld' }, t('name'), inp('name')),
        h('label', { class: 'fld' }, u.isNew ? t('password') : t('newPassword'), inp('password', 'password'))),
      h('div', { class: 'row wrap gap16 end' },
        h('label', { class: 'fld' }, t('position'), h('select', { class: 'inp', onchange: (e) => { u.position_id = e.target.value || null; } },
          h('option', { value: '' }, '—'), positions.map((p) => h('option', { value: p.id, selected: p.id === u.position_id }, p.name)))),
        isAdmin ? h('label', { class: 'fld' }, t('role'), h('select', { class: 'inp', onchange: (e) => { u.role = e.target.value; draw(); } },
          ['user', 'support', 'admin'].map((r) => h('option', { value: r, selected: r === u.role }, t(`role.${r}`))))) : null,
        u.isNew ? null : h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: u.active, onchange: (e) => { u.active = e.target.checked; } }), t('active'))),
      h('div', {}, h('div', { class: 'lbl' }, t('groups')),
        h('div', { class: 'row wrap gap12' }, groups.length ? groups.map((g) => h('label', { class: 'row gap6' },
          h('input', { type: 'checkbox', checked: (u.groups || []).includes(g.id), onchange: (e) => {
            u.groups = (u.groups || []).filter((x) => x !== g.id);
            if (e.target.checked) u.groups.push(g.id);
          } }), g.name)) : h('span', { class: 'muted small' }, t('noGroups')))),
      isAdmin && u.role === 'support' ? h('div', {}, h('div', { class: 'lbl' }, t('supportCaps')),
        h('div', { class: 'row wrap gap16' }, CAPS.map((c) => h('label', { class: 'row gap6' },
          h('input', { type: 'checkbox', checked: (u.caps || []).includes(c), onchange: (e) => {
            u.caps = (u.caps || []).filter((x) => x !== c);
            if (e.target.checked) u.caps.push(c);
          } }), t(`cap.${c}`)))),
        h('div', { class: 'note' }, t('capsHint'))) : null);
  }

  async function saveUser() {
    try {
      const body = { ...edit };
      delete body.isNew;
      if (!body.password) delete body.password;
      if (edit.isNew) await api('/api/admin/users', { method: 'POST', body });
      else await api(`/api/admin/users/${encodeURIComponent(edit.id)}`, { method: 'PUT', body });
      toast(t('saved'));
      edit = null;
      await load();
      draw();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function usersTab() {
    return h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('b', {}, t('users')), h('div', { class: 'grow' }),
        h('button', { class: 'btn primary sm', onclick: () => { edit = { isNew: true, empid: '', name: '', password: '', role: 'user', caps: [], position_id: null, groups: [], active: true }; draw(); } }, `+ ${t('new')}`)),
      h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['EMPID', t('name'), t('position'), t('role'), t('supportCaps'), t('status'), ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', { class: 'mono' }, u.empid), h('td', {}, u.name), h('td', {}, posName(u.position_id)),
          h('td', {}, h('span', { class: `tag ${u.role}` }, t(`role.${u.role}`))),
          h('td', { class: 'small' }, u.role === 'support' ? u.caps.map((c) => t(`cap.${c}`)).join(', ') : u.role === 'admin' ? t('allCaps') : ''),
          h('td', {}, u.active ? t('active') : t('inactive'),
            u.blocked_at ? h('div', { class: 'blocked-tag', title: u.blocked_reason || '' }, `${t('blocked')} · ${new Date(u.blocked_at).toLocaleString()}`) : null,
            u.blocked_at && u.blocked_reason ? h('div', { class: 'small muted' }, u.blocked_reason) : null),
          h('td', { class: 'row gap6' },
            u.blocked_at && isAdmin ? h('button', { class: 'btn sm primary', onclick: () => unblock(u) }, t('unblock')) : null,
            h('button', { class: 'btn sm', disabled: !isAdmin && u.role !== 'user', onclick: () => { edit = { ...u, password: '' }; draw(); } }, t('edit')))))))));
  }

  // Avtomatik blokdan yalnız admin çıxarır
  async function unblock(u) {
    if (!confirm(`${t('unblockConfirm')}: ${u.name} (${u.empid})`)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.id)}/unblock`, { method: 'POST', body: {} });
      toast(t('unblocked'));
      await load();
      draw();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function posTab() {
    const name = h('input', { class: 'inp', placeholder: t('name'), 'aria-label': t('name') });
    const parent = h('select', { class: 'inp', 'aria-label': t('parentPosition') }, h('option', { value: '' }, `— ${t('noParent')}`),
      positions.map((p) => h('option', { value: p.id }, p.name)));
    return h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('b', {}, t('positions')), h('div', { class: 'grow' }), h('span', { class: 'muted small' }, t('positionHint'))),
      h('div', { class: 'pad row wrap gap10' }, name, parent, h('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return;
        try {
          await api('/api/admin/positions', { method: 'POST', body: { name: name.value.trim(), parent_id: parent.value || null } });
          await load();
          draw();
        } catch (e) { toast(e.message, 'err'); }
      } }, `+ ${t('add')}`)),
      h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, [t('name'), t('parentPosition'), t('members'), ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, positions.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, posName(p.parent_id)), h('td', {}, p.members),
          h('td', {}, h('button', { class: 'btn sm', onclick: async () => {
            if (!confirm(t('confirmDelete'))) return;
            await api(`/api/admin/positions/${p.id}`, { method: 'DELETE' });
            await load();
            draw();
          } }, t('delete')))))))));
  }

  function groupsTab() {
    const name = h('input', { class: 'inp', placeholder: t('name'), 'aria-label': t('name') });
    return h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('b', {}, t('groups'))),
      h('div', { class: 'pad row wrap gap10' }, name, h('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return;
        try {
          await api('/api/admin/groups', { method: 'POST', body: { name: name.value.trim() } });
          await load();
          draw();
        } catch (e) { toast(e.message, 'err'); }
      } }, `+ ${t('add')}`)),
      h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, [t('name'), t('members'), ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, groups.map((g) => h('tr', {}, h('td', {}, g.name), h('td', {}, g.members),
          h('td', {}, h('button', { class: 'btn sm', onclick: async () => {
            if (!confirm(t('confirmDelete'))) return;
            await api(`/api/admin/groups/${g.id}`, { method: 'DELETE' });
            await load();
            draw();
          } }, t('delete')))))))));
  }

  function draw() {
    clear(
      main,
      h('div', { class: 'seg' }, ['users', 'positions', 'groups'].map((k) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; edit = null; draw(); } }, t(`tab.${k}`)))),
      edit ? editor() : tab === 'users' ? usersTab() : tab === 'positions' ? posTab() : groupsTab()
    );
  }

  try {
    await load();
    draw();
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
  }
}
