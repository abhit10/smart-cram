import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { createServer } from 'node:http';

async function start(options = {}) {
  const app = createApp({ databasePath: ':memory:', geminiKey: '', youtubeKey: '', ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0],
      headers: response.headers, body: parsed, text };
  }
  const close = () => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
  return { app, request, close };
}
const credentials = { name: 'Student', email: 'student@example.com', password: 'test-password-123' };
const studyData = { cheatsheets: [{ name: 'History', items: [{ text: 'A note', source: 'PDF', addedAt: '2026-10-09' }] }],
  chatMessages: [{ type: 'user', content: 'Hello' }], generatedFlashcards: [{ question: 'Q', answer: 'A' }], progress: { currentFlashcard: 0 } };

test('registration, login, per-user storage, conflicts, deletion and logout', async t => {
  const { request, close } = await start(); t.after(close);
  assert.equal((await request('/api/data')).status, 401);
  const first = await request('/api/auth/register', { method: 'POST', body: credentials });
  assert.equal(first.status, 201);
  assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = first.cookie;
  assert.equal((await request('/api/auth/register', { method: 'POST', body: credentials })).status, 409);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { ...credentials, password: 'wrong-password' } })).status, 401);
  const saved = await request('/api/data', { method: 'PUT', cookie, body: { ...studyData, revision: 0 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.deepEqual((await request('/api/data', { cookie })).body, { ...studyData, revision: 1 });
  assert.equal((await request('/api/data', { method: 'PUT', cookie, body: { ...studyData, revision: 0 } })).status, 409);
  const second = await request('/api/auth/register', { method: 'POST', body: { ...credentials, email: 'second@example.com' } });
  assert.deepEqual((await request('/api/cheatsheets', { cookie: second.cookie })).body.cheatsheets, []);
  assert.equal((await request('/api/data', { cookie: second.cookie, headers: { 'X-Account-Id': String(first.body.user.id) } })).status, 409);
  const forged = await request('/api/data', { method: 'PUT', cookie: second.cookie, body: { ...studyData, user_id: first.body.user.id, revision: 0 } });
  assert.equal(forged.status, 200);
  assert.equal((await request('/api/data', { cookie })).body.revision, 1);
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie, body: {} })).status, 200);
  assert.equal((await request('/api/data', { cookie })).status, 401);
  const login = await request('/api/auth/login', { method: 'POST', body: credentials });
  assert.deepEqual((await request('/api/data', { cookie: login.cookie })).body.cheatsheets, studyData.cheatsheets);
  assert.equal((await request('/api/data', { method: 'PUT', cookie: login.cookie, body: { ...studyData, cheatsheets: [], revision: 1 } })).status, 200);
  assert.deepEqual((await request('/api/cheatsheets', { cookie: login.cookie })).body.cheatsheets, []);
});

test('SQLite and sessions survive a server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'smart-cram-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'study.sqlite');
  const first = await start({ databasePath });
  const auth = await first.request('/api/auth/register', { method: 'POST', body: credentials });
  await first.request('/api/data', { method: 'PUT', cookie: auth.cookie, body: { ...studyData, revision: 0 } });
  await first.close();
  const second = await start({ databasePath });
  try { assert.deepEqual((await second.request('/api/data', { cookie: auth.cookie })).body, { ...studyData, revision: 1 }); }
  finally { await second.close(); }
});

test('invalid inputs, cross-origin requests, private files and missing keys', async t => {
  const { request, close } = await start(); t.after(close);
  for (const path of ['/.env', '/server.js', '/data/smart-cram.sqlite', '/package.json', '/test/server.test.js']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: credentials, headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: credentials, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { ...credentials, password: 'short' } })).status, 400);
  const { cookie } = await request('/api/auth/register', { method: 'POST', body: credentials });
  assert.equal((await request('/api/data', { method: 'PUT', cookie, body: { ...studyData, cheatsheets: [null], revision: 0 } })).status, 400);
  assert.equal((await request('/api/data', { method: 'PUT', cookie, body: { ...studyData, revision: -1 } })).status, 400);
  assert.equal((await request('/api/chat', { method: 'POST', cookie, body: { message: '' } })).status, 400);
  assert.equal((await request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello' } })).status, 503);
  assert.equal((await request('/api/youtube/search?q=history', { cookie })).status, 503);
});

test('proxies use server keys and return chat, flashcards and videos', async t => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.includes('youtube') ? { items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: 'History', description: 'Lesson', channelTitle: 'School', publishedAt: '2026-01-01' } }] } :
      { candidates: [{ content: { parts: [{ text: 'Q: What is history?\nA: Study of the past.' }] } }] } };
  };
  const { request, close } = await start({ geminiKey: 'test-gemini-secret', youtubeKey: 'test-youtube-secret', fetchImpl }); t.after(close);
  const { cookie } = await request('/api/auth/register', { method: 'POST', body: credentials });
  const chat = await request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello' } });
  assert.equal(chat.status, 200); assert.match(chat.body.reply, /history/);
  const cards = await request('/api/flashcards/generate', { method: 'POST', cookie, body: { content: 'Study notes' } });
  assert.deepEqual(cards.body.flashcards, [{ question: 'What is history?', answer: 'Study of the past.' }]);
  const videos = await request('/api/youtube/search?q=history', { cookie });
  assert.equal(videos.body.videos[0].id, 'abcdefghijk');
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'test-gemini-secret');
  assert.match(calls[2].url, /key=test-youtube-secret/);
  assert.ok(!JSON.stringify([chat.body, cards.body, videos.body]).includes('secret'));
});

test('provider failures do not expose secrets', async t => {
  const { request, close } = await start({ geminiKey: 'secret', fetchImpl: async () => ({ ok: false, status: 403 }) }); t.after(close);
  const { cookie } = await request('/api/auth/register', { method: 'POST', body: credentials });
  const result = await request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello' } });
  assert.equal(result.status, 502); assert.match(result.body.error, /server API key/); assert.ok(!result.body.error.includes('secret'));
});

const providerRoutes = [
  { path: '/api/chat', method: 'POST', body: { message: 'Explain nationalism' }, keyName: 'GEMINI_API_KEY' },
  { path: '/api/flashcards/generate', method: 'POST', body: { content: 'History study notes' }, keyName: 'GEMINI_API_KEY' },
  { path: '/api/youtube/search?q=history', method: 'GET', keyName: 'YOUTUBE_API_KEY' }
];
const testKeys = { geminiKey: 'fake-gemini-private-value', youtubeKey: 'fake-youtube-private-value' };

test('public assets contain no provider configuration or server key values', async t => {
  const { request, close } = await start(testKeys); t.after(close);
  for (const path of ['/', '/index.html', '/script.js', '/account.js', '/styles.css', '/2023-24_history.json', '/2024-25_history.json']) {
    const result = await request(path);
    assert.equal(result.status, 200, path);
    for (const key of Object.values(testKeys)) assert.ok(!result.text.includes(key), path);
    assert.doesNotMatch(result.text, /(?:GEMINI|YOUTUBE|OPENAI|CLAUDE)_API_KEY|generativelanguage\.googleapis\.com|googleapis\.com\/youtube\/v3/, path);
  }
  for (const path of ['/.env', '/.env.local', '/.env.production', '/.env.example', '/server.js', '/.git/config', '/data/smart-cram.sqlite']) {
    for (const method of ['GET', 'HEAD']) assert.equal((await request(path, { method })).status, 404, `${method} ${path}`);
  }
});

test('all provider routes reject unauthenticated requests before calling providers', async t => {
  let calls = 0;
  const { request, close } = await start({ ...testKeys, fetchImpl: async () => { calls++; throw new Error('Unexpected provider call'); } });
  t.after(close);
  for (const route of providerRoutes) {
    const result = await request(route.path, route);
    assert.equal(result.status, 401, route.path);
    assert.match(result.body.error, /sign in/i);
  }
  assert.equal(calls, 0);
});

test('all provider routes explain missing server keys without contacting providers', async t => {
  let calls = 0;
  const { request, close } = await start({ fetchImpl: async () => { calls++; throw new Error('Unexpected provider call'); } });
  t.after(close);
  const { cookie } = await request('/api/auth/register', { method: 'POST', body: credentials });
  for (const route of providerRoutes) {
    const result = await request(route.path, { ...route, cookie });
    assert.equal(result.status, 503, route.path);
    assert.ok(result.body.error.includes(route.keyName));
    assert.match(result.body.error, /on the server/);
  }
  assert.equal(calls, 0);
});

test('provider authentication and quota errors stay readable without leaking upstream errors', async t => {
  let status = 403;
  let bodyReads = 0;
  const { request, close } = await start({ ...testKeys, fetchImpl: async () => ({
    ok: false, status, json: async () => { bodyReads++; return { error: `Credential: ${testKeys.geminiKey} ${testKeys.youtubeKey}` }; }
  }) }); t.after(close);
  const { cookie } = await request('/api/auth/register', { method: 'POST', body: credentials });
  for (status of [400, 401, 403, 429, 500]) {
    for (const route of providerRoutes) {
      const result = await request(route.path, { ...route, cookie });
      assert.equal(result.status, status === 429 ? 503 : 502);
      assert.match(result.body.error, status === 429 ? /quota exceeded/ : status === 500 ? /unavailable/ : /server API key/);
      for (const key of Object.values(testKeys)) assert.ok(!result.text.includes(key));
    }
  }
  assert.equal(bodyReads, 0, 'Raw upstream error bodies must not be forwarded');
});

test('provider network failures do not expose exception details', async t => {
  const calls = [];
  const { request, close } = await start({ ...testKeys, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    throw new Error(`Redirect to https://unexpected.example/?key=${testKeys.youtubeKey}`);
  } }); t.after(close);
  const { cookie } = await request('/api/auth/register', { method: 'POST', body: credentials });
  for (const route of providerRoutes) {
    const result = await request(route.path, { ...route, cookie });
    assert.equal(result.status, 502);
    assert.match(result.body.error, /unavailable or timed out/);
    assert.ok(!result.text.includes('unexpected.example'));
    for (const key of Object.values(testKeys)) assert.ok(!result.text.includes(key));
  }
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.options.redirect, 'error');
});

test('a real HTTP redirect is rejected before credentials reach the redirected endpoint', async t => {
  let redirectedRequests = 0;
  let initialKey;
  const provider = createServer((req, res) => {
    if (req.url === '/redirect') {
      initialKey = req.headers['x-goog-api-key'];
      res.writeHead(302, { Location: '/capture' });
    } else { redirectedRequests++; res.writeHead(200); }
    res.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const { request, close } = await start({ ...testKeys,
    fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${provider.address().port}/redirect`, options)
  }); t.after(close);
  const { cookie } = await request('/api/auth/register', { method: 'POST', body: credentials });
  const result = await request('/api/chat', { method: 'POST', cookie, body: { message: 'Hello' } });
  assert.equal(initialKey, testKeys.geminiKey);
  assert.equal(result.status, 502);
  assert.equal(redirectedRequests, 0);
  assert.ok(!result.text.includes(testKeys.geminiKey));
});
