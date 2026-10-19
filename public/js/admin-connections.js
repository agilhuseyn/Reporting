import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';

const SQL_DEFAULT = { type: 'mssql', host: '', port: 1433, database: '', user: '', encrypt: true, trustServerCertificate: false, ssl: false };
const LDAP_DEFAULT = { url: 'ldaps://', baseDn: '', bindDn: '', userFilter: '(sAMAccountName={login})', empidAttr: '', startTls: false, tlsReject: true };

export async function adminConnections(root) {
  const main = h('main', { class: 'content col gap16' });
  clear(root, main);

  let data;
  try {
    data = await api('/api/admin/connections');
  } catch (e) {
    clear(main, h('div', { class: 'err' }, e.message));
    return;
  }

  const state = {
    sql: { config: { ...SQL_DEFAULT, ...(data.sql?.config || {}) }, password: '', enabled: !!data.sql?.enabled, hasPassword: !!data.sql?.hasPassword, saved: !!data.sql },
    ldap: { config: { ...LDAP_DEFAULT, ...(data.ldap?.config || {}) }, password: '', enabled: !!data.ldap?.enabled, hasPassword: !!data.ldap?.hasPassword, saved: !!data.ldap, testLogin: '', testPassword: '' },
  };
  const out = { sql: null, ldap: null };

  const txt = (kind, key, o = {}) => h('input', {
    class: 'inp', value: state[kind].config[key] ?? '', type: o.type || 'text', placeholder: o.placeholder || '',
    autocomplete: 'off', oninput: (e) => { state[kind].config[key] = o.number ? Number(e.target.value) : e.target.value; },
  });
  const chk = (kind, key, label) => h('label', { class: 'row gap8' },
    h('input', { type: 'checkbox', checked: !!state[kind].config[key], onchange: (e) => { state[kind].config[key] = e.target.checked; } }), label);
  const field = (title, input, wide) => h('label', { class: 'fld', style: wide ? 'flex:1;min-width:260px' : '' }, title, input);
  const secret = (kind, title) => field(title, h('input', {
    class: 'inp', type: 'password', autocomplete: 'new-password', value: state[kind].password,
    placeholder: state[kind].hasPassword ? t('conn.passwordSaved') : '',
    oninput: (e) => { state[kind].password = e.target.value; },
  }));

  const body = (kind) => ({ config: state[kind].config, password: state[kind].password, enabled: state[kind].enabled,
    testLogin: state[kind].testLogin, testPassword: state[kind].testPassword });

  async function test(kind) {
    out[kind] = { busy: true };
    draw();
    try {
      out[kind] = await api(`/api/admin/connections/${kind}/test`, { method: 'POST', body: body(kind) });
    } catch (e) {
      out[kind] = { ok: false, error: e.message };
    }
    draw();
  }

  async function save(kind) {
    try {
      const r = await api(`/api/admin/connections/${kind}`, { method: 'PUT', body: body(kind) });
      toast(t('conn.saved'));
      if (r.warnings?.length) toast(t('conn.warnWrite'), 'err');
      main.replaceChildren();
      await adminConnections(root);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function reset(kind) {
    if (!confirm(t('conn.confirmReset'))) return;
    try {
      await api(`/api/admin/connections/${kind}`, { method: 'DELETE' });
      await adminConnections(root);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function result(kind) {
    const r = out[kind];
    if (!r) return null;
    if (r.busy) return h('div', { class: 'note' }, '...');
    const rows = [h('div', { class: r.ok ? 'ok-text' : 'err-text' }, r.ok ? t('conn.testOk') : t('conn.testFail'))];
    if (r.error) rows.push(h('div', { class: 'err' }, r.error));
    if (r.info) rows.push(h('div', { class: 'small mono' }, `${r.info} · ${(r.ms / 1000).toFixed(2)} s`));
    if (r.warnings?.length) rows.push(h('div', { class: 'err' }, `${t('conn.warnWrite')} (${r.warnings.join(', ')})`));
    for (const s of r.steps || []) {
      rows.push(h('div', { class: 'small' }, `${s.ok ? '✓' : '✗'} ${t(`step.${s.step}`)}${s.detail ? ' · ' + s.detail : ''}${s.error ? ' · ' + s.error : ''}`));
    }
    return h('div', { class: 'col gap6' }, rows);
  }

  const actions = (kind) => h('div', { class: 'row wrap gap10' },
    h('label', { class: 'row gap8' }, h('input', { type: 'checkbox', checked: state[kind].enabled, onchange: (e) => { state[kind].enabled = e.target.checked; } }), t('conn.enable')),
    h('div', { class: 'grow' }),
    state[kind].saved ? h('button', { class: 'btn', onclick: () => reset(kind) }, t('conn.reset')) : null,
    h('button', { class: 'btn', onclick: () => test(kind) }, t('conn.test')),
    h('button', { class: 'btn primary', onclick: () => save(kind) }, t('save')));

  function sqlCard() {
    const c = state.sql.config;
    return h('div', { class: 'card pad col gap12' },
      h('div', { class: 'row wrap gap10' }, h('h1', {}, t('conn.sqlTitle')), h('div', { class: 'grow' }),
        h('span', { class: 'tag' }, data.sql?.enabled ? t('conn.external') : t('conn.builtin'))),
      h('div', { class: 'note' }, t('conn.sqlHelp')),
      h('div', { class: 'row wrap gap12 end' },
        field(t('conn.dbType'), h('select', { class: 'inp', onchange: (e) => {
          c.type = e.target.value;
          c.port = c.type === 'mssql' ? 1433 : 5432;
          draw();
        } }, h('option', { value: 'mssql', selected: c.type === 'mssql' }, 'Microsoft SQL Server'),
        h('option', { value: 'postgres', selected: c.type === 'postgres' }, 'PostgreSQL'))),
        field(t('conn.host'), txt('sql', 'host', { placeholder: 'sql01.company.local' }), true),
        field(t('conn.port'), txt('sql', 'port', { type: 'number', number: true }))),
      h('div', { class: 'row wrap gap12 end' },
        field(t('conn.database'), txt('sql', 'database'), true),
        field(t('conn.user'), txt('sql', 'user'), true),
        secret('sql', t('conn.password'))),
      h('div', { class: 'row wrap gap16' },
        c.type === 'mssql' ? chk('sql', 'encrypt', t('conn.encrypt')) : null,
        c.type === 'mssql' ? chk('sql', 'trustServerCertificate', t('conn.trustCert')) : null,
        c.type === 'postgres' ? chk('sql', 'ssl', t('conn.ssl')) : null),
      actions('sql'), result('sql'));
  }

  function ldapCard() {
    return h('div', { class: 'card pad col gap12' },
      h('div', { class: 'row wrap gap10' }, h('h1', {}, t('conn.ldapTitle')), h('div', { class: 'grow' }),
        h('span', { class: 'tag' }, data.ldap?.enabled ? t('conn.ldapOn') : t('conn.ldapOff'))),
      h('div', { class: 'note' }, t('conn.ldapHelp')),
      h('div', { class: 'row wrap gap12 end' },
        field(t('conn.url'), txt('ldap', 'url', { placeholder: 'ldaps://dc01.company.local:636' }), true),
        field(t('conn.baseDn'), txt('ldap', 'baseDn', { placeholder: 'DC=company,DC=local' }), true)),
      h('div', { class: 'row wrap gap12 end' },
        field(t('conn.bindDn'), txt('ldap', 'bindDn', { placeholder: 'CN=svc_reports,OU=Service,DC=company,DC=local' }), true),
        secret('ldap', t('conn.password'))),
      h('div', { class: 'row wrap gap12 end' },
        field(t('conn.userFilter'), txt('ldap', 'userFilter'), true),
        field(t('conn.empidAttr'), txt('ldap', 'empidAttr', { placeholder: 'employeeID' }), true)),
      h('div', { class: 'row wrap gap16' }, chk('ldap', 'startTls', t('conn.startTls')), chk('ldap', 'tlsReject', t('conn.tlsReject'))),
      h('div', { class: 'row wrap gap12 end' },
        field(t('conn.testLogin'), h('input', { class: 'inp', autocomplete: 'off', value: state.ldap.testLogin, oninput: (e) => { state.ldap.testLogin = e.target.value; } })),
        field(t('conn.testPassword'), h('input', { class: 'inp', type: 'password', autocomplete: 'new-password', value: state.ldap.testPassword, oninput: (e) => { state.ldap.testPassword = e.target.value; } }))),
      actions('ldap'), result('ldap'));
  }

  function draw() {
    clear(main, sqlCard(), ldapCard());
  }
  draw();
}
