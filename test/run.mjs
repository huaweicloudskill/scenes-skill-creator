#!/usr/bin/env node
/**
 * Explicit test entry point.
 *
 * `node --test` (with no path) would also execute the bridge's `mock-server.mjs`/`probe.js`
 * helpers, which start a server and wait forever. This runner passes only the `*.test.mjs`
 * files so the suite is deterministic on every Node version that supports `--test`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = [];
for (const dir of ['host', 'bridge', 'client']) {
  for (const name of fs.readdirSync(path.join(here, dir)).sort()) {
    if (name.endsWith('.test.mjs')) files.push(path.join(here, dir, name));
  }
}
if (!files.length) { console.error('no test files found'); process.exit(1); }
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);