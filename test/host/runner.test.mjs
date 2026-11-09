/**
 * Runner invariants for the scenes bundle:
 *   - the standard-API pipeline is gone (only generic / huawei checklists),
 *   - the 20-record cap is gone (both the in-memory eviction and the persist slice),
 *   - the 200-step log window is untouched,
 *   - list() returns every persisted record.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PHASES, PHASES_BY_KIND, createRunner, detectStage, phasesFor,
} from '../../src/core/runner.mjs';

const RUNNER_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../../src/core/runner.mjs', import.meta.url)),
  'utf8',
);

describe('runner source · no run cap, no api pipeline', () => {
  test('MAX_RUNS is gone from the source (eviction loop and persist slice)', () => {
    assert.doesNotMatch(RUNNER_SOURCE, /MAX_RUNS/, 'the 20-record cap must not survive anywhere');
    assert.doesNotMatch(RUNNER_SOURCE, /slice\(\s*0\s*,\s*MAX_RUNS\s*\)/);
    assert.doesNotMatch(RUNNER_SOURCE, /while\s*\(\s*runs\.size\s*>/);
    // ...while the persisted step window deliberately stays at 200.
    assert.match(RUNNER_SOURCE, /const MAX_STEPS = 200;/, 'the 200-step log window must remain');
    assert.match(RUNNER_SOURCE, /slice\(-MAX_STEPS\)/, 'persistence must still window the steps');
  });

  test('the phase table only has generic / huawei (unknown falls back to huawei)', () => {
    assert.deepEqual(Object.keys(PHASES_BY_KIND).sort(), ['generic', 'huawei']);
    assert.equal(PHASES_BY_KIND.api, undefined, 'the standard-API stage list must be gone');
    assert.equal(PHASES.length, 6);
    assert.equal(phasesFor('generic').length, 5);
    // The removed api kind is simply unknown now — it must resolve to the Huawei pipeline,
    // exactly like any other garbage mode.
    assert.equal(phasesFor('api').length, 6);
    assert.equal(phasesFor('nope').length, 6);
    assert.match(phasesFor('generic')[0].title, /阶段 1/);
    assert.match(phasesFor('huawei')[1].title, /Phase 2/);
  });

  test('stage detection for the two real creators is unchanged', () => {
    assert.equal(detectStage('huawei', 'Phase 3 now'), 3);
    assert.equal(detectStage('huawei', 'Phase 1 … Phase 6'), 6);
    assert.equal(detectStage('huawei', 'Step 4 of the generic flow'), null);
    assert.equal(detectStage('generic', 'Step 2: design'), 2);
    assert.equal(detectStage('generic', 'writing phase-4-summary.json'), 4);
    assert.equal(detectStage('generic', 'Step 7 创建 PR'), 5);
    assert.equal(detectStage('generic', 'nothing yet'), null);
  });
});

describe('runner records · every record is kept', () => {
  /** A Host-like ctx without any service: enough for createRunner + restore + flush. */
  const bareCtx = () => ({ on() { return () => {}; }, get() { return undefined; } });

  const withPrivateCache = (fn) => {
    const previous = process.env.DSH_SKILL_CREATOR_CACHE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-runs-'));
    process.env.DSH_SKILL_CREATOR_CACHE = root;
    return Promise.resolve()
      .then(() => fn(root))
      .finally(() => {
        if (previous === undefined) delete process.env.DSH_SKILL_CREATOR_CACHE;
        else process.env.DSH_SKILL_CREATOR_CACHE = previous;
        fs.rmSync(root, { recursive: true, force: true });
      });
  };

  const record = (id, startedAt) => ({
    id, sessionId: id, kind: 'huawei', status: 'done', startedAt, updatedAt: startedAt,
    steps: [], spec: { mode: 'huawei', name: id },
  });

  test('list() returns all 30 restored records, not the newest 20', async () => {
    await withPrivateCache(async (root) => {
      const base = Date.now() - 10 * 60 * 1000;
      const records = [];
      for (let i = 0; i < 30; i += 1) records.push(record(`session-r-${i}`, base + i * 1000));
      fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify({ version: 1, runs: records }));

      const runner = createRunner(bareCtx(), { wakeGraceMs: 0, maxEvalRounds: 0 });
      const list = runner.list();
      assert.equal(list.length, 30, 'list() must return every record (no cap)');
      assert.equal(list[0].id, 'session-r-29', 'still newest-first');
      assert.equal(list.at(-1).id, 'session-r-0');
      for (const item of list) assert.ok(runner.get(item.id), `record ${item.id} must be readable`);
    });
  });

  test('disposeAll() persists all records without the old 20-record slice', async () => {
    await withPrivateCache(async (root) => {
      const base = Date.now() - 10 * 60 * 1000;
      const records = [];
      for (let i = 0; i < 25; i += 1) records.push(record(`session-p-${i}`, base + i * 1000));
      fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify({ version: 1, runs: records }));

      const runner = createRunner(bareCtx(), { wakeGraceMs: 0, maxEvalRounds: 0 });
      assert.equal(runner.list().length, 25);
      runner.disposeAll(); // flushes before clearing: a shut-down must not truncate history
      assert.deepEqual(runner.list(), []);

      const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'runs.json'), 'utf8')).runs;
      assert.equal(onDisk.length, 25, 'the persistence layer must not slice records either');
      assert.ok(onDisk.some((item) => item.id === 'session-p-0'), 'the oldest record survives too');
    });
  });

  test('install() copies the finished skill into the configured skill root', async () => {
    await withPrivateCache(async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-install-'));
      const target = path.join(base, 'workspace', 'skills', 'demo-skill');
      const installRoot = path.join(base, 'dsh-home', 'skills');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n\n# demo\n');
      fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(target, 'scripts', 'run.py'), 'print("ok")\n');
      try {
        const runner = createRunner(bareCtx(), { wakeGraceMs: 0, maxEvalRounds: 0, installDir: installRoot });
        runner.runs.set('session-install', {
          id: 'session-install', sessionId: 'session-install', kind: 'generic', status: 'done',
          startedAt: Date.now(), updatedAt: Date.now(), steps: [], spec: { mode: 'generic' }, target,
        });
        const result = runner.install('session-install');
        assert.equal(result.ok, true, result.error);
        assert.equal(result.name, 'demo-skill');
        assert.equal(result.path, path.join(installRoot, 'demo-skill'));
        assert.equal(fs.readFileSync(path.join(installRoot, 'demo-skill', 'SKILL.md'), 'utf8').includes('demo-skill'), true);
        assert.equal(fs.existsSync(path.join(installRoot, 'demo-skill', 'scripts', 'run.py')), true);
        assert.equal(runner.get('session-install').installedPath, result.path);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  });

  test('an active-looking record left by a dead fiber is restored as interrupted', async () => {
    await withPrivateCache(async (root) => {
      fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify({
        version: 1,
        runs: [{ ...record('session-live', Date.now()), status: 'creating' }],
      }));
      const runner = createRunner(bareCtx(), { wakeGraceMs: 0, maxEvalRounds: 0 });
      const found = runner.get('session-live');
      assert.equal(found.status, 'interrupted');
      assert.ok(runner.list().some((item) => item.id === 'session-live'));
    });
  });

  test('remove() deletes from memory AND disk (no anti-shrink resurrection)', async () => {
    await withPrivateCache(async (root) => {
      const base = Date.now() - 60 * 1000;
      const records = [
        record('session-del-0', base),
        record('session-del-1', base + 1000),
        record('session-del-2', base + 2000),
      ];
      fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify({ version: 1, runs: records }));

      const runner = createRunner(bareCtx(), { wakeGraceMs: 0, maxEvalRounds: 0 });
      assert.equal(runner.list().length, 3);
      assert.equal(runner.remove('session-del-1'), true, 'settled record is removable');
      assert.equal(runner.get('session-del-1'), null);

      const disk = JSON.parse(fs.readFileSync(path.join(root, 'runs.json'), 'utf8')).runs;
      assert.ok(!disk.some((item) => item.id === 'session-del-1'), 'runs.json must not resurrect it');
      const backup = JSON.parse(fs.readFileSync(path.join(root, 'runs.json.bak'), 'utf8')).runs;
      assert.ok(!backup.some((item) => item.id === 'session-del-1'), '.bak must not resurrect it either');

      // A fresh fiber restores only the two survivors.
      const restarted = createRunner(bareCtx(), { wakeGraceMs: 0, maxEvalRounds: 0 });
      assert.deepEqual(restarted.list().map((item) => item.id).sort(), ['session-del-0', 'session-del-2']);
    });
  });

  test('remove() refuses an active run', async () => {
    await withPrivateCache(async () => {
      const runner = createRunner(bareCtx(), { wakeGraceMs: 0, maxEvalRounds: 0 });
      // No service handles are needed: inject an active record straight into the in-memory map.
      runner.runs.set('session-active', { ...record('session-active', Date.now()), status: 'creating' });
      assert.equal(runner.remove('session-active'), false);
      assert.ok(runner.runs.has('session-active'));
    });
  });
});