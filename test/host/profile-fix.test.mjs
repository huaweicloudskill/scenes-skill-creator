/**
 * The profile doctor / BOM repair CLI.
 *
 * DSH fails to start when `profiles/<name>/package.json` starts with a UTF-8 BOM. The
 * doctor must report it, refuse to edit without `--fix`, and rewrite a valid BOM-free
 * manifest while leaving a backup.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'bin', 'dsh-skill-doctor.mjs');

const withProfile = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-profile-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const run = (profile, ...args) => spawnSync(process.execPath, [bin, '--profile', profile, ...args], {
  cwd: root, encoding: 'utf8', timeout: 30000,
});

const bomText = (value) => `${String.fromCharCode(0xFEFF)}${JSON.stringify(value)}\n`;

describe('profile doctor · BOM repair', () => {
  test('reports a clean profile', () => withProfile((dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }, null, 2)}\n`);
    const res = run(dir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /OK/);
  }));

  test('detects BOM without --fix and leaves the file untouched', () => withProfile((dir) => {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, bomText({ name: 'profile', dsh: { profile: { bundles: [] } } }), 'utf8');
    const res = run(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BOM/);
    assert.equal(fs.readFileSync(file)[0], 0xEF, 'must not edit without --fix');
  }));

  test('--fix strips BOM, keeps the data and writes a backup', () => withProfile((dir) => {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, bomText({ name: 'profile', dsh: { profile: { bundles: [] } } }), 'utf8');
    const res = run(dir, '--fix');
    assert.equal(res.status, 0);
    assert.match(res.stdout, /stripped BOM/);
    const bytes = fs.readFileSync(file);
    assert.notEqual(bytes[0], 0xEF, 'BOM must be gone');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'profile');
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('package.json.bak-bom-'));
    assert.equal(backups.length, 1, 'fix must leave one backup');
  }));
});