/**
 * test/bridge/mock-server.mjs — 纯 Node（零依赖）mock Host，给无头浏览器跑 bridge 用。
 *
 * 提供：
 *   GET  /scenes-skill-creator/app/              → assets/panel.html（注入 bridge + probe）
 *   GET  /scenes-skill-creator/app/panel-bridge.js
 *   GET  /scenes-skill-creator/app/__probe.js    → test/bridge/probe.js
 *   GET  /scenes-skill-creator/api/status        → { ok, revision, catalog, creators }
 *   GET  /scenes-skill-creator/api/catalog?path=skills[/<domain>]
 *   GET  /scenes-skill-creator/api/run           → { ok, runs:[run] }
 *   GET  /scenes-skill-creator/api/run?id=<id>   → { ok, run }（每次轮询推进一个阶段）
 *   POST /scenes-skill-creator/api/run           → body { spec }，只接受 generic / huawei
 *   DELETE /scenes-skill-creator/api/run?id=     → 删除已结束记录（运行中 409）
 *   POST /scenes-skill-creator/api/cancel        → body { id }
 *   GET  /__requests                             → 测试用请求日志（含 POST body）
 *
 * run 生命周期按「轮询次数」推进（不依赖真实时钟，虚拟时间下也确定）：
 *   creating(stage0) → creating(stage1，阶段推进) → evaluating(stage2) → done(stage3，带评分)
 * 因此 1s 轮询通常第 3 次就能看到终态（虚拟时间下 <1s 真实耗时）。
 * 带 `取消测试` / 名字含 cancel 的 spec 会创建一个 stuck run（永远 creating），用于测取消。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const APP_PREFIX = '/scenes-skill-creator/app';
const API_PREFIX = '/scenes-skill-creator/api';

const PHASES = {
  generic: [
    '阶段 1 · 需求分析',
    '阶段 2 · 设计',
    '阶段 3 · 生成（skill 包 + 模板）',
    '阶段 4 · 验证（规范 + lint 检查点双通过）',
    '阶段 5 · eval 迭代',
  ],
  huawei: [
    'Phase 1 · 需求分析（苏格拉底式问答）',
    'Phase 2 · 技术调研（CLI→SDK→API 三级回退）',
    'Phase 3 · 文档生成（SKILL.md + references + 载体）',
    'Phase 4 · 测试准备（templates/test-vars.json）',
    'Phase 5 · 详细测试（真实执行验证）',
    'Phase 6 · 资源清理与合规检查',
  ],
};

const CREATORS = {
  generic: { skill: 'common-skill-creator', repo: 'grape-dev/grape-skills', branch: 'main', commit: 'aaaaaaaa11111111' },
  huawei: { skill: 'huawei-cloud-skill-creator', repo: 'huaweicloud/huaweicloud-skills', branch: 'master', commit: 'bbbbbbbb22222222' },
};

/** 目录故意包含原型静态 CATALOG 里没有的项（nosql / middleware / cce），证明数据真来自 /catalog。 */
const CATALOG_TREE = {
  skills: ['computing', 'network', 'nosql', 'middleware'],
  'skills/computing': ['ecs', 'cce', 'ims'],
  'skills/network': ['vpc', 'elb'],
  'skills/nosql': ['gaussdb', 'redis'],
  'skills/middleware': ['cce', 'kafka'],
};

function phaseList(kind, activeIndex, allDone) {
  return PHASES[kind].map((title, i) => ({
    id: i + 1,
    title,
    state: allDone ? 'done' : i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending',
  }));
}

function step(kind, text) { return { at: Date.now(), kind, text }; }

function metricsFixture() {
  return {
    tokenTotal: 28550,
    inputTokens: 24100,
    outputTokens: 4450,
    durationSeconds: 58.2,
    toolCalls: 6,
    toolFailCount: 0,
    retryCount: 0,
    cliCallCount: 2,
    sdkCallCount: 0,
    apiCallCount: 1,
    llmCallCount: 5,
    errorCount: 0,
    contextCompressed: false,
    sources: ['token=assistant/message.usage', 'tool失败=tool/result.error'],
  };
}

function dimensionsFixture(score = 9.2) {
  return {
    stability: Number((4 * Math.min(1, score / 10)).toFixed(2)),
    cost: Number((1 * Math.min(1, score / 10)).toFixed(2)),
    efficiency: Number((2 * Math.min(1, score / 10)).toFixed(2)),
    security: Number((3 * Math.min(1, score / 10)).toFixed(2)),
  };
}

function gatesFixture(pass) {
  return [
    { id: 'skill-md:frontmatter', ok: true, enforced: true, detail: 'mock OK' },
    { id: 'fixtures:present', ok: true, enforced: true, detail: 'mock fixture found' },
    { id: 'structure:errors=0', ok: pass, enforced: true, detail: pass ? '0 errors' : 'mock 1 error' },
    { id: 'creator:validate-skill.sh', ok: true, enforced: true, detail: 'mock validate OK' },
  ];
}

function targetFor(kind, spec, id) {
  if (kind === 'huawei' && spec.domain && spec.product && spec.name) {
    return `D:\\skill-temp\\mock-workspace\\skills\\${spec.domain}\\${spec.product}\\${spec.name}`;
  }
  return `D:\\skill-temp\\mock-workspace\\skills\\bridge\\${id}`;
}

/** 一个字段齐全的终态 run（给「初始记录来自 API」用例）。 */
function existingRun({ id, kind, spec, startedAt, status, score, verdict, round = 1 }) {
  const ok = status === 'done';
  const dims = score == null ? null : dimensionsFixture(score);
  return {
    id,
    sessionId: id,
    kind,
    creator: CREATORS[kind].skill,
    commit: CREATORS[kind].commit,
    spec,
    cwd: 'D:\\skill-temp\\mock-workspace',
    target: targetFor(kind, spec, id),
    agentPreset: 'standard',
    permission: { preset: 'danger-full-access', approval: 'never' },
    status,
    error: '',
    phases: phaseList(kind, -1, true),
    steps: [
      step('phase', `mock-启动 ${CREATORS[kind].skill}`),
      step('info', 'mock-工作目录 D:\\skill-temp\\mock-workspace'),
      step('step', 'mock-写入 SKILL.md 与 references/（mock 数据）'),
      step('info', `mock-运行结束：${status}`),
    ],
    startedAt,
    updatedAt: startedAt + 60000,
    endedAt: startedAt + 60000,
    turn: 1,
    round,
    maxEvalRounds: 3,
    passScore: 8.5,
    verdict,
    score,
    dimensions: dims,
    itemScores: null,
    deductions: ok ? [] : [{ item: '稳定性', points: 1.1, reason: 'mock-只读夹具证据不足' }],
    evaluations: score == null ? [] : [{
      round, total: score, verdict: ok ? 'pass' : 'fail', dimensions: dims,
      deductions: [], gates: gatesFixture(ok), at: startedAt + 60000,
    }],
    report: score == null ? '' : `# mock 技能评测报告\n\n- 结论：${ok ? '达标' : '未达标'}\n- 得分：${score}/10\n`,
    checks: { gates: gatesFixture(ok) },
    metrics: metricsFixture(),
    baseline: null,
    stage: 3,
  };
}

function newRun(state, spec) {
  const kind = spec.mode === 'huawei' ? 'huawei' : 'generic';
  const id = `session-mock-${String(++state.seq).padStart(4, '0')}`;
  const stuck = /cancel/i.test(String(spec.name || '')) || String(spec.description || '').includes('取消测试');
  const run = {
    id,
    sessionId: id,
    kind,
    creator: CREATORS[kind].skill,
    commit: CREATORS[kind].commit,
    spec,
    cwd: 'D:\\skill-temp\\mock-workspace',
    target: targetFor(kind, spec, id),
    agentPreset: 'standard',
    permission: { preset: 'danger-full-access', approval: 'never' },
    status: 'creating',
    error: '',
    phases: phaseList(kind, 0, false),
    steps: [
      step('phase', `mock-启动 ${CREATORS[kind].skill} @ ${CREATORS[kind].commit.slice(0, 8)}`),
      step('info', `mock-工作目录 D:\\skill-temp\\mock-workspace · preset standard`),
      step('info', `mock-目标目录 ${targetFor(kind, spec, id)}`),
    ],
    startedAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
    turn: 1,
    round: 1,
    maxEvalRounds: 3,
    passScore: 8.5,
    verdict: null,
    score: null,
    dimensions: null,
    itemScores: null,
    deductions: [],
    evaluations: [],
    report: '',
    checks: null,
    metrics: null,
    baseline: null,
    stage: 0,
    stuck,
  };
  return run;
}

function finalize(run) {
  run.status = 'done';
  run.verdict = 'pass';
  run.score = 9.2;
  run.round = 1;
  run.dimensions = dimensionsFixture(9.2);
  run.deductions = [{ item: '效率', points: 0.25, reason: 'mock-扣分明细（来自 mock evaluator）' }];
  run.evaluations = [{
    round: 1,
    total: 9.2,
    rawTotal: 9.2,
    verdict: 'pass',
    dimensions: run.dimensions,
    deductions: run.deductions,
    gates: gatesFixture(true),
    at: Date.now(),
  }];
  run.checks = { gates: gatesFixture(true) };
  run.metrics = metricsFixture();
  run.report = '# mock 技能评测报告\n\n- 技能：' + (run.spec.name || run.spec.description)
    + '\n- 结论：达标\n- 得分：9.20/10（通过线 8.5）\n- 轮次：1/3\n';
  run.phases = phaseList(run.kind, -1, true);
  run.steps.push(step('phase', 'mock-第 1/3 轮评测开始（通过线 8.5/10）'));
  run.steps.push(step('info', 'mock-评测得分 9.20/10 达标'));
  run.steps.push(step('info', 'mock-运行结束：done'));
  run.updatedAt = Date.now();
  run.endedAt = Date.now();
}

/** Manual retry outcome: one fix + a second evaluation, ending at 9.2 (passed). */
function finalizeRetry(run) {
  run.status = 'done';
  run.verdict = 'pass';
  run.score = 9.2;
  run.round = 2;
  run.maxEvalRounds = 2;
  run.manualRetryCount = 1;
  run.dimensions = dimensionsFixture(9.2);
  run.deductions = [{ item: '效率', points: 0.25, reason: 'mock-第二轮扣分' }];
  run.evaluations = [
    run.evaluations[0],
    {
      round: 2, total: 9.2, rawTotal: 9.2, verdict: 'pass', dimensions: run.dimensions,
      deductions: run.deductions, gates: gatesFixture(true), at: Date.now(),
    },
  ];
  run.checks = { gates: gatesFixture(true) };
  run.metrics = metricsFixture();
  run.report = '# mock 技能评测报告\n\n- 技能：' + (run.spec.name || run.spec.description)
    + '\n- 结论：达标\n- 得分：9.20/10（通过线 8.5）\n- 轮次：2/2（手动复评）\n';
  run.steps.push(step('phase', 'mock-第 2/2 轮评测开始（通过线 8.5/10）'));
  run.steps.push(step('info', 'mock-手动复评得分 9.20/10 达标'));
  run.steps.push(step('info', 'mock-运行结束：done'));
  run.updatedAt = Date.now();
  run.endedAt = Date.now();
}

/** 每次 GET /run?id 推进一个阶段 —— 模拟「运行在 Host 上继续、面板轮询观察」。 */
function advance(run) {
  if (!run || run.stuck) { if (run) { run.updatedAt = Date.now(); } return; }
  if (run.manualRetryCount && (run.stage || 0) >= 4) {
    if (run.status === 'fixing') {
      run.status = 'evaluating';
      run.round = 2;
      run.stage = 5;
      run.steps.push(step('phase', 'mock-第 2/2 轮评测开始（通过线 8.5/10）'));
    } else if (run.status === 'evaluating') {
      run.stage = 6;
      finalizeRetry(run);
    }
    run.updatedAt = Date.now();
    run.lastActivityAt = Date.now();
    return;
  }
  if ((run.stage || 0) >= 3) return;
  run.stage = (run.stage || 0) + 1;
  if (run.stage === 1) {
    run.phases[0].state = 'done';
    if (run.phases[1]) run.phases[1].state = 'active';
    run.steps.push(step('step', 'mock-读取需求与仓库规范，生成待确认问题清单（mock）'));
  } else if (run.stage === 2) {
    run.phases = phaseList(run.kind, -1, true);
    run.status = 'evaluating';
    run.round = 1;
    run.steps.push(step('phase', 'mock-第 1/3 轮评测开始（通过线 8.5/10）'));
  } else if (run.stage === 3) {
    finalize(run);
  }
  run.updatedAt = Date.now();
  run.lastActivityAt = Date.now();
}

function snapshot(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    kind: run.kind,
    creator: run.creator,
    commit: run.commit,
    spec: { ...run.spec },
    cwd: run.cwd,
    target: run.target,
    agentPreset: run.agentPreset,
    permission: { ...run.permission },
    status: run.status,
    error: run.error,
    phases: run.phases.map((p) => ({ ...p })),
    steps: run.steps.map((s) => ({ ...s })),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt,
    turn: run.turn,
    step: run.steps.length,
    lastActivityAt: run.lastActivityAt || run.updatedAt,
    round: run.round,
    maxEvalRounds: run.maxEvalRounds,
    passScore: run.passScore,
    verdict: run.verdict,
    score: run.score,
    dimensions: run.dimensions ? { ...run.dimensions } : null,
    itemScores: run.itemScores,
    deductions: (run.deductions || []).map((d) => ({ ...d })),
    evaluations: (run.evaluations || []).map((e) => ({ ...e })),
    report: run.report,
    checks: run.checks ? JSON.parse(JSON.stringify(run.checks)) : null,
    metrics: run.metrics ? { ...run.metrics } : null,
    baseline: null,
    manualRetryCount: run.manualRetryCount || 0,
    installedPath: run.installedPath || '',
    installedName: run.installedName || '',
    installedAt: run.installedAt || 0,
    retryable: run.kind === 'generic' && run.status === 'below-threshold',
  };
}

function seedExisting(state) {
  const now = Date.now();
  state.runs.set('api-run-existing-generic', existingRun({
    id: 'api-run-existing-generic',
    kind: 'generic',
    spec: { mode: 'generic', description: '把接口文档整理成速查表并生成索引（API 既有记录）' },
    startedAt: now - 3600_000,
    status: 'done',
    score: 8.9,
    verdict: 'pass',
  }));
  state.runs.set('api-run-existing-huawei', existingRun({
    id: 'api-run-existing-huawei',
    kind: 'huawei',
    spec: {
      mode: 'huawei', name: 'huawei-cloud-ecs-manage', domain: 'computing', product: 'ecs',
      description: '查询 ECS 云服务器列表（API 既有记录）',
    },
    startedAt: now - 7200_000,
    status: 'below-threshold',
    score: 7.4,
    verdict: 'below-threshold',
    round: 3,
  }));
}

function seedRetryRun(state) {
  if (state.runs.has('api-run-retry-generic')) return;
  const run = existingRun({
    id: 'api-run-retry-generic',
    kind: 'generic',
    spec: { mode: 'generic', description: '把手写笔记整理成索引（手动复评测试）' },
    startedAt: Date.now() - 120_000,
    status: 'below-threshold',
    score: 7.8,
    verdict: 'below-threshold',
    round: 1,
  });
  run.maxEvalRounds = 1;
  run.manualRetryCount = 0;
  run.deductions = [{ item: '证据', points: 0.7, reason: '第一轮 mock 未达标' }];
  run.evaluations = [{
    round: 1, total: 7.8, rawTotal: 7.8, verdict: 'fail', dimensions: dimensionsFixture(7.8),
    deductions: run.deductions, gates: gatesFixture(false), at: run.startedAt + 60000,
  }];
  run.report = '# mock 技能评测报告\n\n- 结论：未达标\n- 得分：7.8/10\n- 轮次：1/1\n';
  state.runs.set(run.id, run);
}

/* ── HTTP helpers ─────────────────────────────────────────────────────────── */
function send(res, code, body, type) {
  const payload = type && type.indexOf('application/json') === 0 ? JSON.stringify(body) : body;
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
function sendJson(res, code, body) { send(res, code, body, 'application/json; charset=utf-8'); }
function sendText(res, code, text, type) { send(res, code, text, type || 'text/plain; charset=utf-8'); }
function sendFile(res, file, type) {
  let data;
  try { data = fs.readFileSync(file); } catch (err) {
    return sendJson(res, 500, { ok: false, error: `mock: cannot read ${path.basename(file)}: ${err.message}` });
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch (_) { return {}; }
}
function panelHtml() {
  const file = path.join(ASSETS, 'panel.html');
  let html = fs.readFileSync(file, 'utf8');
  const inject = '\n<script src="' + APP_PREFIX + '/panel-bridge.js"></script>'
    + '\n<script src="' + APP_PREFIX + '/__probe.js"></script>\n';
  html = html.indexOf('</body>') >= 0 ? html.replace('</body>', inject + '</body>') : html + inject;
  return html;
}

async function handleApi(state, req, res, url, route, body) {
  const q = url.searchParams;
  if (route === '/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      revision: 'mock-r1',
      catalog: { repo: 'mock/huaweicloud-skills', ref: 'master', root: 'skills', localDir: null, ttlMs: 0, cachedPaths: [] },
      creators: {
        generic: { present: true, skill: CREATORS.generic.skill, branch: CREATORS.generic.branch, commit: CREATORS.generic.commit, files: 12, web: false },
        huawei: { present: true, skill: CREATORS.huawei.skill, branch: CREATORS.huawei.branch, commit: CREATORS.huawei.commit, files: 18, web: false },
      },
    });
  }
  if (route === '/catalog' && req.method === 'GET') {
    const rel = q.get('path') || 'skills';
    const names = CATALOG_TREE[rel];
    if (!names) return sendJson(res, 404, { ok: false, error: `mock: unknown catalog path ${rel}` });
    return sendJson(res, 200, {
      ok: true,
      path: rel,
      source: 'mock',
      fetchedAt: Date.now(),
      cached: false,
      entries: names.map((name) => ({ name, type: 'dir' })),
    });
  }
  if (route === '/install' && req.method === 'POST') {
    const id = body && body.id;
    const run = state.runs.get(id);
    if (!run) return sendJson(res, 404, { ok: false, error: `unknown run: ${id}` });
    if (run.status !== 'done') return sendJson(res, 409, { ok: false, error: 'mock: only finished skills can be installed' });
    const name = String(run.spec.name || (run.kind === 'generic' ? 'mock-generic-skill' : 'mock-huawei-skill'));
    run.installedName = name;
    run.installedPath = `D:\\mock-dsh\\skills\\${name}`;
    run.installedAt = Date.now();
    return sendJson(res, 200, { ok: true, installed: true, name, path: run.installedPath });
  }
  if (route === '/refs' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      source: 'remote',
      stale: false,
      fetchedAt: new Date().toISOString(),
      scenes: {
        huawei: {
          schemaVersion: 1, kind: 'huawei', updatedAt: '2026-11-06',
          cases: [{
            id: 'mock-case-1', title: 'mock 案例', desc: 'mock 案例描述', skills: ['mock-skill'],
            video: 'https://example.com/mock.mp4',
          }],
          skillsByDomain: {
            computing: [{ id: 'mock-compute-1', name: 'mock-compute-skill', desc: 'mock 推荐', tags: ['mock'], repo: 'mock/repo', url: 'https://example.com/mock-skill', views: 10, l2: '计算' }],
            default: [],
          },
        },
        generic: {
          schemaVersion: 1, kind: 'generic', updatedAt: '2026-11-06',
          cases: [
            { id: 'generic-skill-creation', title: '通用 Skill 创建', desc: 'mock 固定案例一', skills: ['common-skill-creator'] },
            { id: 'huawei-cloud-skill-creation', title: '华为云 Skill 创建', desc: 'mock 固定案例二', skills: ['huawei-cloud-skill-creator'] },
          ],
          skills: [{ id: 'mock-generic-1', name: 'common-skill-creator', desc: 'mock 通用推荐', tags: ['skill'], repo: 'mock/repo', url: 'https://example.com/generic', views: 5, l2: '编码开发' }],
        },
      },
      warnings: [],
    });
  }
  if (route === '/run' && req.method === 'GET') {
    const id = q.get('id');
    if (id) {
      const run = state.runs.get(id);
      if (!run) return sendJson(res, 404, { ok: false, error: `unknown run: ${id}` });
      advance(run);
      return sendJson(res, 200, { ok: true, run: snapshot(run) });
    }
    const runs = [...state.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(snapshot);
    return sendJson(res, 200, { ok: true, runs });
  }
  if (route === '/run' && req.method === 'POST') {
    const spec = body && body.spec;
    if (!spec || typeof spec !== 'object') return sendJson(res, 400, { ok: false, error: 'mock: body.spec is required' });
    if (spec.mode !== 'generic' && spec.mode !== 'huawei') {
      return sendJson(res, 400, { ok: false, error: `mock: spec.mode must be generic or huawei (got ${String(spec.mode)})` });
    }
    if (spec.mode === 'generic' && !String(spec.description || '').trim()) {
      return sendJson(res, 400, { ok: false, error: 'mock: generic spec.description is required' });
    }
    if (spec.mode === 'huawei' && !(spec.name && spec.domain && spec.product)) {
      return sendJson(res, 400, { ok: false, error: 'mock: huawei spec requires name/domain/product' });
    }
    // Simulate the real Host's creator fetch + agent spawn: the panel must show a pending
// state during this window and refuse a second start.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const run = newRun(state, spec);
    state.runs.set(run.id, run);
    return sendJson(res, 200, { ok: true, run: snapshot(run) });
  }
  if (route === '/run/retry' && req.method === 'POST') {
    const id = body && body.id;
    const run = state.runs.get(id);
    if (!run) return sendJson(res, 404, { ok: false, error: `unknown run: ${id}` });
    if (run.kind !== 'generic' || run.status !== 'below-threshold') {
      return sendJson(res, 409, { ok: false, error: 'mock: run not retryable' });
    }
    run.manualRetryCount = (run.manualRetryCount || 0) + 1;
    run.maxEvalRounds = Math.max(run.maxEvalRounds || 1, (run.round || 1) + 1);
    run.status = 'fixing';
    run.stage = 4;
    run.verdict = null;
    run.updatedAt = Date.now();
    run.steps.push(step('fix', 'mock-把第一轮扣分交给 creator 修复（手动复评）'));
    return sendJson(res, 200, { ok: true, run: snapshot(run) });
  }
  if (route === '/run' && req.method === 'DELETE') {
    const id = q.get('id');
    const run = state.runs.get(id);
    if (!run) return sendJson(res, 404, { ok: false, error: `unknown run: ${id}` });
    if (run.status === 'creating' || run.status === 'evaluating' || run.status === 'fixing') {
      return sendJson(res, 409, { ok: false, error: 'mock: active run cannot be deleted', run: snapshot(run) });
    }
    state.runs.delete(id);
    return sendJson(res, 200, { ok: true, removed: id });
  }
  if (route === '/cancel' && req.method === 'POST') {
    const run = state.runs.get(String(body && body.id));
    if (!run) return sendJson(res, 404, { ok: false, error: 'unknown run' });
    if (run.status !== 'creating' && run.status !== 'evaluating' && run.status !== 'fixing') {
      return sendJson(res, 404, { ok: false, error: 'run is not active', run: snapshot(run) });
    }
    run.status = 'cancelled';
    run.verdict = null;
    run.steps.push(step('warn', 'mock-已取消'));
    run.updatedAt = Date.now();
    run.endedAt = Date.now();
    return sendJson(res, 200, { ok: true, run: snapshot(run) });
  }
  return sendJson(res, 404, { ok: false, error: `mock: unknown api route ${route}` });
}

async function handle(state, req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;
  const entry = { method: req.method, path: pathname, query: url.search, at: Date.now() };
  state.requests.push(entry);

  let body = null;
  if (req.method === 'POST' || req.method === 'PUT') {
    body = await readBody(req);
    entry.body = body;
  }

  if (req.method === 'GET' && pathname === APP_PREFIX + '/panel-bridge.js') {
    return sendFile(res, path.join(ASSETS, 'panel-bridge.js'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && (pathname === APP_PREFIX + '/' || pathname === APP_PREFIX)) {
    if (url.searchParams.get('case') === 'retry') seedRetryRun(state);
    try {
      return sendText(res, 200, panelHtml(), 'text/html; charset=utf-8');
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `mock: cannot read panel.html: ${err.message}` });
    }
  }
  if (req.method === 'GET' && pathname === APP_PREFIX + '/__probe.js') {
    return sendFile(res, path.join(HERE, 'probe.js'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/__requests') {
    return sendJson(res, 200, { ok: true, requests: state.requests });
  }
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return undefined;
  }
  if (pathname.startsWith(API_PREFIX)) {
    const route = pathname.slice(API_PREFIX.length) || '/';
    try {
      return await handleApi(state, req, res, url, route, body);
    } catch (err) {
      if (!res.headersSent) return sendJson(res, 500, { ok: false, error: `mock: ${err.message}` });
      res.end();
      return undefined;
    }
  }
  return sendJson(res, 404, { ok: false, error: `mock: not found ${pathname}` });
}

/**
 * Start the mock Host.
 * @returns {Promise<{server, port, url, requests, runs, close, reset}>}
 */
export async function startMockServer(options = {}) {
  const state = { runs: new Map(), seq: 0, requests: [] };
  seedExisting(state);
  const server = http.createServer((req, res) => {
    handle(state, req, res).catch((err) => {
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: `mock: ${err && err.message}` });
        else res.end();
      } catch (_) { /* socket already gone */ }
    });
  });
  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch (_) { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port == null ? 0 : options.port, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    get requests() { return state.requests; },
    get runs() { return state.runs; },
    reset() {
      state.runs.clear();
      state.seq = 0;
      state.requests.length = 0;
      seedExisting(state);
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/* 也允许直接 `node mock-server.mjs` 起一个给人看的实例。 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = await startMockServer({ port: Number(process.env.PORT) || 0 });
  console.log(`[mock] panel: ${started.url}${APP_PREFIX}/?case=full`);
  console.log(`[mock] api  : ${started.url}${API_PREFIX}/status`);
  process.on('SIGINT', () => { started.close().then(() => process.exit(0)); });
}