import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const client = fs.readFileSync(path.join(root, 'src', 'client.js'), 'utf8');

test('client registers the package id and mounts the prototype panel', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@huaweicloud-plugins/scenes-skill-creator');
  assert.ok(client.includes("id: '@huaweicloud-plugins/scenes-skill-creator'"), 'module id must equal package name');
  assert.ok(client.includes('__ModuleLoader__.load'));
  assert.ok(client.includes('/scenes-skill-creator/app/'), 'iframe must point at the Host panel route');
  assert.ok(client.includes("name: 'main'"), 'main slot');
  assert.ok(client.includes("name: 'sidebar.panellist'"), 'sidebar slot');
  assert.ok(client.includes('PANEL_ID = \'skill-creator\''));
});

test('client has no dependency on the removed REST API mode', () => {
  assert.doesNotMatch(client, /rest-api|标准API|scenes-skill-creator\/api\/run/);
});

test('panel asset is the prototype UI and has no hand-written bridge in it', () => {
  const panel = fs.readFileSync(path.join(root, 'assets', 'panel.html'), 'utf8');
  assert.ok(panel.includes('<body>'));
  assert.ok(panel.includes('id="mode-nav"'));
  assert.ok(panel.includes('Scenes Skill Creator'));
  assert.ok(panel.includes('参考案例'));
  assert.ok(!panel.includes('panel-bridge.js'), 'bridge is injected by the Host at serve time');
  assert.ok(!panel.includes('window.__SC_EMBED__'), 'bridge lives in assets/panel-bridge.js');
});

test('bundle declares the prototype app route and two modes in the patch', () => {
  const hosts = fs.readFileSync(path.join(root, 'src', 'core', 'plugin.mjs'), 'utf8')
    + fs.readFileSync(path.join(root, 'src', 'core', 'routes.mjs'), 'utf8');
  assert.ok(hosts.includes('/scenes-skill-creator/app'));
  assert.ok(hosts.includes('/scenes-skill-creator/api'));
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('generic:'));
  assert.ok(patch.includes('huawei:'));
  assert.ok(!patch.includes('rest-api-skill-creator'), 'no REST API creator in the bundle');
});