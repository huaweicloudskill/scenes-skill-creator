#!/usr/bin/env node
/**
 * Copy the canonical design prototype into the bundle's panel asset.
 *
 * The plugin deliberately has ONE UI source: the external prototype index.html.
 * For release assets the embedded reference snapshot is stripped: references and
 * recommendations must come from the JSON data repository via Host `/refs`, not from
 * data baked into the panel. Pass `--with-snapshot` only for local UI debugging.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argSource = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '';
const source = argSource || process.env.SC_PROTOTYPE_SOURCE;
const withSnapshot = process.argv.includes('--with-snapshot');
const target = path.join(root, 'assets', 'panel.html');

if (!source) {
  console.error('usage: node tools/sync-panel.mjs <prototype index.html> [--with-snapshot]');
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`prototype not found: ${source}`);
  process.exit(1);
}
let html = fs.readFileSync(source, 'utf8');
if (!html.includes('<body>') || !html.includes('id="mode-nav"') || !html.includes('Scenes Skill Creator')) {
  console.error(`refusing to sync: ${source} does not look like the Scenes prototype`);
  process.exit(1);
}
if (!withSnapshot) {
  const empty = 'const API_SNAPSHOT = { fetchedAt: "", huaweiCats: {}, cases: [], reco: { huawei: {} } };';
  const before = html;
  html = html.replace(/(\/\* __API_SNAPSHOT_START__ \*\/)[\s\S]*?(\/\* __API_SNAPSHOT_END__ \*\/)/, `$1\n${empty}\n$2`);
  if (html === before) {
    console.error('refusing to sync: snapshot markers not found (cannot strip embedded reference data)');
    process.exit(1);
  }
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, html, 'utf8');
console.log(`synced ${source} -> ${target} (${Buffer.byteLength(html)} bytes, ${html.split('\n').length} lines${withSnapshot ? ', embedded snapshot kept' : ', embedded snapshot stripped'})`);