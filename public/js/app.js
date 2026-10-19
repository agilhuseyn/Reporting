import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { t, lang, setLang, LANGS } from './i18n.js';
import { userPage } from './user.js';
import { adminReports } from './admin-reports.js';
import { adminPerms } from './admin-perms.js';
import { adminUsers } from './admin-users.js';
import { adminAudit } from './admin-audit.js';

const root = document.getElementById('app');
let me = null;

const ADMIN_PAGES = [
  { key: 'reports', cap: ['reports', 'permissions'], run: adminReports },
  { key: 'permissions', cap: ['permissions'], run: adminPerms },
  { key: 'users', cap: ['users'], run: adminUsers },
  { key: 'audit', cap: ['audit'], run: adminAudit },
];

function langSwitch() {
  return h('div', { class: 'langs' }, LANGS.map((l) => h('button', { class: lang() === l ? 'on' : '', onclick: () => setLang(l) }, l.toUpperCase())));
}

function loginView() {
  const empid = h('input', { class: 'inp', name: 'empid', autocomplete: 'username', 'aria-label': t('empid'), required: true });
  const pw = h('input', { class: 'inp', name: 'password', type: 'password', autocomplete: 'current-password', 'aria-label': t('password'), required: true });
  const err = h('div', { class: 'err', hidden: true });
  const form = h('form', { class: 'card pad col gap12 login', onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      me = await api('/api/auth/login', { method: 'POST', body: { empid: empid.value.trim(), password: pw.value } });
      location.hash = '';
      render();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  } },
  h('div', { class: 'brand big' }, h('span', { class: 'logo' }, 'HP'), t('appName')),
  h('div', { class: 'muted' }, t('loginHint')),
  h('label', { class: 'fld' }, t('empid'), empid),
  h('label', { class: 'fld' }, t('password'), pw),
  err,
  h('button', { class: 'btn primary', type: 'submit' }, t('login')));
  return h('div', { class: 'login-wrap' }, h('div', { class: 'login-lang' }, langSwitch()), form);
}

function allowedAdmin() {
  return ADMIN_PAGES.filter((p) => p.cap.some((c) => me.caps.includes(c)));
}

async function render() {
  document.documentElement.lang = lang();
  if (!me) {
    clear(root, loginView());
    return;
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const inAdmin = parts[0] === 'admin';
  const adminPages = allowedAdmin();
  const page = inAdmin ? adminPages.find((p) => p.key === parts[1]) || adminPages[0] : null;

  const header = h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'HP'), t('appName')),
    h('nav', { class: 'tabs' },
      h('a', { href: '#/reports', class: !inAdmin ? 'on' : '' }, t('navUser')),
      adminPages.length ? h('a', { href: `#/admin/${adminPages[0].key}`, class: inAdmin ? 'on' : '' }, t('navAdmin')) : null),
    h('div', { class: 'grow' }),
    langSwitch(),
    h('div', { class: 'me' }, h('div', { class: 'avatar' }, me.name.split(' ').map((x) => x[0]).slice(0, 2).join('')),
      h('div', { class: 'who' }, h('b', {}, me.name), h('span', {}, `EMPID ${me.empid}`))),
    h('button', { class: 'btn ghost', onclick: async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      me = null;
      render();
    } }, t('logout')));

  const sub = inAdmin && page
    ? h('nav', { class: 'subnav' }, adminPages.map((p) => h('a', { href: `#/admin/${p.key}`, class: p.key === page.key ? 'on' : '' }, t(`nav.${p.key}`))))
    : null;

  const body = h('div', { class: 'page' });
  clear(root, header, sub, body);
  try {
    if (inAdmin && page) await page.run(body, me);
    else await userPage(body, parts[0] === 'reports' ? parts[1] : null);
  } catch (e) {
    clear(body, h('div', { class: 'err' }, e.message));
    toast(e.message, 'err');
  }
}

async function boot() {
  try {
    me = await api('/api/me');
  } catch {
    me = null;
  }
  render();
}

window.addEventListener('hashchange', render);
window.addEventListener('langchange', render);
window.addEventListener('unauth', () => {
  me = null;
  render();
});
boot();
