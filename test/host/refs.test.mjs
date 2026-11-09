/**
 * Remote reference data: GitCode Contents API (base64) → normalized scenes, with a
 * last-good cache fallback. Cases and recommendations come exclusively from JSON; nothing
 * is injected by the Host.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRefs } from '../../src/core/refs.mjs';

const withCache = (fn) => {
  const previous = process.env.DSH_SKILL_CREATOR_CACHE;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-refs-'));
  process.env.DSH_SKILL_CREATOR_CACHE = root;
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_SKILL_CREATOR_CACHE;
      else process.env.DSH_SKILL_CREATOR_CACHE = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (name === 'content-length' ? String(Buffer.byteLength(body, 'utf8')) : null) },
  text: async () => body,
});

const huawei = {
  schemaVersion: 1,
  kind: 'huawei',
  updatedAt: '2026-11-06T00:00:00Z',
  cases: [{ id: 'case-1', title: '案例一', desc: '描述', skills: ['huawei-cloud-ecs'], video: 'https://example.com/a.mp4' }],
  skillsByDomain: {
    computing: [{ id: 'skill-1', name: 'huawei-cloud-ecs', desc: 'ECS', tags: ['ecs'], url: 'https://example.com/skill', views: 3, l2: 'ECS' }],
    default: [],
  },
};
const generic = {
  schemaVersion: 1,
  kind: 'generic',
  updatedAt: '2026-11-06T00:00:00Z',
  cases: [{ id: 'generic-case', title: '通用案例', desc: '来自 JSON 的案例', skills: ['common-skill-creator'] }],
  skills: [{ id: 'generic-1', name: 'common-skill-creator', desc: '创建通用技能', tags: ['skill'], url: 'https://example.com/generic', views: 2, l2: '编码开发' }],
};

describe('remote refs', () => {
  test('GitCode base64 contents API is decoded and validated', () => withCache(async () => {
    const urls = new Map([
      ['https://api.example/huawei', response(JSON.stringify({ encoding: 'base64', sha: 'abc', content: Buffer.from(JSON.stringify(huawei)).toString('base64') }))],
      ['https://api.example/generic', response(JSON.stringify(generic))],
    ]);
    const refs = createRefs({
      huaweiUrl: 'https://api.example/huawei',
      genericUrl: 'https://api.example/generic',
    }, { fetch: async (url) => urls.get(String(url)) });
    const snap = await refs.snapshot();
    assert.equal(snap.source, 'remote');
    assert.equal(snap.scenes.huawei.cases.length, 1);
    assert.equal(snap.scenes.huawei.skillsByDomain.computing[0].name, 'huawei-cloud-ecs');
    assert.equal(snap.scenes.generic.skills.length, 1);
    assert.deepEqual(snap.scenes.generic.cases.map((c) => c.id), ['generic-case']);
    assert.equal(snap.warnings.length, 0);
  }));

  test('a failed refresh falls back to the last successful copy', () => withCache(async () => {
    let fail = false;
    const refs = createRefs({
      huaweiUrl: 'https://api.example/huawei',
      genericUrl: 'https://api.example/generic',
    }, {
      fetch: async (url) => {
        if (fail) throw new Error('offline');
        return String(url).endsWith('/huawei') ? response(JSON.stringify(huawei)) : response(JSON.stringify(generic));
      },
    });
    const first = await refs.snapshot();
    assert.equal(first.source, 'remote');
    fail = true;
    const second = await refs.snapshot();
    assert.equal(second.source, 'cache');
    assert.equal(second.stale, true);
    assert.equal(second.scenes.huawei.cases[0].id, 'case-1');
    assert.match(second.warnings.join('\n'), /offline/);
  }));

  test('invalid schema and malformed items fail closed, not throw', () => withCache(async () => {
    const refs = createRefs({
      huaweiUrl: 'https://api.example/huawei',
      genericUrl: 'https://api.example/generic',
    }, {
      fetch: async (url) => String(url).endsWith('/huawei')
        ? response(JSON.stringify({ schemaVersion: 2, kind: 'huawei' }))
        : response(JSON.stringify({
          schemaVersion: 1, kind: 'generic', cases: [{ id: '', title: '', desc: '' }],
          skills: [{ id: 'ok', name: 'ok', desc: 'ok' }, { id: 'bad', name: 'bad' }],
        })),
    });
    const snap = await refs.snapshot();
    assert.equal(snap.source, 'none');
    assert.deepEqual(snap.scenes.huawei.cases, []);
    assert.equal(snap.scenes.generic.skills.length, 1);
    assert.deepEqual(snap.scenes.generic.cases, []);
    assert.ok(snap.warnings.length > 0);
  }));

  test('https-only URLs are enforced', () => withCache(async () => {
    const refs = createRefs({ huaweiUrl: 'http://example.com/huawei', genericUrl: '' }, { fetch: async () => { throw new Error('must not fetch'); } });
    const snap = await refs.snapshot();
    assert.equal(snap.source, 'none');
    assert.equal(snap.scenes.huawei.cases.length, 0);
    assert.match(snap.warnings.join('\n'), /https/);
  }));
});