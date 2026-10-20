import { h, clear } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';

export async function adminAudit(root) {
  const main = h('main', { class: 'content col gap16 wide fit' });
  clear(root, h('div', { class: 'single' }, main));
  let rows = [];
  let q = '';
  try {
    rows = await api('/api/admin/audit?limit=500');
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
    return;
  }
  const body = h('tbody');
  function draw() {
    const f = q.toLowerCase();
    clear(
      body,
      rows
        .filter((r) => !f || `${r.empid} ${r.name} ${r.action} ${JSON.stringify(r.detail)}`.toLowerCase().includes(f))
        .map((r) => h('tr', { class: String(r.action).startsWith('security.') ? 'secrow' : '' },
          h('td', {}, new Date(r.at).toLocaleString()),
          h('td', {}, `${r.name || ''} ${r.empid || ''}`),
          h('td', { class: 'mono' }, r.action),
          h('td', { class: 'small' }, JSON.stringify(r.detail))))
    );
  }
  draw();
  clear(
    main,
    h('h1', {}, t('audit')),
    h('div', { class: 'card fill' },
      h('div', { class: 'toolbar' }, h('input', { class: 'inp', placeholder: t('searchTable'), 'aria-label': t('searchTable'), oninput: (e) => { q = e.target.value; draw(); } })),
      h('div', { class: 'xscroll' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, [t('time'), t('user'), t('action'), t('detail')].map((x) => h('th', {}, x)))), body)))
  );
}
