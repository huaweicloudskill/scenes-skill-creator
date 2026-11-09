/**
 * Host-side scene trimming: only `generic` and `huawei` may exist.
 *
 * These assertions are the guard rail for the whole Host half — the removed standard-API
 * scene must not creep back into the creator table, the mode mapper, or the handoff text.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CREATORS, KIND_LABEL, buildHandoff, cacheRoot, creatorDir, kindOfMode, status,
} from '../../src/core/creators.mjs';
import { DOMAINS, FEATURE_TYPES, SPEC, domainProducts } from '../../src/core/spec.mjs';

// Point the cache at a scratch dir so the suite never touches a real creator cache.
process.env.DSH_SKILL_CREATOR_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-creators-'));

describe('creator delegation · only generic + huawei', () => {
  test('CREATORS has exactly the two shipped scenes (no api entry)', () => {
    const kinds = Object.keys(CREATORS).sort();
    assert.deepEqual(kinds, ['generic', 'huawei']);
    assert.equal(Object.keys(CREATORS).length, 2);
    assert.equal(CREATORS.api, undefined, 'the standard-API creator must be gone');
    assert.deepEqual(Object.keys(KIND_LABEL).sort(), ['generic', 'huawei']);
    assert.equal(KIND_LABEL.api, undefined);
    assert.doesNotMatch(JSON.stringify(KIND_LABEL), /REST API/);
  });

  test('each mode maps onto its official creator repository', () => {
    assert.equal(CREATORS.huawei.skill, 'huawei-cloud-skill-creator');
    assert.equal(CREATORS.huawei.repo, 'https://gitcode.com/huaweicloud/huaweicloud-skills.git');
    assert.equal(CREATORS.huawei.branch, 'master');
    assert.equal(CREATORS.huawei.path, 'skills/devtools/common/huawei-cloud-skill-creator');
    assert.equal(CREATORS.huawei.namePrefix, 'huawei-cloud-');

    assert.equal(CREATORS.generic.skill, 'common-skill-creator');
    assert.equal(CREATORS.generic.repo, 'https://gitcode.com/grape-dev/grape-skills.git');
    assert.equal(CREATORS.generic.branch, 'main');
    assert.equal(CREATORS.generic.path, 'skills/coding/scaffolding/common-skill-creator');

    for (const kind of Object.keys(CREATORS)) {
      const current = CREATORS[kind];
      assert.match(current.web, /gitcode\.com/);
      assert.ok(current.skill && current.branch && current.path, `${kind} must carry its full locator`);
    }
  });

  test('kindOfMode recognises generic/huawei and never produces api', () => {
    assert.equal(kindOfMode('generic'), 'generic');
    assert.equal(kindOfMode('huawei'), 'huawei');
    // Removed / unknown / garbage modes all stay Huawei-shaped.
    assert.equal(kindOfMode('api'), 'huawei', 'the removed api mode must fall back, not resurface');
    assert.equal(kindOfMode(undefined), 'huawei');
    assert.equal(kindOfMode(null), 'huawei');
    assert.equal(kindOfMode(''), 'huawei');
    assert.equal(kindOfMode('rest-api'), 'huawei');
    assert.equal(kindOfMode('Generic'), 'huawei', 'matching is exact, not case-insensitive');
    assert.equal(kindOfMode('nope'), 'huawei');
    for (const mode of ['api', 'rest-api', 'nope', undefined]) {
      const kind = kindOfMode(mode);
      assert.ok(kind === 'generic' || kind === 'huawei', `kindOfMode(${mode}) produced ${kind}`);
      assert.ok(CREATORS[kind], `kindOfMode(${mode}) produced an unknown kind`);
    }
  });

  test('status reports absence without hitting the network', () => {
    const current = status('huawei');
    assert.equal(current.present, false);
    assert.equal(current.fresh, false);
    assert.equal(current.commit, '');
    assert.deepEqual(current.files, []);
    assert.ok(creatorDir('huawei').startsWith(cacheRoot()));
    assert.equal(status('generic').kind, 'generic');
    assert.throws(() => status('api'), /unknown creator kind/);
  });

  test('the Huawei handoff carries the packaged spec', () => {
    const prompt = buildHandoff('huawei', {
      name: 'huawei-cloud-ecs-manage', domain: 'computing', product: 'ecs',
      description: 'Manage ECS via KooCLI',
    });
    assert.match(prompt, /Use the `huawei-cloud-skill-creator` skill/);
    assert.match(prompt, /Skill name: huawei-cloud-ecs-manage/);
    assert.match(prompt, /Repository path: skills\/computing\/ecs\/huawei-cloud-ecs-manage/);
    assert.match(prompt, /一级目录 \(domain\): computing/);
    assert.match(prompt, /功能概括 \(description\): Manage ECS via KooCLI/);
    assert.match(prompt, /gitcode\.com\/huaweicloud\/huaweicloud-skills/);
    assert.doesNotMatch(prompt, /REST API/);
  });

  test('the generic handoff carries only the description', () => {
    const prompt = buildHandoff('generic', { description: 'Turn my notes into an index page.' });
    assert.match(prompt, /Use the `common-skill-creator` skill/);
    assert.match(prompt, /技能功能描述 \(description\): Turn my notes into an index page\./);
    assert.doesNotMatch(prompt, /Repository path/);
    assert.doesNotMatch(prompt, /一级目录/);
    assert.match(prompt, /grape-dev\/grape-skills/);
    assert.match(buildHandoff('generic', { name: 'my-skill', description: 'x' }), /Requested name: my-skill/);
  });

  test('an api kind cannot be handed off either', () => {
    assert.throws(() => buildHandoff('api', { description: 'x' }), /unknown creator kind/);
    assert.throws(() => buildHandoff('nope', {}), /unknown creator kind/);
  });
});

describe('spec constants · the Huawei scene still has its domain table', () => {
  test('the domain → product table underpins the huawei wizard', () => {
    assert.equal(SPEC.huaweiNamePrefix, 'huawei-cloud-');
    assert.ok(Array.isArray(DOMAINS.computing) && DOMAINS.computing.includes('ecs'));
    assert.deepEqual(domainProducts('computing'), DOMAINS.computing);
    assert.deepEqual(domainProducts('nope'), []);
    assert.ok(FEATURE_TYPES.length >= 1);
    assert.ok(FEATURE_TYPES.every((item) => item.suffix.startsWith('-')));
  });

  test('spec has no API-scene mode list', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(SPEC, 'MODES'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(SPEC, 'api'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(DOMAINS, 'api'), false);
  });
});