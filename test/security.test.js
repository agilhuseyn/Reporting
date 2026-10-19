import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLimiter, makeGate, sameOrigin, securityHeaders } from '../server/security.js';

const run = (mw, req) => new Promise((resolve) => {
  const headers = {};
  mw(req, { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } }, (e) => resolve({ err: e, headers }));
});

test('limiter: limitdən sonra bloklayır', () => {
  const l = makeLimiter({ windowMs: 1000, max: 3 });
  assert.deepEqual([1, 2, 3, 4].map(() => l.hit('a')), [false, false, false, true]);
  assert.equal(l.hit('b'), false);
});

test('gate: paralel limit və növbə', async () => {
  const g = makeGate({ max: 2, maxQueue: 1, waitMs: 500 });
  let active = 0; let peak = 0;
  const job = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return 1; };
  const res = await Promise.allSettled([g.run(job), g.run(job), g.run(job), g.run(job)]);
  assert.equal(peak, 2);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(res.filter((r) => r.status === 'rejected')[0].reason.status, 503);
});

test('CSRF: yad mənbə rədd, eyni mənbə keçir, GET sərbəst', async () => {
  const base = { method: 'POST', headers: { host: 'portal.example' } };
  assert.equal((await run(sameOrigin, { ...base, headers: { ...base.headers, origin: 'https://portal.example' } })).err, undefined);
  assert.equal((await run(sameOrigin, { ...base, headers: { ...base.headers, origin: 'https://evil.example' } })).err.status, 403);
  assert.equal((await run(sameOrigin, { ...base, headers: { ...base.headers, origin: 'null' } })).err.status, 403);
  assert.equal((await run(sameOrigin, { ...base, headers: { ...base.headers, 'sec-fetch-site': 'cross-site' } })).err.status, 403);
  assert.equal((await run(sameOrigin, { method: 'GET', headers: { host: 'x', origin: 'https://evil.example' } })).err, undefined);
});

test('başlıqlar: CSP inline script icazə vermir', async () => {
  const { headers } = await run(securityHeaders, { url: '/api/me', headers: {} });
  assert.match(headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(headers['content-security-policy'], /script-src[^;]*unsafe/);
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['cache-control'], 'no-store');
});
