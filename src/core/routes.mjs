/**
 * In-host HTTP API for the handoff panel, plus the static panel UI.
 *
 * Registered on `ctx.webServer` (verified: `register({kind, path, handler})`, handler is
 * `(req, res) => void | Promise<void>`), so the API runs INSIDE the Harness host process
 * and can drive agents, skills and the live catalog directly. Consequences:
 *   - same-origin requests from the panel: no port, no CORS, no auth juggling
 *   - no long-lived child process holding stale JavaScript
 *
 * The UI is served from the same prefix mechanism (no generic static-directory service):
 * `GET <APP_BASE>/` → `assets/panel.html`, `GET <APP_BASE>/panel-bridge.js` → the bridge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CREATORS, buildHandoff as defaultBuildHandoff, fetchCreator, kindOfMode, status } from './creators.mjs';
import { validateSkillPackage, summarize } from './validators.mjs';

export const API_BASE = '/scenes-skill-creator/api';

const BASH_CANDIDATES = [
  'bash',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  '/bin/bash',
  '/usr/bin/bash',
];

function commandWorks(command, args) {
  try { return spawnSync(command, args, { stdio: 'ignore', timeout: 5000 }).status === 0; }
  catch { return false; }
}

/** Best-effort environment facts for the prototype's environment page. */
function probeEnvironment() {
  const env = process.env;
  const home = os.homedir();
  const hcloudFiles = [
    path.join(home, '.hcloud', 'config.json'),
    path.join(home, '.hcloud', 'credentials'),
    path.join(home, '.hcloud', 'config'),
  ];
  const cred = Boolean((env.HUAWEICLOUD_SDK_AK && env.HUAWEICLOUD_SDK_SK) || env.HUAWEICLOUD_SDK_AKSK)
    || hcloudFiles.some((file) => { try { return fs.existsSync(file); } catch { return false; } });
  return {
    git: commandWorks('git', ['--version']),
    bash: BASH_CANDIDATES.some((candidate) => commandWorks(candidate, ['--version'])),
    python: commandWorks('python3', ['--version']) || commandWorks('python', ['--version']),
    net: true,
    cacheDays: 3,
    cred,
  };
}

/**
 * Bumped whenever this module's behaviour changes; reported by `GET /status`. That turns
 * "did the reload actually pick up my edit?" into a one-request check instead of a guess —
 * a stale dependency module is otherwise completely silent.
 */
export const API_REVISION = 'scenes-r1';

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Build the handler for one prefix route. */
export function createApiHandler({ runner, catalog, refs, buildHandoff = defaultBuildHandoff }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname.slice(API_BASE.length) || '/';
    try {
      if (route === '/status') {
        return send(res, 200, {
          ok: true,
          revision: API_REVISION,
          catalog: catalog.describe(),
          creators: Object.fromEntries(Object.keys(CREATORS).map((kind) => [kind, status(kind)])),
          environment: probeEnvironment(),
        });
      }
      if (route === '/refs' && req.method === 'GET') {
        if (!refs) return send(res, 503, { ok: false, error: 'refs service is not configured' });
        try {
          return send(res, 200, await refs.snapshot());
        } catch (error) {
          return send(res, 200, {
            ok: false, source: 'none', stale: true,
            scenes: { huawei: null, generic: null },
            warnings: [`refs unavailable: ${String((error && error.message) || error)}`],
          });
        }
      }
      if (route === '/catalog') {
        const rel = url.searchParams.get('path') || undefined;
        const refresh = url.searchParams.get('refresh') === '1';
        try {
          return send(res, 200, { ok: true, ...(await catalog.list(rel, { refresh })) });
        } catch (error) {
          return send(res, 503, { ok: false, error: error.message, catalog: catalog.describe() });
        }
      }
      if (route === '/creator') {
        const kind = kindOfMode(url.searchParams.get('mode') || 'huawei');
        const refresh = url.searchParams.get('refresh') === '1';
        try {
          const current = refresh || !status(kind).present ? await fetchCreator(kind, { refresh }) : status(kind, { fetched: false });
          return send(res, 200, { ok: true, ...current });
        } catch (error) {
          return send(res, 503, { ok: false, error: error.message, ...status(kind) });
        }
      }
      if (route === '/handoff' && req.method === 'POST') {
        const { spec } = await readJson(req);
        const kind = kindOfMode(spec && spec.mode);
        return send(res, 200, { ok: true, kind, creator: status(kind), prompt: buildHandoff(kind, spec || {}) });
      }
      if (route === '/run' && req.method === 'POST') {
        const { spec } = await readJson(req);
        const run = await runner.start(spec || {});
        return send(res, 200, { ok: true, run: runner.get(run.id) });
      }
      if (route === '/run/retry' && req.method === 'POST') {
        const { id } = await readJson(req);
        if (!id) return send(res, 400, { ok: false, error: 'missing id' });
        const result = await runner.manualRetry(id);
        return send(res, result.ok ? 200 : 409, result);
      }
      if (route === '/install' && req.method === 'POST') {
        const { id } = await readJson(req);
        if (!id) return send(res, 400, { ok: false, error: 'missing id' });
        const result = runner.install(id);
        return send(res, result.ok ? 200 : 409, result);
      }
      if (route === '/run' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (id) {
          const run = runner.get(id);
          return run ? send(res, 200, { ok: true, run }) : send(res, 404, { ok: false, error: `unknown run: ${id}` });
        }
        return send(res, 200, { ok: true, runs: runner.list() });
      }
      if (route === '/run' && req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return send(res, 400, { ok: false, error: 'missing id' });
        const run = runner.get(id);
        if (!run) return send(res, 404, { ok: false, error: `unknown run: ${id}` });
        const removed = typeof runner.remove === 'function' ? runner.remove(id) : false;
        return send(res, removed ? 200 : 409, removed
          ? { ok: true, removed: id }
          : { ok: false, error: '运行中的记录不能删除，请先取消', run });
      }
      if (route === '/cancel' && req.method === 'POST') {
        const { id } = await readJson(req);
        const cancelled = await runner.cancel(id);
        return send(res, cancelled ? 200 : 404, { ok: cancelled, run: runner.get(id) });
      }
      if (route === '/validate' && req.method === 'POST') {
        const { path: pkgPath, mode = 'huawei', editMode = false } = await readJson(req);
        const result = validateSkillPackage(pkgPath, { mode, editMode });
        return send(res, 200, { ok: true, issues: result.issues, summary: summarize(result.issues), stats: result.stats });
      }
      return send(res, 404, { ok: false, error: `unknown route: ${route}` });
    } catch (error) {
      return send(res, 500, { ok: false, error: String((error && error.message) || error) });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Static panel UI (`/scenes-skill-creator/app`)
// ─────────────────────────────────────────────────────────────────────────────

export const APP_BASE = '/scenes-skill-creator/app';
/** The bridge script the panel HTML is wired to (written by the client/bridge half). */
export const PANEL_BRIDGE_PATH = `${APP_BASE}/panel-bridge.js`;
const BRIDGE_TAG = `<script src="${PANEL_BRIDGE_PATH}"></script>`;

/**
 * Only these names are served. Everything else — including any path with more than one
 * segment — answers 404, which is also the traversal guard: there is no way to name a file
 * outside the assets directory.
 */
const APP_ASSETS = new Map([
  ['', 'panel.html'],
  ['index.html', 'panel.html'],
  ['panel.html', 'panel.html'],
  ['panel-bridge.js', 'panel-bridge.js'],
]);

function appNotFound(res, message) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

function appContentType(file) {
  return file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8';
}

/**
 * Insert the bridge script before `</body>`. Idempotent: an already-wired panel (or one the
 * bridge half prepared) is returned untouched, so a page can never load the bridge twice.
 * Returns the HTML even when the bridge file is missing — the injected `<script>` then gets
 * its own 404, which must not take the panel down.
 */
export function injectPanelBridge(html) {
  const body = String(html || '');
  if (body.includes(PANEL_BRIDGE_PATH)) return body;
  const close = /<\/body>/i.exec(body);
  if (!close) return `${body}${BRIDGE_TAG}`;
  return `${body.slice(0, close.index)}${BRIDGE_TAG}${body.slice(close.index)}`;
}

/**
 * Build the prefix handler that serves the prototype panel out of `assetsDir`.
 * `assetsDir` is injected (the plugin resolves `<project root>/assets`), which keeps the
 * handler testable against a scratch directory without touching the shipped assets.
 */
export function createAppHandler({ assetsDir } = {}) {
  if (!assetsDir) throw new Error('createAppHandler 需要 assetsDir');
  const root = path.resolve(String(assetsDir));
  return async function handleApp(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Allow: 'GET, HEAD',
        });
        res.end('method not allowed');
        return;
      }
      const raw = String(req.url || '');
      const stop = raw.search(/[?#]/);
      let decoded;
      try { decoded = decodeURIComponent(stop >= 0 ? raw.slice(0, stop) : raw); }
      catch { return appNotFound(res, 'bad path encoding'); }
      if (decoded !== APP_BASE && !decoded.startsWith(`${APP_BASE}/`)) {
        return appNotFound(res, `unknown app route: ${decoded}`);
      }
      const rel = decoded === APP_BASE ? '/' : decoded.slice(APP_BASE.length);
      // Explicit, before any filesystem access: `..`, backslashes and NUL are never valid
      // asset names, so a handled 404 is the only possible outcome.
      if (rel.includes('..') || rel.includes('\\') || rel.includes('\0')) {
        return appNotFound(res, 'path traversal is not allowed');
      }
      const name = rel.replace(/^\/+/, '');
      const file = APP_ASSETS.get(name);
      if (!file) return appNotFound(res, `unknown app asset: ${name || '(empty)'}`);
      const abs = path.resolve(root, file);
      if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
        return appNotFound(res, 'asset outside the assets directory');
      }
      let body;
      try { body = fs.readFileSync(abs); }
      catch { return appNotFound(res, `${file} 不存在（预期 ${abs}；由 bridge 半侧提供）`); }
      const payload = file.endsWith('.html')
        ? Buffer.from(injectPanelBridge(body.toString('utf8')), 'utf8')
        : body;
      res.writeHead(200, {
        'Content-Type': appContentType(file),
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : payload);
    } catch (error) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`panel asset error: ${String((error && error.message) || error)}`);
      } catch { /* the response is already gone */ }
    }
  };
}
