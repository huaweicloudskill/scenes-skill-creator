#!/usr/bin/env node
/**
 * dsh-skill-doctor — pre-flight check for a DSH desktop profile that loads this bundle.
 *
 * Why this exists: the Host boot reads the profile manifest with a bare
 * `JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))`. A UTF-8 BOM at the
 * front of that file makes the parse throw `Unexpected token '﻿'` and DSH refuses to
 * start — the whole app, not just this plugin. PowerShell's `Out-File` / `Set-Content`
 * (and `ConvertTo-Json | Out-File`) write UTF-8 **with** BOM by default, so any scripted
 * edit of the profile can reintroduce it silently.
 *
 * Usage:
 *   node bin/dsh-skill-doctor.mjs                  # report only
 *   node bin/dsh-skill-doctor.mjs --fix            # strip BOM, keep a .bak sibling
 *   node bin/dsh-skill-doctor.mjs --profile <dir>  # check another profile
 *
 * Exit: 0 clean, 1 problems found (or remaining after --fix).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BOM = [0xEF, 0xBB, 0xBF];
const PROFILE_PATCH = 'cordis.patch.yml';

const argv = process.argv.slice(2);
const fix = argv.includes('--fix');
const profileArg = argv.indexOf('--profile');
const profileDir = profileArg !== -1 && argv[profileArg + 1]
  ? path.resolve(argv[profileArg + 1])
  : path.resolve(process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop'));

const problems = [];
const notes = [];

function readHead(file) {
  const buf = fs.readFileSync(file);
  return { buf, bom: buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2] };
}

/** Strip a leading UTF-8 BOM in place, leaving a timestamped backup beside it. */
function stripBom(file) {
  const { buf } = readHead(file);
  const backup = `${file}.bak-bom-${Date.now()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, buf.subarray(3));
  return backup;
}

function checkJson(file, label) {
  if (!fs.existsSync(file)) {
    if (label === 'profile manifest') problems.push(`${label} missing: ${file}`);
    return;
  }
  const { buf, bom } = readHead(file);
  if (bom) {
    if (fix) {
      const backup = stripBom(file);
      notes.push(`stripped BOM: ${file} (backup ${path.basename(backup)})`);
    } else {
      problems.push(`BOM in ${label}: ${file}`);
      return;
    }
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    JSON.parse(text);
  } catch (error) {
    problems.push(`invalid JSON in ${label}: ${file} — ${String(error)}`);
  }
}

function checkYaml(file, label) {
  if (!fs.existsSync(file)) return;
  const { bom } = readHead(file);
  if (!bom) return;
  if (fix) {
    const backup = stripBom(file);
    notes.push(`stripped BOM: ${file} (backup ${path.basename(backup)})`);
  } else {
    problems.push(`BOM in ${label}: ${file}`);
  }
}

console.log(`DSH profile: ${profileDir}`);
if (!fs.existsSync(profileDir)) {
  console.error(`profile directory does not exist: ${profileDir}`);
  process.exit(1);
}

// 1. The files the Host parses on boot. The manifest is the fatal one.
checkJson(path.join(profileDir, 'package.json'), 'profile manifest');
checkYaml(path.join(profileDir, PROFILE_PATCH), 'profile patch layer');

// 2. Every bundle listed in the manifest carries its own package.json, also parsed
//    with a bare JSON.parse during layer resolution.
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
} catch { /* already reported above */ }

const bundles = manifest?.dsh?.profile?.bundles ?? [];
if (bundles.length === 0) notes.push('manifest lists no dsh.profile.bundles — the plugin will not load');

// In-box bundles (the @deepseek-ai/* ones) resolve from the DSH installation itself,
// never from the profile — `resolveBundleDir` tries the installation anchor first. Their
// absence from profile node_modules is normal, so only their local copy is inspected.
const IN_BOX = /^@deepseek-ai\//;

for (const name of bundles) {
  const bundleDir = path.join(profileDir, 'node_modules', ...name.split('/'));
  if (!fs.existsSync(path.join(bundleDir, 'package.json'))) {
    if (!IN_BOX.test(name)) problems.push(`bundle not installed: ${name} (expected ${bundleDir})`);
    continue;
  }
  checkJson(path.join(bundleDir, 'package.json'), `bundle manifest (${name})`);
  const bundle = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(bundleDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch { return null; }
  })();
  if (bundle && !bundle.dsh?.bundle) problems.push(`bundle ${name} declares no dsh.bundle in package.json`);
  const patch = bundle?.dsh?.bundle?.patch;
  if (patch) {
    const patchFile = path.resolve(bundleDir, patch);
    if (!fs.existsSync(patchFile)) problems.push(`bundle ${name} patch layer missing: ${patchFile}`);
    else checkYaml(patchFile, `bundle patch (${name})`);
  }
}

// 3. This plugin in particular: the panel UI is served from its own assets directory.
const selfName = '@huaweicloud-plugins/scenes-skill-creator';
if (bundles.includes(selfName)) {
  const selfDir = path.join(profileDir, 'node_modules', ...selfName.split('/'));
  for (const rel of ['src/client.js', 'src/core/plugin.mjs', 'assets/panel.html', 'assets/panel-bridge.js', 'cordis.patch.yml', 'icon.svg']) {
    if (!fs.existsSync(path.join(selfDir, rel))) problems.push(`missing in ${selfName}: ${rel}`);
  }
}

for (const note of notes) console.log(`  · ${note}`);

if (problems.length === 0) {
  console.log('OK — profile is readable and every bundle resolves.');
  process.exit(0);
}

console.error(`\n${problems.length} problem(s):`);
for (const problem of problems) console.error(`  ✗ ${problem}`);
console.error('\nRe-run with --fix to strip BOMs automatically; anything else needs a repair by hand.');
process.exit(1);