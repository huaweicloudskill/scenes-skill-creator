/**
 * In-host panel API routes, exercised against a mock runner/catalog (no agent, no network).
 *
 * The creator cache is seeded with a fresh stub so `/creator` never reaches out to gitcode.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { API_BASE, API_REVISION, createApiHandler } from '../../src/core/routes.mjs';
import { CREATORS, cacheRoot, creatorDir } from '../../src/core/creators.mjs';

// A fresh, offline creator cache: `/creator` sees present + fresh and performs no fetch.
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-routes-'));
process.env.DSH_SKILL_CREATOR_CACHE = cache;
for (const [kind, spec] of Object.entries(CREATORS)) {
  const dir = creatorDir(kind);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${spec.skill}\ndescription: x\n---\n`);
  fs.mkdirSync(path.join(cache, kind), { recursive: true });
  fs.writeFileSync(path.join(cache, kind, 'stamp.json'), JSON.stringify({
    kind, skill: spec.skill, repo: spec.repo, branch: spec.branch, path: spec.path,
    commit: 'deadbeefcafe', fetchedAt: Date.now(),
  }));
}
assert.ok(fs.existsSync(path.join(creatorDir('huawei'), 'SKILL.md')));

/** Minimal IncomingMessage: URL + method + async JSON body. */
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: { host: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}

/** Minimal ServerResponse capturing status, headers and payload. */
function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    payload: '',
    writeHead(code, headers) { res.status = code; res.headers = headers; },
    end(payload) { res.payload = payload ?? ''; },
  };
  return res;
}

const json = (res) => JSON.parse(res.payload);

describe('panel API · prefix and routes', () => {
  const calls = [];
  const runner = {
    async start(spec) { calls.push(['start', spec]); return { id: 'run-1' }; },
    get(id) {
      if (id === 'run-1') return { id: 'run-1', status: 'creating', phases: [], steps: [] };
      if (id === 'run-2') return { id: 'run-2', status: 'done', phases: [], steps: [] };
      return null;
    },
    list() {
      return [
        { id: 'run-1', status: 'creating' },
        { id: 'run-2', status: 'done' },
      ];
    },
    async cancel(id) { calls.push(['cancel', id]); return id === 'run-1'; },
    remove(id) { calls.push(['remove', id]); return id === 'run-2'; },
    async manualRetry(id) {
      calls.push(['retry', id]);
      return id === 'run-2'
        ? { ok: true, run: { id, status: 'fixing', round: 1, maxEvalRounds: 2 } }
        : { ok: false, error: '只有未达标的记录可以手动复评' };
    },
    install(id) {
      calls.push(['install', id]);
      return id === 'run-2'
        ? { ok: true, installed: true, name: 'demo-skill', path: 'C:\\skills\\demo-skill' }
        : { ok: false, error: '没有可安装的 SKILL.md' };
    },
  };
  const catalog = {
    describe: () => ({ repo: 'huaweicloud/huaweicloud-skills', ref: 'master', root: 'skills' }),
    async list(rel, { refresh } = {}) {
      calls.push(['catalog', rel || 'skills', Boolean(refresh)]);
      return { path: rel || 'skills', entries: [{ name: 'computing', type: 'dir' }], source: 'gitcode' };
    },
  };
  const refs = {
    async snapshot() {
      calls.push(['refs']);
      return {
        ok: true, source: 'remote', stale: false,
        scenes: { huawei: { cases: [] }, generic: { cases: [] } }, warnings: [],
      };
    },
  };
  const handler = createApiHandler({ runner, catalog, refs });

  const call = async (method, route, body) => {
    const res = fakeRes();
    await handler(fakeReq(method, `${API_BASE}${route}`, body), res);
    return res;
  };

  test('the prefix is the scenes bundle prefix and carries a fresh revision', () => {
    assert.equal(API_BASE, '/scenes-skill-creator/api');
    assert.equal(typeof API_REVISION, 'string');
    assert.ok(API_REVISION.length > 0);
    assert.notEqual(API_REVISION, 'r6', 'the revision must be bumped for this bundle');
  });

  test('GET /status lists ONLY generic + huawei creators', async () => {
    const res = await call('GET', '/status');
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.equal(body.revision, API_REVISION);
    assert.equal(body.catalog.root, 'skills');
    assert.deepEqual(Object.keys(body.creators).sort(), ['generic', 'huawei']);
    assert.equal(body.creators.api, undefined, '/status must never expose an api creator');
    assert.equal(body.creators.huawei.present, true);
    assert.equal(body.creators.huawei.skill, 'huawei-cloud-skill-creator');
    assert.equal(body.creators.generic.skill, 'common-skill-creator');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.match(res.headers['Content-Type'], /application\/json/);
  });

  test('GET /catalog reads one live level and forwards refresh', async () => {
    const res = await call('GET', '/catalog?path=skills&refresh=1');
    assert.equal(res.status, 200);
    assert.deepEqual(json(res).entries, [{ name: 'computing', type: 'dir' }]);
    assert.deepEqual(calls.at(-1), ['catalog', 'skills', true]);
  });

  test('GET /catalog failure is a clear 503, not a crash', async () => {
    const failing = createApiHandler({
      runner,
      catalog: {
        describe: () => ({ root: 'skills' }),
        async list() { throw new Error('gitcode 503'); },
      },
    });
    const res = fakeRes();
    await failing(fakeReq('GET', `${API_BASE}/catalog?path=skills`), res);
    assert.equal(res.status, 503);
    assert.match(json(res).error, /gitcode 503/);
  });

  test('GET /creator serves the cached creator for each mode (api falls back to huawei)', async () => {
    const generic = await call('GET', '/creator?mode=generic');
    assert.equal(generic.status, 200);
    assert.equal(json(generic).ok, true);
    assert.equal(json(generic).kind, 'generic');
    assert.equal(json(generic).present, true);
    assert.equal(json(generic).skill, 'common-skill-creator');
    assert.equal(json(generic).branch, 'main');

    const huawei = await call('GET', '/creator?mode=huawei');
    assert.equal(json(huawei).kind, 'huawei');
    assert.equal(json(huawei).branch, 'master');

    // The standard-API value is no longer a kind: it is treated as unknown → huawei.
    const removed = await call('GET', '/creator?mode=api');
    assert.equal(removed.status, 200);
    assert.equal(json(removed).kind, 'huawei');
    assert.notEqual(json(removed).kind, 'api');
  });

  test('POST /run starts a run with the collected spec', async () => {
    const spec = { mode: 'generic', description: 'Turn notes into an index page.' };
    const res = await call('POST', '/run', { spec });
    assert.equal(res.status, 200);
    assert.equal(json(res).ok, true);
    assert.equal(json(res).run.id, 'run-1');
    assert.deepEqual(calls.at(-1), ['start', spec]);
  });

  test('GET /run returns the full list and one run by id', async () => {
    const all = await call('GET', '/run');
    assert.equal(all.status, 200);
    assert.equal(json(all).runs.length, 2, 'runner.list() must not be capped by the route');

    const one = await call('GET', '/run?id=run-1');
    assert.equal(one.status, 200);
    assert.equal(json(one).run.id, 'run-1');

    const missing = await call('GET', '/run?id=nope');
    assert.equal(missing.status, 404);
    assert.match(json(missing).error, /unknown run/);
  });

  test('POST /run/retry starts the one manual second round and rejects ineligible runs', async () => {
    const ok = await call('POST', '/run/retry', { id: 'run-2' });
    assert.equal(ok.status, 200);
    assert.equal(json(ok).ok, true);
    assert.equal(json(ok).run.maxEvalRounds, 2);
    const bad = await call('POST', '/run/retry', { id: 'run-1' });
    assert.equal(bad.status, 409);
    assert.match(json(bad).error, /未达标/);
    const noId = await call('POST', '/run/retry', {});
    assert.equal(noId.status, 400);
  });

  test('POST /install copies a finished skill and reports the installed path', async () => {
    const ok = await call('POST', '/install', { id: 'run-2' });
    assert.equal(ok.status, 200);
    assert.equal(json(ok).installed, true);
    assert.equal(json(ok).name, 'demo-skill');
    const bad = await call('POST', '/install', { id: 'run-1' });
    assert.equal(bad.status, 409);
    const noId = await call('POST', '/install', {});
    assert.equal(noId.status, 400);
  });

  test('POST /cancel reports whether the run existed', async () => {
    const ok = await call('POST', '/cancel', { id: 'run-1' });
    assert.equal(ok.status, 200);
    assert.equal(json(ok).ok, true);
    assert.equal(json(ok).run.id, 'run-1');
    assert.deepEqual(calls.at(-1), ['cancel', 'run-1']);

    const missing = await call('POST', '/cancel', { id: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal(json(missing).ok, false);
  });

  test('DELETE /run removes settled records and refuses active ones', async () => {
    const ok = await call('DELETE', '/run?id=run-2');
    assert.equal(ok.status, 200);
    assert.equal(json(ok).ok, true);
    assert.deepEqual(calls.at(-1), ['remove', 'run-2']);

    const active = await call('DELETE', '/run?id=run-1');
    assert.equal(active.status, 409);
    assert.equal(json(active).ok, false);

    const missing = await call('DELETE', '/run?id=nope');
    assert.equal(missing.status, 404);

    const noId = await call('DELETE', '/run');
    assert.equal(noId.status, 400);
  });

  test('unknown routes are JSON 404s and thrown handlers are JSON 500s', async () => {
    const unknown = await call('GET', '/nope');
    assert.equal(unknown.status, 404);
    assert.match(json(unknown).error, /unknown route/);

    const boom = createApiHandler({
      runner: { async start() { throw new Error('agent create failed'); } },
      catalog,
    });
    const res = fakeRes();
    await boom(fakeReq('POST', `${API_BASE}/run`, { spec: {} }), res);
    assert.equal(res.status, 500);
    assert.match(json(res).error, /agent create failed/);
  });

  test('GET /refs returns remote recommendation data without touching the runner', async () => {
    const res = await call('GET', '/refs');
    assert.equal(res.status, 200);
    assert.equal(json(res).source, 'remote');
    assert.ok(json(res).scenes);
  });

  test('POST /handoff is generic/huawei only as well', async () => {
    const generic = await call('POST', '/handoff', { spec: { mode: 'generic', description: 'x' } });
    assert.equal(json(generic).kind, 'generic');
    assert.match(json(generic).prompt, /common-skill-creator/);
    const removed = await call('POST', '/handoff', { spec: { mode: 'api', description: 'x' } });
    assert.equal(json(removed).kind, 'huawei');
  });
});