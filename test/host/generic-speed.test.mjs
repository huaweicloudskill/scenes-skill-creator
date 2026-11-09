/**
 * Generic speed policy: creation directives + a capped eval loop.
 *
 * These are the concrete levers the panel uses when a generic skill creation took too
 * long: contract-first/minimal-path directives, and a single evaluation round by default.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EFFICIENCY_DIRECTIVES, GENERIC_SPEED_DIRECTIVES, buildGenericEvalFixture, parseEvaluationOutput } from '../../src/core/evaluator.mjs';
import { maxEvalRoundsForKind } from '../../src/core/runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('generic speed policy', () => {
  test('directives force contract-first, a minimal path, reuse and a size/time budget', () => {
    assert.equal(typeof GENERIC_SPEED_DIRECTIVES, 'string');
    assert.match(GENERIC_SPEED_DIRECTIVES, /先定契约/);
    assert.match(GENERIC_SPEED_DIRECTIVES, /最小可执行路径|最小路径/);
    assert.match(GENERIC_SPEED_DIRECTIVES, /smoke test/);
    assert.match(GENERIC_SPEED_DIRECTIVES, /复用工作区里同域技能/);
    assert.match(GENERIC_SPEED_DIRECTIVES, /SKILL\.md 目标 ≤180 行/);
    assert.match(GENERIC_SPEED_DIRECTIVES, /references 最多 1 个/);
    assert.match(GENERIC_SPEED_DIRECTIVES, /2–3 条区分性断言/);
    assert.match(GENERIC_SPEED_DIRECTIVES, /20–30 分钟/);
    assert.notEqual(GENERIC_SPEED_DIRECTIVES, EFFICIENCY_DIRECTIVES);
  });

  test('generic eval rounds are capped by fast mode, explicit config wins', () => {
    assert.equal(maxEvalRoundsForKind('generic', { genericFastMode: true }), 1);
    assert.equal(maxEvalRoundsForKind('generic', { genericFastMode: true, genericMaxEvalRounds: 2 }), 2);
    assert.equal(maxEvalRoundsForKind('generic', { genericMaxEvalRounds: 0 }), 0, '0 still disables evaluation');
    assert.equal(maxEvalRoundsForKind('generic', {}), 3, 'no fast mode keeps the quality loop');
    assert.equal(maxEvalRoundsForKind('generic', { maxEvalRounds: 2 }), 2);
    assert.equal(maxEvalRoundsForKind('huawei', { genericFastMode: true, maxEvalRounds: 3 }), 3, 'Huawei is unaffected');
    assert.equal(maxEvalRoundsForKind('huawei', { maxEvalRounds: 0 }), 0);
  });

  test('the runner appends the generic directives to creation AND fix prompts only', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'core', 'runner.mjs'), 'utf8');
    assert.match(source, /kind === 'generic' \? `\\n\\n\$\{GENERIC_SPEED_DIRECTIVES\}`/);
    assert.match(source, /run\.kind === 'generic' \?/);
    assert.match(source, /maxEvalRounds: roundsFor\(kind\)/);
    // The evaluation agent must not receive creation directives.
    const evaluationPrompt = source.slice(source.indexOf('spawnAgent(run, \'evaluator\''));
    assert.doesNotMatch(evaluationPrompt.slice(0, 2500), /GENERIC_SPEED_DIRECTIVES/);
  });

  test('bundle and desktop profile enable the fast generic policy', () => {
    const bundle = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
    assert.match(bundle, /genericFastMode:\s*true/);
    assert.match(bundle, /genericMaxEvalRounds:\s*1/);
  });

  test('missing generic fixture can be scaffolded from documented read-only commands', () => {
    const md = [
      '# demo',
      '```bash',
      'python3 scripts/list.py',
      'python3 scripts/list.py --group porcelain',
      'python3 scripts/list.py --format md -o out.md',
      'git commit -m "nope"',
      '```',
      '```bash',
      'python3 scripts/list.py --filter rebase',
      '```',
    ].join('\n');
    const fixture = buildGenericEvalFixture(md);
    assert.ok(fixture && Array.isArray(fixture.evals));
    assert.equal(fixture.evals.length, 3);
    assert.deepEqual(fixture.evals.map((e) => e.id), ['TC-01', 'TC-02', 'TC-03']);
    assert.ok(fixture.evals.every((e) => /^python3 scripts\/list\.py/.test(e.prompt.match(/`([^`]+)`/)[1])));
    assert.ok(!fixture.evals.some((e) => e.prompt.includes('-o out.md') || e.prompt.includes('git commit')));
    assert.equal(buildGenericEvalFixture('no commands here'), null);
  });

  test('evaluation parser tolerates prose/fences around the structured result', () => {
    const text = '分析完成。\n\n```json\n{"functionalUsable":true,"triggerSufficiency":1,"cases":[{"id":"TC-01","fixture":true,"command":"x","status":"pass","evidence":"ok"}],"notes":"done"}\n```\n\n以上。';
    const parsed = parseEvaluationOutput(text);
    assert.ok(parsed);
    assert.equal(parsed.functionalUsable, true);
    assert.equal(parsed.cases.length, 1);
    assert.equal(parsed.cases[0].fixture, true);
    assert.equal(parsed.notes, 'done');
  });
});