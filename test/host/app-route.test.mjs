/**
 * Static panel UI route, tested against a real local HTTP server and a scratch assets dir.
 *
 * A temp directory stands in for `<project root>/assets`, so the suite never depends on (or
 * mutates) the shipped `assets/panel.html` / `assets/panel-bridge.js`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { APP_BASE, PANEL_BRIDGE_PATH, createAppHandler, injectPanelBridge } from '../../src/core/routes.mjs';

const PANEL_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head><meta charset="utf-8"><title>原型面板</title></head>',
  '<body class="app"><div id="root">面板</div></body>',
  '</html>',
].join('\n');
const BRIDGE_JS = '// bridge stub\nwindow.__SC_EMBED__ = true;\n';

const mainAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-assets-'));
fs.writeFileSync(path.join(mainAssets, 'panel.html'), PANEL_HTML);
fs.writeFileSync(path.join(mainAssets, 'panel-bridge.js'), BRIDGE_JS);

// A second assets dir WITHOUT the bridge: the HTML must still be served (its injected
// script 404s), which is exactly the state while the bridge half is still being written.
const bareAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-assets-bare-'));
fs.writeFileSync(path.join(bareAssets, 'panel.html'), PANEL_HTML);

const listen = (handler) => new Promise((resolve, reject) => {
  const server = http.createServer(handler);
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

/** Request one raw path — `http.request` keeps `..` segments intact (fetch would normalise). */
function request(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

let server;
let bareServer;
let port;
let barePort;

before(async () => {
  server = await listen(createAppHandler({ assetsDir: mainAssets }));
  bareServer = await listen(createAppHandler({ assetsDir: bareAssets }));
  port = server.address().port;
  barePort = bareServer.address().port;
});

after(async () => {
  for (const current of [server, bareServer]) {
    if (current) await new Promise((resolve) => current.close(resolve));
  }
  fs.rmSync(mainAssets, { recursive: true, force: true });
  fs.rmSync(bareAssets, { recursive: true, force: true });
});

const countOf = (body, needle) => body.split(needle).length - 1;

describe('static panel UI route · /scenes-skill-creator/app', () => {
  test('the app prefix sits beside the API prefix', () => {
    assert.equal(APP_BASE, '/scenes-skill-creator/app');
    assert.equal(PANEL_BRIDGE_PATH, '/scenes-skill-creator/app/panel-bridge.js');
  });

  test('GET /app/ serves panel.html with the bridge injected once, before </body>', async () => {
    const res = await request(port, `${APP_BASE}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body));
    assert.match(res.body, /<div id="root">面板<\/div>/);
    const tag = `<script src="${PANEL_BRIDGE_PATH}"></script>`;
    assert.equal(countOf(res.body, PANEL_BRIDGE_PATH), 1, 'the bridge must be injected exactly once');
    const tagAt = res.body.indexOf(tag);
    const bodyEndAt = res.body.indexOf('</body>');
    assert.ok(tagAt >= 0, `missing injected script: ${res.body}`);
    assert.ok(bodyEndAt > tagAt, 'the bridge script must sit before </body>');
  });

  test('GET /app/panel.html and /app/index.html serve the same injected page', async () => {
    for (const name of ['panel.html', 'index.html']) {
      const res = await request(port, `${APP_BASE}/${name}`);
      assert.equal(res.status, 200, name);
      assert.match(res.headers['content-type'], /^text\/html; charset=utf-8$/);
      assert.equal(countOf(res.body, PANEL_BRIDGE_PATH), 1, `${name} must carry one bridge tag`);
    }
    // The prefix itself is a valid panel alias too.
    const bare = await request(port, APP_BASE);
    assert.equal(bare.status, 200);
    assert.match(bare.body, /panel-bridge\.js/);
  });

  test('GET /app/panel-bridge.js serves the bridge with a JavaScript content type', async () => {
    const res = await request(port, `${APP_BASE}/panel-bridge.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/javascript; charset=utf-8$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body, BRIDGE_JS);
  });

  test('path traversal and unknown assets are 404s (no filesystem escape)', async () => {
    const traversals = [
      `${APP_BASE}/../panel.html`,
      `${APP_BASE}/%2e%2e/panel.html`,
      `${APP_BASE}/..%2fpanel.html`,
      `${APP_BASE}/nested/panel.html`,
      `${APP_BASE}/secret.txt`,
      `${APP_BASE}/nope.js`,
    ];
    for (const rawPath of traversals) {
      const res = await request(port, rawPath);
      assert.equal(res.status, 404, rawPath);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.doesNotMatch(res.body, /<div id="root">/, `${rawPath} must not leak the panel`);
    }
    // A path outside the prefix is not handled by the app handler at all.
    const outside = await request(port, '/panel.html');
    assert.equal(outside.status, 404);
  });

  test('only GET/HEAD are served', async () => {
    const res = await request(port, `${APP_BASE}/`, 'POST');
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
    const head = await request(port, `${APP_BASE}/`, 'HEAD');
    assert.equal(head.status, 200);
    assert.match(head.headers['content-type'], /^text\/html/);
    assert.equal(head.body, '');
  });

  test('a missing bridge file still serves the panel HTML (its script gets its own 404)', async () => {
    const html = await request(barePort, `${APP_BASE}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.equal(countOf(html.body, PANEL_BRIDGE_PATH), 1, 'the reference is still injected');

    const bridge = await request(barePort, `${APP_BASE}/panel-bridge.js`);
    assert.equal(bridge.status, 404);
    assert.match(bridge.body, /panel-bridge\.js/);
  });
});

describe('injectPanelBridge · pure helper', () => {
  test('injection is idempotent and case-insensitive on </body>', () => {
    const once = injectPanelBridge('<html><BODY>x</BODY></html>');
    assert.match(once, /<script src="\/scenes-skill-creator\/app\/panel-bridge\.js"><\/script><\/BODY>/);
    assert.equal(injectPanelBridge(once), once, 'a second pass must not duplicate the script');
    assert.equal(countOf(once, PANEL_BRIDGE_PATH), 1);
  });

  test('HTML without </body> gets the script appended', () => {
    const injected = injectPanelBridge('<div>only a fragment</div>');
    assert.match(injected, /only a fragment<\/div><script src=/);
  });

  test('createAppHandler requires an assets dir (no accidental cwd serving)', () => {
    assert.throws(() => createAppHandler(), /assetsDir/);
    assert.throws(() => createAppHandler({}), /assetsDir/);
  });
});