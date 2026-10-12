import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.ts';
import { buildApp } from '../src/server/app.ts';
import { makeServices } from './helpers.ts';

const auth = { password: 'correct horse battery', secret: 's'.repeat(40) };

async function setup() {
  return buildApp({
    config: { providers: 'mock', imageModel: 'm', videoModel: 'v', imagesPerBatch: 6, logLevel: 'error', auth },
    ...makeServices(),
    logger: false,
  });
}

test('without a session, pages redirect to login and the API and files return 401', async () => {
  const app = await setup();
  const page = await app.inject('/');
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/login.html');
  assert.equal((await app.inject('/api/config')).statusCode, 401);
  assert.equal((await app.inject('/assets/ab/abc.png')).statusCode, 401);
  assert.equal((await app.inject('/login.html')).statusCode, 200);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('logging in sets a session cookie that unlocks the app; tampered cookies do not', async () => {
  const app = await setup();
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } })).statusCode, 401);

  const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { password: auth.password } });
  assert.equal(ok.statusCode, 200);
  const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
  assert.match(String(ok.headers['set-cookie']), /HttpOnly/);

  assert.equal((await app.inject({ url: '/api/config', headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/', headers: { cookie } })).statusCode, 200);

  const [name, value] = cookie.split('=');
  const [expires, sig] = value!.split('.');
  const forged = `${name}=${Number(expires) + 1e9}.${sig}`;
  assert.equal((await app.inject({ url: '/api/config', headers: { cookie: forged } })).statusCode, 401);
});

test('repeated wrong passwords lock the client out', async () => {
  const app = await setup();
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
  const locked = await app.inject({ method: 'POST', url: '/api/login', payload: { password: auth.password } });
  assert.equal(locked.statusCode, 429);
});

test('config refuses to expose the app on a public host without a password', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /APP_PASSWORD and SESSION_SECRET are required/);
  assert.throws(() => loadConfig({ APP_PASSWORD: 'short' }), /at least 12/);
  const cfg = loadConfig({ HOST: '0.0.0.0', APP_PASSWORD: auth.password, SESSION_SECRET: auth.secret, TRUST_PROXY: '1' });
  assert.deepEqual(cfg.auth, auth);
  assert.equal(cfg.trustProxy, 1);
  assert.equal(loadConfig({}).auth, undefined);
});
