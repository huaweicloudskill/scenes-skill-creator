/**
 * Plugin assembly: `apply()` must register BOTH prefix routes (API + static panel UI) on
 * `ctx.webServer`, resolve `<project root>/assets` from `import.meta.url`, and hand back a
 * disposer that tears them down. Run with a fake Host ctx — no agent, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APPLY_TAG, ASSETS_DIR, PROJECT_ROOT, apply } from '../../src/core/plugin.mjs';

// The mount marker / run records must never touch the operator's real cache.
process.env.DSH_SKILL_CREATOR_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-plugin-'));

/**
 * Minimal Host ctx. `effect(fn)` resolves the returned disposer exactly like cordis does
 * (`effect.then(safeCollect)`), and `webServer.register` records what it was given.
 */
function fakeHost() {
  const registrations = [];
  const listeners = [];
  const disposed = [];
  let disposer = null;
  const ctx = {
    on(event, listener) { listeners.push({ event, listener }); return () => { listeners.length = 0; }; },
    get() { return undefined; },
    webServer: {
      register(options) {
        registrations.push(options);
        return () => { disposed.push(options.path); };
      },
    },
    effect(fn) {
      const result = Promise.resolve(fn());
      result.then((dispose) => { disposer = dispose; });
      return result;
    },
  };
  return { ctx, registrations, disposed, disposer: () => disposer, listeners };
}

const settle = async (predicate, rounds = 100) => {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
};

describe('plugin assembly · API + static panel UI', () => {
  test('project root and assets dir are resolved from THIS module', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@huaweicloud-plugins/scenes-skill-creator');
    assert.equal(ASSETS_DIR, path.join(PROJECT_ROOT, 'assets'));
    assert.ok(fs.existsSync(path.join(ASSETS_DIR, 'panel.html')), 'assets/panel.html must be shipped');
    assert.equal(path.basename(ASSETS_DIR), 'assets');
  });

  test('apply() registers the API and the app prefix, then disposes both', async () => {
    const host = fakeHost();
    await apply(host.ctx, {});
    const ready = await settle(() => host.registrations.length >= 2);
    assert.ok(ready, 'apply() must register two prefix routes');

    const byPath = Object.fromEntries(host.registrations.map((entry) => [entry.path, entry]));
    assert.deepEqual(Object.keys(byPath).sort(), ['/scenes-skill-creator/api', '/scenes-skill-creator/app']);
    assert.equal(byPath['/dsh-skill-creator/api'], undefined, 'the reference plugin prefix must be gone');
    for (const entry of host.registrations) {
      assert.equal(entry.kind, 'prefix');
      assert.equal(typeof entry.handler, 'function');
    }

    assert.ok(await settle(() => typeof host.disposer() === 'function'), 'apply() must return a disposer');
    host.disposer()();
    assert.deepEqual(host.disposed.sort(), ['/scenes-skill-creator/api', '/scenes-skill-creator/app']);
  });

  test('the apply effect has a descriptive tag', () => {
    assert.match(APPLY_TAG, /panel API/);
    assert.match(APPLY_TAG, /panel UI/);
  });
});