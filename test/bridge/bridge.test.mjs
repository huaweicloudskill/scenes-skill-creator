/**
 * test/bridge/bridge.test.mjs — 无头 Edge 跑通 embedded 面板 ↔ mock Host 桥接。
 *
 * 运行：node --test test/bridge/bridge.test.mjs
 * 环境：不联网、不装依赖；Edge 不存在时整组测试 skip（明确 skip，不假绿）。
 *
 * 两个场景：
 *   full   —— 初始记录来自 GET /run（无种子）、通用运行 → 轮询 → 结果页、
 *             记录列表 / 详情日志 / 日志筛选、华为云目录 /catalog、结果页评测报告 tab、
 *             参考案例与视频弹窗、环境页 /status、演示控件隐藏、语言 / 主题、
 *             ?theme= 与宿主 sc-theme postMessage、refreshRuns。
 *   cancel —— 取消走 POST /cancel、回结果页、轮询停止、取消是终局、记录保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMockServer } from './mock-server.mjs';

const APP_PATH = '/scenes-skill-creator/app/';
const API_PATH = '/scenes-skill-creator/api';

function edgeCandidates() {
  return [
    process.env.SC_EDGE,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
}

function findEdge() {
  for (const candidate of edgeCandidates()) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) { /* ignore */ }
  }
  return null;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function extractProbe(dom) {
  const match = dom.match(/<pre id="bridge-test">([\s\S]*?)<\/pre>/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(decodeEntities(match[1]));
  } catch (_) {
    return null;
  }
  return parsed;
}

function tail(text, size) {
  const str = String(text || '');
  return str.length > size ? str.slice(str.length - size) : str;
}

const EDGE_TIMEOUT_MS = 60000;
/** 探针在虚拟时间里约 7–10s 内跑完；20s 预算足够且不会让 Edge 空等。 */
const VIRTUAL_TIME_BUDGET = 20000;

function edgeArgs(url, userDataDir) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--mute-audio',
    '--window-size=1460,1180',
    `--user-data-dir=${userDataDir}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET}`,
    '--dump-dom',
    url,
  ];
}

function quoteWin(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

/**
 * 跑一次 Edge：异步 spawn（不是 spawnSync！mock server 在同一个 Node 进程里，
 * spawnSync 会阻塞事件循环 → Edge 的 fetch 永远等不到响应 → 虚拟时间停摆 → 浏览器不退出）。
 *
 * 两种输出重定向方式（都不用 Node 默认 pipe —— Windows 上 Edge 的子进程会继承 pipe 句柄，
 * 浏览器退出后句柄仍开着，捕获就会挂住）：
 *   fds —— spawn + stdio 指向打开的文件（本机首选）
 *   cmd —— `cmd.exe /c "<edge> ... > out.html 2> err.log"` + stdio:'ignore'（沙箱/受限环境兜底）
 */
function runEdgeOnce(edge, url, workDir, mode, tag) {
  const outFile = path.join(workDir, `${tag}-dom.html`);
  const errFile = path.join(workDir, `${tag}-stderr.log`);
  const args = edgeArgs(url, path.join(workDir, `${tag}-profile`));
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timeoutHit = false;
    let outFd = null;
    let errFd = null;
    let child = null;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (outFd !== null) { try { fs.closeSync(outFd); } catch (_) { /* ignore */ } outFd = null; }
      if (errFd !== null) { try { fs.closeSync(errFd); } catch (_) { /* ignore */ } errFd = null; }
      resolve({
        mode,
        tag,
        outFile,
        errFile,
        workDir,
        durationMs: Date.now() - startedAt,
        timeoutHit,
        stdout: readIfExists(outFile),
        stderr: readIfExists(errFile),
        ...extra,
      });
    };
    const killer = setTimeout(() => {
      timeoutHit = true;
      try { if (child) child.kill(); } catch (_) { /* ignore */ }
      /* 再兜底 2s：有些平台上 kill 也要等 */
      setTimeout(() => finish({ status: null, signal: 'SIGKILL', error: new Error(`Edge timed out after ${EDGE_TIMEOUT_MS}ms`) }), 2000);
    }, EDGE_TIMEOUT_MS);

    try {
      if (mode === 'cmd') {
        const line = [edge].concat(args).map(quoteWin).join(' ')
          + ' > ' + quoteWin(outFile) + ' 2> ' + quoteWin(errFile);
        child = spawn('cmd.exe', ['/d', '/s', '/c', line], { stdio: 'ignore', windowsHide: true });
      } else {
        outFd = fs.openSync(outFile, 'w');
        errFd = fs.openSync(errFile, 'w');
        child = spawn(edge, args, { stdio: ['ignore', outFd, errFd], windowsHide: true });
      }
    } catch (error) {
      finish({ status: null, signal: null, error });
      return;
    }
    child.once('error', (error) => finish({ status: null, signal: null, error }));
    child.once('exit', (code, signal) => finish({ status: code, signal, error: undefined }));
  });
}

function isUsable(run) {
  if (!run) return false;
  if (run.error) return false;
  if (!run.stdout || !run.stdout.includes('id="bridge-test"')) return false;
  return true;
}

/**
 * 跑 Edge（失败时换 cmd 重定向兜底）。成功就清掉临时目录；失败保留 artifacts 供诊断。
 */
async function runEdge(edge, url) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bridge-'));
  const attempts = [];
  let run = await runEdgeOnce(edge, url, workDir, 'fds', 'fds');
  attempts.push({ mode: run.mode, status: run.status, error: run.error && run.error.message, timeout: run.timeoutHit, bytes: run.stdout.length });
  if (!isUsable(run)) {
    const fallback = await runEdgeOnce(edge, url, workDir, 'cmd', 'cmd');
    attempts.push({ mode: fallback.mode, status: fallback.status, error: fallback.error && fallback.error.message, timeout: fallback.timeoutHit, bytes: fallback.stdout.length });
    if (isUsable(fallback) || !run.error) run = fallback;
    else run = fallback;
    run.attempts = attempts;
  } else {
    run.attempts = attempts;
  }
  if (isUsable(run)) {
    setTimeout(() => {
      try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* ignore */ }
    }, 1500);
  }
  return run;
}

function diagnostics(label, run, dom, parsed) {
  return [
    `[${label}] mode=${run.mode} edge exit=${run.status} signal=${run.signal || '-'} duration=${run.durationMs}ms timeout=${!!run.timeoutHit}`,
    run.attempts ? `attempts=${JSON.stringify(run.attempts)}` : '',
    run.error ? `spawn error: ${run.error.message}` : '',
    run.outFile ? `dom file: ${run.outFile}` : '',
    run.errFile ? `stderr file: ${run.errFile}` : '',
    `dom bytes=${dom.length} has app-ready=${dom.includes('data-app-ready="1"')} has sc-bridge-ready=${dom.includes('data-sc-bridge="ready"')}`,
    `has bridge-test pre=${dom.includes('id="bridge-test"')}`,
    run.stderr ? `--- stderr (tail) ---\n${tail(run.stderr, 3000)}` : '',
    `--- dom (tail) ---\n${tail(dom, 4000)}`,
  ].filter(Boolean).join('\n');
}

function assertProbe(label, run, dom) {
  assert.equal(run.error, undefined, `${label}: Edge spawn failed: ${run.error && run.error.message}`);
  assert.equal(run.status, 0, `${label}: Edge exited with ${run.status}\n${diagnostics(label, run, dom, null)}`);
  const parsed = extractProbe(dom);
  assert.ok(parsed, `${label}: no parseable <pre id="bridge-test"> in DOM\n${diagnostics(label, run, dom, null)}`);
  assert.notEqual(parsed.pending, true, `${label}: probe never finished (still pending)\n${diagnostics(label, run, dom, parsed)}`);
  if (parsed.errors && parsed.errors.length) {
    assert.fail(`${label}: probe errors:\n${parsed.errors.join('\n')}\n${diagnostics(label, run, dom, parsed)}`);
  }
  for (const [name, check] of Object.entries(parsed.checks || {})) {
    assert.equal(check.ok, true, `${label}: ${name} failed → ${check.detail}\n${diagnostics(label, run, dom, parsed)}`);
  }
  assert.equal(parsed.ok, true, `${label}: probe aggregate ok=false\n${diagnostics(label, run, dom, parsed)}`);
  return parsed;
}

const EDGE = findEdge();

test('bridge: full embedded scenario (no seeds, real run, catalog, refs, env)', { timeout: 300000 }, async (t) => {
  if (!EDGE) {
    t.skip(`Microsoft Edge not found (tried ${edgeCandidates().join(' | ')}); bridge e2e skipped — set SC_EDGE to enable`);
    return;
  }
  const server = await startMockServer();
  t.after(async () => { await server.close(); });

  const run = await runEdge(EDGE, `${server.url}${APP_PATH}?case=full&theme=dark`);
  const dom = run.stdout || '';
  const parsed = assertProbe('full', run, dom);

  /* 服务端断言：请求只打 mock 自己 + 新 API 前缀，且 POST /run 被真实调用 */
  const requests = server.requests;
  assert.ok(requests.length > 0, 'mock server saw no requests');
  const badPrefix = requests.filter((r) => r.path.startsWith('/dsh-skill-creator') || r.path.startsWith('/api/'));
  assert.equal(badPrefix.length, 0, `bridge used a legacy/relative API prefix: ${JSON.stringify(badPrefix)}`);
  assert.ok(requests.some((r) => r.path === `${API_PATH}/status` && r.method === 'GET'), 'GET /status not requested');
  assert.ok(requests.some((r) => r.path === `${API_PATH}/refs` && r.method === 'GET'), 'GET /refs not requested');
  assert.ok(requests.some((r) => r.path === `${API_PATH}/catalog` && r.query.includes('path=skills')), 'GET /catalog?path=skills not requested');
  assert.ok(requests.some((r) => r.path === `${API_PATH}/run` && r.method === 'GET'), 'GET /run not requested');
  const posts = requests.filter((r) => r.path === `${API_PATH}/run` && r.method === 'POST');
  assert.equal(posts.length, 2, `expected 2 POST /run (generic + huawei), got ${posts.length}`);
  assert.deepEqual(posts.map((p) => p.body && p.body.spec && p.body.spec.mode), ['generic', 'huawei']);
  const installs = requests.filter((r) => r.path === `${API_PATH}/install` && r.method === 'POST');
  assert.equal(installs.length, 1, `expected one POST /install, got ${installs.length}`);
  const polls = requests.filter((r) => r.path === `${API_PATH}/run` && r.method === 'GET' && r.query.includes('id='));
  assert.ok(polls.length >= 4, `expected real GET /run?id polling, got ${polls.length}`);

  assert.equal(parsed.case, 'full');
  assert.ok(parsed.samples.length >= 2, 'probe did not observe progress samples');
  const statuses = parsed.samples.map((s) => s.status);
  assert.ok(statuses.includes('creating'), `samples never saw creating: ${statuses.join(',')}`);
  assert.ok(statuses.includes('done'), `samples never saw done: ${statuses.join(',')}`);
});

test('bridge: manual retry after a below-threshold generic run', { timeout: 300000 }, async (t) => {
  if (!EDGE) {
    t.skip(`Microsoft Edge not found (tried ${edgeCandidates().join(' | ')}); bridge e2e skipped — set SC_EDGE to enable`);
    return;
  }
  const server = await startMockServer();
  t.after(async () => { await server.close(); });

  const run = await runEdge(EDGE, `${server.url}${APP_PATH}?case=retry`);
  const dom = run.stdout || '';
  const parsed = assertProbe('retry', run, dom);

  const retries = server.requests.filter((r) => r.path === `${API_PATH}/run/retry` && r.method === 'POST');
  assert.equal(retries.length, 1, `expected one POST /run/retry, got ${retries.length}`);
  assert.equal(retries[0].body && retries[0].body.id, 'api-run-retry-generic');
  const retriedRun = server.runs.get('api-run-retry-generic');
  assert.ok(retriedRun, 'mock server lost the retried run');
  assert.equal(retriedRun.manualRetryCount, 1, 'manual retry count not recorded');
  assert.equal(retriedRun.round, 2, 'second evaluation round not recorded');
  assert.equal(retriedRun.score, 9.2);
  assert.equal(parsed.case, 'retry');
});
  test('bridge: cancel scenario (POST /cancel, polling stops, cancelled is terminal)', { timeout: 300000 }, async (t) => {
  if (!EDGE) {
    t.skip(`Microsoft Edge not found (tried ${edgeCandidates().join(' | ')}); bridge e2e skipped — set SC_EDGE to enable`);
    return;
  }
  const server = await startMockServer();
  t.after(async () => { await server.close(); });

  const run = await runEdge(EDGE, `${server.url}${APP_PATH}?case=cancel`);
  const dom = run.stdout || '';
  const parsed = assertProbe('cancel', run, dom);

  const requests = server.requests;
  const cancels = requests.filter((r) => r.path === `${API_PATH}/cancel` && r.method === 'POST');
  assert.equal(cancels.length, 1, `expected exactly one POST /cancel, got ${cancels.length}`);
  assert.ok(cancels[0].body && typeof cancels[0].body.id === 'string', 'POST /cancel body.id missing');
  const cancelledRun = server.runs.get(cancels[0].body.id);
  assert.ok(cancelledRun, `mock server does not know ${cancels[0].body.id}`);
  assert.equal(cancelledRun.status, 'cancelled');
  assert.equal(parsed.case, 'cancel');
});