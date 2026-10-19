import test from 'node:test';
import assert from 'node:assert/strict';
import { baseFromDomain, bindName, samName, adUrl } from '../server/ldap.js';

test('AD: domendən Base DN', () => {
  assert.equal(baseFromDomain('company.local'), 'DC=company,DC=local');
  assert.equal(baseFromDomain('COMPANY'), '');
});
test('AD: giriş adı formaları', () => {
  assert.equal(bindName({ domain: 'company.local' }, 'agil'), 'agil@company.local');
  assert.equal(bindName({ domain: 'COMPANY' }, 'agil'), 'COMPANY\\agil');
  assert.equal(bindName({ domain: 'company.local' }, 'COMPANY\\agil'), 'COMPANY\\agil');
  assert.equal(samName('COMPANY\\agil'), 'agil');
  assert.equal(samName('agil@company.local'), 'agil');
  assert.equal(samName('agil'), 'agil');
});
test('AD: ünvan', () => {
  assert.equal(adUrl({ host: 'dc01', ssl: true }), 'ldaps://dc01:636');
  assert.equal(adUrl({ host: 'dc01', ssl: false, port: 389 }), 'ldap://dc01:389');
});
test('AD: parol boşdursa girişsiz rədd', async () => {
  const { adSignIn } = await import('../server/ldap.js');
  assert.equal(await adSignIn({ host: 'x', domain: 'a.b' }, 'agil', ''), null);
});
