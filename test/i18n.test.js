import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasKey } from '../public/js/i18n.js';

const dir = new URL('../public/js/', import.meta.url).pathname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'i18n.js');

test('kodda istifadə olunan bütün tərcümə açarları i18n.js-də var', () => {
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?<![A-Za-z_])t\('([^']+)'\)/g)) if (!hasKey(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('dinamik açarlar: agg, cap, kind, mode, op, ptype, role, sens, subj, tab', () => {
  const families = {
    agg: ['sum', 'count', 'avg', 'min', 'max'], cap: ['reports', 'permissions', 'users', 'audit'],
    kind: ['query', 'procedure', 'function'], mode: ['none', 'show', 'mask', 'hide'], op: ['in', 'eq', 'gte', 'lte'],
    ptype: ['text', 'number', 'date', 'list'], role: ['admin', 'support', 'user'], sens: ['normal', 'sensitive'],
    subj: ['position', 'group', 'user'], tab: ['users', 'positions', 'groups'], nav: ['reports', 'permissions', 'users', 'audit', 'connections'],
    step: ['connect', 'bind', 'search', 'userBind'],
  };
  const missing = [];
  for (const [fam, list] of Object.entries(families)) for (const k of list) if (!hasKey(`${fam}.${k}`)) missing.push(`${fam}.${k}`);
  assert.deepEqual(missing, []);
});
