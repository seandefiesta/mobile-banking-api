import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const silent = { info() {}, error() {} };
let server, base, db;

before(async () => {
  db = openDb(':memory:');
  server = http.createServer(createApp({
    db, jwtSecret: 'test-secret', jwtTtlSeconds: 60,
    rateLimit: { max: 1000, windowMs: 60_000 }, logger: silent,
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); db.close(); });

async function call(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

let counter = 0;
async function newCustomer(prefix = 'user') {
  const email = `${prefix}${++counter}@example.com`;
  const reg = await call('POST', '/api/auth/register', { body: { name: 'Test User', email, password: 'Secret123' } });
  const login = await call('POST', '/api/auth/login', { body: { email, password: 'Secret123' } });
  return { email, token: login.json.accessToken, account: reg.json.account };
}

test('health check', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
});

test('register creates a user and a starter checking account', async () => {
  const r = await call('POST', '/api/auth/register', {
    body: { name: 'Ana Cruz', email: 'Ana@Example.com', password: 'Secret123' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.email, 'ana@example.com');
  assert.equal(r.json.account.type, 'checking');
  assert.equal(r.json.account.balance, 0);
  assert.match(r.json.account.accountNumber, /^\d{10}$/);
  assert.equal(r.json.user.passwordHash, undefined);
});

test('register rejects duplicate emails and weak input', async () => {
  const dup = await call('POST', '/api/auth/register', {
    body: { name: 'Ana Cruz', email: 'ana@example.com', password: 'Secret123' },
  });
  assert.equal(dup.status, 409);

  const bad = await call('POST', '/api/auth/register', { body: { name: 'A', email: 'nope', password: 'short' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.details.email && bad.json.error.details.password && bad.json.error.details.name);
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  const { email } = await newCustomer('login');
  const bad = await call('POST', '/api/auth/login', { body: { email, password: 'WrongPass1' } });
  assert.equal(bad.status, 401);
  const unknown = await call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'WrongPass1' } });
  assert.equal(unknown.status, 401);
  assert.equal(bad.json.error.message, unknown.json.error.message);
});

test('protected routes require a valid token', async () => {
  assert.equal((await call('GET', '/api/accounts')).status, 401);
  assert.equal((await call('GET', '/api/accounts', { token: 'garbage' })).status, 401);
  const { token } = await newCustomer();
  const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await call('GET', '/api/me', { token: tampered })).status, 401);
  assert.equal((await call('GET', '/api/me', { token })).status, 200);
});

test('deposit and withdraw update balance and ledger', async () => {
  const { token, account } = await newCustomer();
  const dep = await call('POST', `/api/accounts/${account.id}/deposits`, { token, body: { amount: 100.5, description: 'Paycheck' } });
  assert.equal(dep.status, 201);
  assert.equal(dep.json.account.balance, 100.5);

  const wd = await call('POST', `/api/accounts/${account.id}/withdrawals`, { token, body: { amount: 40.25 } });
  assert.equal(wd.json.account.balance, 60.25);

  const over = await call('POST', `/api/accounts/${account.id}/withdrawals`, { token, body: { amount: 1000 } });
  assert.equal(over.status, 422);
  assert.equal(over.json.error.code, 'insufficient_funds');

  const history = await call('GET', `/api/accounts/${account.id}/transactions`, { token });
  assert.equal(history.json.pagination.total, 2);
  assert.equal(history.json.data[0].type, 'withdrawal'); // newest first
});

test('amount validation rejects bad values', async () => {
  const { token, account } = await newCustomer();
  for (const amount of [0, -5, 1.234, '10', null, 2_000_000]) {
    const r = await call('POST', `/api/accounts/${account.id}/deposits`, { token, body: { amount } });
    assert.equal(r.status, 422, `amount ${amount} should be rejected`);
  }
  // 0.1 + 0.2 style floats must not break cent handling
  const ok = await call('POST', `/api/accounts/${account.id}/deposits`, { token, body: { amount: 0.3 } });
  assert.equal(ok.json.account.balance, 0.3);
});

test('transfer moves money and writes both sides of the ledger', async () => {
  const alice = await newCustomer('alice');
  const bob = await newCustomer('bob');
  await call('POST', `/api/accounts/${alice.account.id}/deposits`, { token: alice.token, body: { amount: 200 } });

  const t = await call('POST', '/api/transfers', {
    token: alice.token,
    body: { fromAccountId: alice.account.id, toAccountNumber: bob.account.accountNumber, amount: 75.75, description: 'Dinner' },
  });
  assert.equal(t.status, 201);
  assert.equal(t.json.account.balance, 124.25);

  const bobAcc = await call('GET', `/api/accounts/${bob.account.id}`, { token: bob.token });
  assert.equal(bobAcc.json.account.balance, 75.75);

  const bobHistory = await call('GET', `/api/accounts/${bob.account.id}/transactions`, { token: bob.token });
  assert.equal(bobHistory.json.data[0].type, 'transfer_in');
  assert.equal(bobHistory.json.data[0].reference, t.json.reference);
});

test('failed transfers change nothing', async () => {
  const alice = await newCustomer('alice');
  const bob = await newCustomer('bob');
  await call('POST', `/api/accounts/${alice.account.id}/deposits`, { token: alice.token, body: { amount: 50 } });

  const tooMuch = await call('POST', '/api/transfers', {
    token: alice.token,
    body: { fromAccountId: alice.account.id, toAccountNumber: bob.account.accountNumber, amount: 80 },
  });
  assert.equal(tooMuch.status, 422);

  const self = await call('POST', '/api/transfers', {
    token: alice.token,
    body: { fromAccountId: alice.account.id, toAccountNumber: alice.account.accountNumber, amount: 5 },
  });
  assert.equal(self.json.error.code, 'same_account');

  const missing = await call('POST', '/api/transfers', {
    token: alice.token,
    body: { fromAccountId: alice.account.id, toAccountNumber: '0000000000', amount: 5 },
  });
  assert.equal(missing.status, 404);

  const a = await call('GET', `/api/accounts/${alice.account.id}`, { token: alice.token });
  const b = await call('GET', `/api/accounts/${bob.account.id}`, { token: bob.token });
  assert.equal(a.json.account.balance, 50);
  assert.equal(b.json.account.balance, 0);
});

test('users cannot see or touch each other\'s accounts', async () => {
  const alice = await newCustomer('alice');
  const mallory = await newCustomer('mallory');

  for (const [method, path, body] of [
    ['GET', `/api/accounts/${alice.account.id}`],
    ['GET', `/api/accounts/${alice.account.id}/transactions`],
    ['POST', `/api/accounts/${alice.account.id}/deposits`, { amount: 10 }],
    ['POST', `/api/accounts/${alice.account.id}/withdrawals`, { amount: 10 }],
  ]) {
    const r = await call(method, path, { token: mallory.token, body });
    assert.equal(r.status, 404, `${method} ${path}`);
  }

  const steal = await call('POST', '/api/transfers', {
    token: mallory.token,
    body: { fromAccountId: alice.account.id, toAccountNumber: mallory.account.accountNumber, amount: 1 },
  });
  assert.equal(steal.status, 404);
});

test('idempotency key prevents double transfers on retry', async () => {
  const alice = await newCustomer('alice');
  const bob = await newCustomer('bob');
  await call('POST', `/api/accounts/${alice.account.id}/deposits`, { token: alice.token, body: { amount: 100 } });

  const req = {
    token: alice.token,
    headers: { 'Idempotency-Key': 'retry-key-0001' },
    body: { fromAccountId: alice.account.id, toAccountNumber: bob.account.accountNumber, amount: 30 },
  };
  const first = await call('POST', '/api/transfers', req);
  const second = await call('POST', '/api/transfers', req);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.equal(second.json.reference, first.json.reference);

  const a = await call('GET', `/api/accounts/${alice.account.id}`, { token: alice.token });
  assert.equal(a.json.account.balance, 70); // charged once, not twice

  const changed = await call('POST', '/api/transfers', { ...req, body: { ...req.body, amount: 31 } });
  assert.equal(changed.json.error.code, 'idempotency_key_reuse');
});

test('can open additional accounts', async () => {
  const { token } = await newCustomer();
  const r = await call('POST', '/api/accounts', { token, body: { type: 'savings' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.account.type, 'savings');
  const list = await call('GET', '/api/accounts', { token });
  assert.equal(list.json.data.length, 2);
  assert.equal((await call('POST', '/api/accounts', { token, body: { type: 'crypto' } })).status, 422);
});

test('malformed requests get clean errors', async () => {
  const badJson = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(badJson.status, 400);
  const wrongType = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi',
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('DELETE', '/api/accounts')).status, 405);
  const { token } = await newCustomer();
  assert.equal((await call('GET', '/api/accounts/abc', { token })).status, 404);
  assert.equal((await call('GET', '/api/accounts/1/transactions?limit=500', { token })).status, 422);
});

test('login endpoints are rate limited', async () => {
  const limitedDb = openDb(':memory:');
  const srv = http.createServer(createApp({
    db: limitedDb, jwtSecret: 's', rateLimit: { max: 3, windowMs: 60_000 }, logger: silent,
  }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/auth/login`;
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: 'whatever1' }),
    });
    statuses.push(res.status);
  }
  srv.close(); limitedDb.close();
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});

test('serves an OpenAPI spec and Swagger UI page', async () => {
  const spec = await call('GET', '/openapi.json');
  assert.equal(spec.status, 200);
  assert.equal(spec.json.openapi, '3.0.3');
  assert.ok(spec.json.paths['/api/transfers'].post);

  // every real route should be documented
  for (const path of ['/api/auth/login', '/api/accounts/{id}/deposits', '/api/accounts/{id}/transactions']) {
    assert.ok(spec.json.paths[path], `${path} missing from spec`);
  }

  const docs = await fetch(base + '/docs');
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get('content-type'), /text\/html/);
  assert.match(await docs.text(), /SwaggerUIBundle/);
});
