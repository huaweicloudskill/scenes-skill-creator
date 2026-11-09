/**
 * panel-bridge.js — 把原型面板（assets/panel.html）接到 Host 真 API。
 *
 * 原型本身是纯模拟：seedRuns() 造种子记录、setInterval 推进日志、finishCreation() 假评分。
 * 这个文件在原型脚本之后执行，在 embedded 模式下把上面这些替换成 Host 调用，同时
 * **不碰任何布局 / 文案 / 交互结构**（原型 HTML 原样加载，Host 在返回时注入本脚本）。
 *
 * 覆盖点（对应 CONTRACT.md §Bridge）：
 *   1. window.__SC_EMBED__ = true；清种子 / 本地旧记录 / 模拟定时器 / 旧草稿
 *   2. 启动 GET /run 拉真实记录（按 startedAt 倒序）
 *   3. startRun() → POST /run（表单 → Host spec）；返回 run 进 S.live/S.run，view=run
 *   4. 1s GET /run?id=<id> 轮询；终态离开 creating/evaluating/fixing 后停轮询：
 *      正看该 run → view=result + renderAll；否则只刷记录 / 侧栏，不抢视图
 *   5. doCancel() → POST /cancel 后回结果页
 *   6. openRun(id) → GET /run?id=<id> 后按状态进 run/result；hydrateRun 恒等（不伪造）
 *   7. loadRuns() → GET /run；不再读 localStorage / 演示参数
 *   8. 华为云目录 → GET /catalog?path=skills[/<domain>]；失败回退原型 CATALOG 且只提示一次
 *   9. 环境页 → GET /status 成功后六项就绪；失败按离线态
 *  10. 参考案例 / 技能推荐继续用原型内嵌 API_SNAPSHOT（loadLiveRefData 被禁用，发不出外部请求）
 *  11. 所有请求同源相对路径 /scenes-skill-creator/api…；失败转 toast 或静默，不把页面打崩
 *  12. 隐藏 #demo 演示场景控件
 *  13. 暴露 window.__SC_BRIDGE__ = { ready, refreshRuns, api, source: "host" }；
 *      就绪后 document.documentElement.dataset.scBridge = "ready"
 *
 * 页面卸载（pagehide / beforeunload）时清理轮询定时器。
 */
(function () {
  "use strict";

  var API_PREFIX = "/scenes-skill-creator/api";
  var POLL_MS = 1000;
  var ACTIVE = ["creating", "evaluating", "fixing"];
  /** CONTRACT: /status 成功后环境页按「全部就绪」展示（结构不变，只填状态）。 */
  var READY_PREFLIGHT = { git: true, bash: true, python: true, net: true, cacheDays: 3, cred: true };
  /** CONTRACT: /status 失败 → 原型离线态。 */
  var OFFLINE_PREFLIGHT = { git: false, bash: false, python: false, net: false, cacheDays: 0, cred: false };

  if (window.__SC_BRIDGE__ && window.__SC_BRIDGE__.installed) return;

  /* ── 0. 暴露标记（在任何 await 之前同步写好，宿主/测试可立即判定是 embedded） ── */
  window.__SC_EMBED__ = true;
  var protoOk = false;
  try {
    protoOk = typeof S === "object" && S !== null
      && typeof renderAll === "function" && typeof $ === "function"
      && typeof t === "function" && typeof toast === "function";
  } catch (_) { protoOk = false; }

  var bridge = {
    installed: true,
    ready: false,
    source: "host",
    api: null,
    lastError: null,
    refreshRuns: function () { return refreshRuns(); },
    state: function () { return stateSnapshot(); },
  };
  window.__SC_BRIDGE__ = bridge;

  if (!protoOk) {
    /* 没有原型全局（脚本被单独打开 / 被塞进别的页面）：安静退场，不抛错打崩页面。 */
    try { document.documentElement.dataset.scBridge = "unsupported"; } catch (_) {}
    return;
  }

  /* ── 1. 模块内状态 ─────────────────────────────────────────────────────── */
  var pollTimer = null;          // setInterval 句柄（1s 轮询）
  var pollId = null;             // 当前轮询的 run id
  var starting = false;          // startRun 重入保护
  var retrying = false;          // 手动复评重入保护
  var initialised = false;
  var userStart = false;         // 只接受用户真实点击/回车触发 startRun（挡住深链 auto=run）
  var toastSeen = {};            // 「失败只提示一次」的 key 集合
  var catalogSeq = 0;            // 目录请求序号：旧响应不得覆盖新选择
  var fetched = {
    domains: null, products: null, productsDomain: null,
    statusDone: false, statusOk: false,
  };

  /* ── 2. 小工具 ─────────────────────────────────────────────────────────── */
  function msg(zh, en) { return S.lang === "zh" ? zh : en; }
  function errText(err) {
    if (!err) return "unknown error";
    if (typeof err.message === "string" && err.message) return err.message;
    return String(err);
  }
  function safe(label, fn) {
    try { return fn(); } catch (err) {
      bridge.lastError = label + ": " + errText(err);
      try { console.error("[sc-bridge] " + label, err); } catch (_) {}
      return undefined;
    }
  }
  function toastOnce(key, text, kind) {
    if (toastSeen[key]) return;
    toastSeen[key] = true;
    safe("toast", function () { toast(text, kind || undefined); });
  }
  function num(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /* ── 3. 同源 API 封装（所有请求都走 API_PREFIX） ────────────────────────── */
  function urlFor(path) { return API_PREFIX + path; }
  async function readJson(res) {
    try { return await res.json(); } catch (_) { return null; }
  }
  async function apiGet(path) {
    var res = await fetch(urlFor(path), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    var body = await readJson(res);
    if (!res.ok || !body || body.ok === false) {
      var err = new Error((body && body.error) || ("HTTP " + res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
  async function apiPost(path, payload) {
    var res = await fetch(urlFor(path), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify(payload || {}),
    });
    var body = await readJson(res);
    if (!res.ok || !body || body.ok === false) {
      var err = new Error((body && body.error) || ("HTTP " + res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
  async function apiDelete(path) {
    var res = await fetch(urlFor(path), {
      method: "DELETE",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    var body = await readJson(res);
    if (!res.ok || !body || body.ok === false) {
      var err = new Error((body && body.error) || ("HTTP " + res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  /* ── 4. Host run → 原型 S.run 的映射（只补结构，不伪造评分/阶段） ────────── */
  function normalizeDimensions(dim) {
    if (!dim || typeof dim !== "object") return null;
    return {
      stability: num(dim.stability, 0),
      cost: num(dim.cost, 0),
      efficiency: num(dim.efficiency, 0),
      security: num(dim.security, 0),
    };
  }
  function normalizeMetrics(metrics) {
    if (Array.isArray(metrics)) {
      return metrics.filter(function (m) { return m && typeof m === "object"; }).map(function (m) {
        return {
          k: String(m.k == null ? (m.key == null ? (m.name == null ? "" : m.name) : m.key) : m.k),
          v: String(m.v == null ? (m.value == null ? "" : m.value) : m.v),
          limit: m.limit == null ? "" : String(m.limit),
        };
      });
    }
    if (!metrics || typeof metrics !== "object") return [];
    var rows = [];
    Object.keys(metrics).forEach(function (key) {
      if (key === "sources" || key === "baseline") return;
      var value = metrics[key];
      var t = typeof value;
      if (t === "number" || t === "string" || t === "boolean") {
        rows.push({ k: key, v: String(value), limit: "" });
      }
    });
    return rows;
  }
  /** 原型报告页读的是 r.gates（{name, ok}）；Host 把门禁放在 checks.gates（{id, ok, enforced}）。 */
  function normalizeGates(run) {
    var src = Array.isArray(run.gates) ? run.gates
      : (run.checks && Array.isArray(run.checks.gates) ? run.checks.gates : []);
    return src.filter(Boolean).map(function (gate) {
      return {
        name: String(gate.name || gate.id || "gate"),
        ok: gate.ok !== false && gate.enforced !== false,
      };
    });
  }
  function normalizeRun(raw) {
    if (!raw || typeof raw !== "object") return null;
    var kind = raw.kind === "huawei" ? "huawei" : "generic";
    var specRaw = raw.spec && typeof raw.spec === "object" ? raw.spec : {};
    var spec = { mode: kind, description: String(specRaw.description == null ? "" : specRaw.description) };
    if (specRaw.name) spec.name = String(specRaw.name);
    if (specRaw.domain) spec.domain = String(specRaw.domain);
    if (specRaw.product) spec.product = String(specRaw.product);

    var startedAt = num(raw.startedAt, Date.now());
    var lastActivityAt = num(raw.lastActivityAt, num(raw.updatedAt, startedAt));
    var run = {
      id: String(raw.id || ""),
      sessionId: raw.sessionId == null ? "" : String(raw.sessionId),
      kind: kind,
      creator: raw.creator == null ? "" : String(raw.creator),
      commit: raw.commit == null ? "" : String(raw.commit),
      spec: spec,
      cwd: raw.cwd == null ? "" : String(raw.cwd),
      target: raw.target == null ? "" : String(raw.target),
      agentPreset: raw.agentPreset == null ? "standard" : String(raw.agentPreset),
      permission: raw.permission && typeof raw.permission === "object"
        ? { preset: String(raw.permission.preset || "danger-full-access"), approval: String(raw.permission.approval || "never") }
        : { preset: "danger-full-access", approval: "never" },
      status: String(raw.status || "creating"),
      error: raw.error == null ? "" : String(raw.error),
      startedAt: startedAt,
      lastActivityAt: lastActivityAt,
      endedAt: num(raw.endedAt, num(raw.updatedAt, lastActivityAt)),
      turn: num(raw.turn, 1),
      step: num(raw.step, 0),
      round: num(raw.round, 1),
      maxEvalRounds: num(raw.maxEvalRounds, 3),
      manualRetryCount: num(raw.manualRetryCount, 0),
      retryable: raw.retryable === true || (raw.retryable !== false && kind === 'generic'
        && String(raw.status || '') === 'below-threshold'
        && Array.isArray(raw.evaluations) && raw.evaluations.length > 0),
      installedPath: raw.installedPath == null ? '' : String(raw.installedPath),
      installedName: raw.installedName == null ? '' : String(raw.installedName),
      installedAt: num(raw.installedAt, 0),
      passScore: num(raw.passScore, 8.5),
      verdict: raw.verdict == null ? null : String(raw.verdict),
      score: raw.score == null || !Number.isFinite(Number(raw.score)) ? null : Number(raw.score),
      dimensions: normalizeDimensions(raw.dimensions),
      itemScores: Array.isArray(raw.itemScores) ? raw.itemScores.slice() : null,
      deductions: Array.isArray(raw.deductions) ? raw.deductions.filter(Boolean).map(function (d) {
        return { item: String(d.item || ""), points: num(d.points, 0), reason: String(d.reason || "") };
      }) : [],
      evaluations: Array.isArray(raw.evaluations) ? raw.evaluations.filter(Boolean).map(function (e) {
        return {
          round: num(e.round, 1),
          total: num(e.total, 0),
          verdict: e.verdict == null ? null : String(e.verdict),
          dimensions: normalizeDimensions(e.dimensions),
          at: num(e.at, startedAt),
        };
      }) : [],
      report: typeof raw.report === "string" ? raw.report : "",
      checks: raw.checks && typeof raw.checks === "object" ? raw.checks : null,
      metrics: normalizeMetrics(raw.metrics),
      gates: normalizeGates(raw),
      /* 原型结果页「评测报告」tab 会直接 r.excluded.map(...)；Host 快照没有这个字段。
         有值就用（兼容未来的 checks.excluded），没有就先给空数组，渲染前由
         prepareRunForRender 用原型 excludedData()（按当前语言）补上。 */
      excluded: Array.isArray(raw.excluded)
        ? raw.excluded.map(String)
        : (raw.checks && Array.isArray(raw.checks.excluded) ? raw.checks.excluded.map(String) : []),
      /* Host 快照里没有文件统计：默认 0，避免原型结果页出现 undefined/NaN（不伪造数据）。 */
      files: num(raw.files, 0),
      bytes: num(raw.bytes, 0),
    };

    var phasesSrc = Array.isArray(raw.phases) ? raw.phases : [];
    run.phases = phasesSrc.filter(Boolean).map(function (p) {
      var state = p.state === "done" || p.state === "active" ? p.state : "pending";
      var phase = { title: String(p.title || p.id || "phase"), state: state };
      if (Number.isFinite(Number(p.ms)) && Number(p.ms) > 0) phase.ms = Number(p.ms);
      return phase;
    });
    var stepsSrc = Array.isArray(raw.steps) ? raw.steps : [];
    run.steps = stepsSrc.filter(Boolean).map(function (s) {
      return { at: num(s.at, startedAt), kind: String(s.kind || "info"), text: String(s.text == null ? "" : s.text) };
    });
    return run;
  }
  function normalizeList(body) {
    var arr = body && Array.isArray(body.runs) ? body.runs : [];
    return arr.filter(Boolean).map(normalizeRun).filter(function (r) { return !!r && !!r.id; })
      .sort(function (a, b) { return b.startedAt - a.startedAt; });
  }
  function upsertLocal(run) {
    if (!run || !run.id) return;
    var i = -1;
    for (var k = 0; k < S.runs.length; k++) { if (S.runs[k] && S.runs[k].id === run.id) { i = k; break; } }
    if (i >= 0) S.runs[i] = run;
    else {
      S.runs.unshift(run);
      S.runs.sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
    }
  }

  /* ── 5. 覆盖原型里的模拟函数 ────────────────────────────────────────────── */
  /* 种子记录：embedded 下永远为空（真实记录一律来自 GET /run）。 */
  seedRuns = function () { return []; };
  /* 不再读 localStorage 旧记录；也不再写（Host 才是记录源）。 */
  loadRuns = function () { return null; };
  saveRuns = function () {};
  /* 不再"补全"历史 run 的阶段/评分/报告：Host 给什么就显示什么。 */
  hydrateRun = function (x) { return x; };
  /* 假评分 / 假收尾彻底禁用（真正的状态由轮询从 Host 拿）。 */
  finishCreation = function () { /* embedded: no simulated scoring */ };
  /* 参考案例 / 技能推荐只用内嵌 API_SNAPSHOT，禁止外部网络。 */
  loadLiveRefData = function () { return; };
  /* 远程参考数据（/refs）：参考案例和推荐完全来自 JSON；加载失败时显示空态，不回退内嵌数据。 */
  refCases = function () {
    var scene = S.refData && S.refData[S.mode === "huawei" ? "huawei" : "generic"];
    return (scene && Array.isArray(scene.cases)) ? scene.cases : [];
  };
  refReco = function () {
    if (S.mode === "huawei") {
      var huawei = (S.refData && S.refData.huawei) || {};
      var domain = S.draft.name.domain;
      var list = (huawei.skillsByDomain && (huawei.skillsByDomain[domain] || huawei.skillsByDomain.default)) || [];
      return list.slice(0, 10);
    }
    var generic = (S.refData && S.refData.generic) || {};
    return (Array.isArray(generic.skills) ? generic.skills : []).slice(0, 10);
  };
  /* 目录 / 自检按钮 / 运行控制 / 打开记录全部改成 Host 调用。 */
  runPreflight = function () { return refreshPreflight(); };
  loadProducts = function (domain) { return fetchProducts(domain, false); };
  startRun = function () { return startRunEmbedded(); };
  doCancel = function () { return cancelEmbedded(); };
  openRun = function (id) { return openRunEmbedded(id); };
  retryEval = function () { return retryEvalEmbedded(); };
  installSkill = function () { return installSkillEmbedded(); };
  /* 删除记录：原型的 yes 处理只删内存；这里先调 Host DELETE 持久删除，成功后再跑原处理。 */
  var baseConfirmDelete = confirmDelete;
  confirmDelete = function (id) {
    baseConfirmDelete(id);
    var yes = document.getElementById("dlg-yes");
    if (!yes) return;
    var originalYes = yes.onclick;
    yes.onclick = async function (ev) {
      try {
        await apiDelete("/run?id=" + encodeURIComponent(id));
      } catch (err) {
        toast(msg("删除失败：", "Delete failed: ") + errText(err), "err");
        refreshRuns();
        return;
      }
      if (originalYes) originalYes.call(this, ev);
    };
  };

  /* 结果页 / 运行页对真实 run 做结构兜底（报告页读 gates/metrics/excluded；
     它们不在 Host 快照里，缺了会把整页渲染打断）。excluded 每次渲染时按当前语言取。 */
  var baseRenderResult = renderResult;
  renderResult = function () {
    prepareRunForRender(S.run);
    return baseRenderResult.apply(this, arguments);
  };
  var baseRenderRun = renderRun;
  renderRun = function () {
    prepareRunForRender(S.run);
    return baseRenderRun.apply(this, arguments);
  };
  function prepareRunForRender(run) {
    if (!run || typeof run !== "object") return;
    if (!Array.isArray(run.gates)) run.gates = normalizeGates(run);
    if (!Array.isArray(run.metrics)) run.metrics = normalizeMetrics(run.metrics);
    if (!Array.isArray(run.deductions)) run.deductions = [];
    if (!Array.isArray(run.evaluations)) run.evaluations = [];
    if (!Array.isArray(run.excluded) || run.excluded.length === 0) {
      run.excluded = safe("excluded", function () { return excludedData(); }) || [];
    }
    if (!Number.isFinite(run.files)) run.files = 0;
    if (!Number.isFinite(run.bytes)) run.bytes = 0;
    if (typeof run.report !== "string") run.report = "";
    if (run.dimensions) run.dimensions = normalizeDimensions(run.dimensions);
    if (run.score != null && !Number.isFinite(Number(run.score))) run.score = null;
    if (!Array.isArray(run.phases)) run.phases = [];
    if (!Array.isArray(run.steps)) run.steps = [];
  }

  /* ── 6. 记录 / 轮询 ─────────────────────────────────────────────────────── */
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pollId = null;
  }
  function startPolling(id) {
    stopPolling();
    pollId = id;
    pollTimer = setInterval(function () { pollOnce(id); }, POLL_MS);
  }
  async function pollOnce(id) {
    if (!pollId || pollId !== id) return;
    var body;
    try {
      body = await apiGet("/run?id=" + encodeURIComponent(id));
    } catch (err) {
      if (err && err.status === 404 && pollId === id) stopPolling();
      return;
    }
    if (pollId !== id) return;
    var run = normalizeRun(body.run);
    if (!run || !run.id) return;
    applyPolledRun(run);
  }
  function statusToast(run) {
    if (run.status === "failed") return t("failed");
    if (run.status === "cancelled") return t("cancelled");
    if (run.status === "interrupted") return t("interrupted");
    if (run.status === "done") return t("done");
    if (run.status === "below-threshold") return t("verdictFail");
    return statusLabel(run.status);
  }
  function applyPolledRun(run) {
    var id = run.id;
    var active = ACTIVE.indexOf(run.status) !== -1;
    var viewingThis = !!(S.run && S.run.id === id);
    var onRunPage = S.view === "run" || S.view === "result";
    var watching = viewingThis && onRunPage;

    if (active) {
      S.live = run;
    } else {
      S.live = null;
      stopPolling();
    }
    if (viewingThis) S.run = run;
    upsertLocal(run);

    if (active) {
      safe("poll-render", function () {
        renderSidebar();
        if (S.view === "run" && viewingThis) renderRun();
        else if (S.view === "result" && viewingThis) renderResult();
        else if (S.view === "records") renderRecords();
      });
      return;
    }
    safe("poll-finish", function () {
      if (watching) {
        S.run = run;
        S.view = "result";
        renderAll();
        focusAnchor();
      } else {
        renderSidebar(true);
        renderRecords();
        if (S.view === "records") renderRecords(true);
      }
      toast(statusToast(run));
      announce(statusLabel(run.status));
    });
  }
  async function refreshRuns() {
    var runs;
    try {
      runs = normalizeList(await apiGet("/run"));
    } catch (err) {
      toastOnce("runs-refresh", msg("创建记录刷新失败：", "Refresh failed: ") + errText(err), "err");
      return S.runs;
    }
    S.runs = runs;
    safe("refresh-runs", function () {
      renderSidebar(true);
      if (S.view === "records") renderRecords(true);
    });
    return runs;
  }
  async function fetchRunsInitial() {
    try {
      S.runs = normalizeList(await apiGet("/run"));
    } catch (err) {
      S.runs = [];
      toastOnce("runs-init", msg("创建记录读取失败：", "Failed to load runs: ") + errText(err), "err");
    }
    return S.runs;
  }

  /** Latest reference/recommendation data from the public repository (Host /refs). */
  async function fetchRefs() {
    try {
      var body = await apiGet("/refs");
      if (!body || !body.scenes) return;
      S.refData = body.scenes;
      S.refSource = body.source || "none";
      var huawei = body.scenes.huawei || {};
      S.refLive = { cases: (huawei.cases || []).slice(), reco: {} };
      safe("refs-render", function () {
        if (S.view === "form") renderReferences();
      });
    } catch (_) {
      /* keep whatever the prototype snapshot has; Host already serves last-good data */
    }
  }

  /* ── 7. 启动 / 取消 / 打开记录 ─────────────────────────────────────────── */
  function buildSpec(mode) {
    if (mode === "huawei") {
      return {
        mode: "huawei",
        name: "huawei-cloud-" + String((S.draft.name && S.draft.name.suffix) || "").trim(),
        domain: S.draft.name.domain,
        product: S.draft.name.product,
        description: String(S.draft.huawei || "").trim() || t("noSummary"),
      };
    }
    return { mode: "generic", description: String(S.draft.generic || "").trim() };
  }
  function consumeUserStart() {
    var value = userStart;
    userStart = false;
    return value;
  }
  /** Starting = the POST /run round-trip. Only the button changes: spinner + disabled until
   *  Host returns a run, so a second click is impossible (creator fetch + agent spawn first). */
  function setStartPending(on) {
    var btn = $("btn-start");
    if (!btn) return;
    if (on) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = '<span class="spin" aria-hidden="true"></span>' + esc(t("starting"));
    } else {
      btn.removeAttribute("aria-busy");
      btn.disabled = !!startDisabledReason();
      btn.innerHTML = esc(t("start"));
    }
  }
  async function startRunEmbedded() {
    /* 深链参数 auto=run 会在页面脚本里排一个 120ms 的 startRun()：embedded 下必须忽略，
       只有用户真实点击/回车才启动（否则刷新页面会凭空造一次真实运行）。 */
    if (!consumeUserStart()) return;
    if (starting) return;
    if (S.live) { toast(t("alreadyRunning")); return; }
    var reason = startDisabledReason();
    if (reason) { toast(reason); return; }
    var mode = S.mode === "huawei" ? "huawei" : "generic";
    var spec = buildSpec(mode);
    starting = true;
    try {
      setStartPending(true);
      var body = await apiPost("/run", { spec: spec });
      var run = normalizeRun(body.run);
      if (!run || !run.id) throw new Error("Host returned no run");
      setStartPending(false);
      S.live = run;
      S.run = run;
      S.mode = run.kind;
      upsertLocal(run);
      S.view = "run";
      renderAll();
      announce(t("runTitle") + colon() + (run.spec.name || run.spec.description));
      startPolling(run.id);
    } catch (err) {
      setStartPending(false);
      toast(msg("启动创建失败：", "Failed to start: ") + errText(err), "err");
    } finally {
      starting = false;
    }
  }
  async function retryEvalEmbedded() {
    var run = S.run;
    if (!run || run.kind !== 'generic' || run.status !== 'below-threshold' || run.retryable === false) return;
    if (retrying) return;
    retrying = true;
    var btn = $("btn-retry-eval");
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = '<span class="spin" aria-hidden="true"></span>' + esc(t("starting"));
    }
    try {
      var body = await apiPost("/run/retry", { id: run.id });
      var next = normalizeRun(body.run);
      if (!next || !next.id) throw new Error("Host returned no run");
      S.live = next;
      S.run = next;
      S.mode = next.kind;
      upsertLocal(next);
      S.view = "run";
      renderAll();
      announce(t("runTitle") + colon() + (next.spec.name || next.spec.description));
      startPolling(next.id);
    } catch (err) {
      safe("retry-render", renderResult);
      toast(msg("启动复评失败：", "Failed to start re-evaluation: ") + errText(err), "err");
    } finally {
      retrying = false;
    }
  }
  async function installSkillEmbedded() {
    var run = S.run;
    if (!run || !run.id) return;
    var btn = $("btn-install");
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = '<span class="spin" aria-hidden="true"></span>' + esc(t("installing"));
    }
    try {
      var body = await apiPost("/install", { id: run.id });
      run.installedPath = String(body.path || "");
      run.installedName = String(body.name || "");
      run.installedAt = Date.now();
      if (S.live && S.live.id === run.id) {
        S.live.installedPath = run.installedPath;
        S.live.installedName = run.installedName;
      }
      upsertLocal(run);
      toast(msg("已安装/启用：", "Installed/enabled: ") + (run.installedName || run.installedPath));
      renderResult();
    } catch (err) {
      renderResult();
      toast(msg("安装失败：", "Install failed: ") + errText(err), "err");
    }
  }
  async function cancelEmbedded() {
    var target = S.live || S.run;
    if (!target || !target.id) return;
    var id = target.id;
    try {
      var body = await apiPost("/cancel", { id: id });
      var run = normalizeRun(body.run || target);
      if (!run || !run.id) throw new Error("Host returned no run");
      stopPolling();
      S.live = null;
      upsertLocal(run);
      S.run = run;
      S.view = "result";
      prepareRunForRender(run);
      renderAll();
      focusAnchor();
      toast(t("cancelled"));
      announce(t("cancelled"));
    } catch (err) {
      toast(msg("取消失败：", "Cancel failed: ") + errText(err), "err");
    }
  }
  async function openRunEmbedded(id) {
    if (!id) return;
    id = String(id);
    if (S.live && S.live.id === id) {
      S.run = S.live;
      S.mode = S.live.kind || S.mode;
      S.view = "run";
      renderAll();
      return;
    }
    var run = null;
    try {
      run = normalizeRun((await apiGet("/run?id=" + encodeURIComponent(id))).run);
    } catch (err) {
      var cached = null;
      for (var i = 0; i < S.runs.length; i++) { if (S.runs[i] && S.runs[i].id === id) { cached = S.runs[i]; break; } }
      if (!cached) { toast(msg("打开记录失败：", "Failed to open the run: ") + errText(err), "err"); return; }
      run = cached;
    }
    if (!run || !run.id) return;
    var active = ACTIVE.indexOf(run.status) !== -1;
    upsertLocal(run);
    S.run = run;
    S.mode = run.kind || S.mode;
    S.view = active ? "run" : "result";
    prepareRunForRender(run);
    if (active) { S.live = run; startPolling(run.id); }
    renderAll();
    announce((active ? t("runTitle") : t("resultTitle")) + colon() + (run.spec.name || run.spec.description));
  }

  /* ── 8. 华为云三级目录 ─────────────────────────────────────────────────── */
  function dirNames(body) {
    var entries = body && Array.isArray(body.entries) ? body.entries : [];
    var names = [];
    entries.forEach(function (entry) {
      if (!entry || typeof entry !== "object" || !entry.name) return;
      if (entry.type === "file") return;
      if (entry.type && entry.type !== "dir") return;
      names.push(String(entry.name));
    });
    return names;
  }
  function fallbackProducts(domain) {
    var list = (typeof CATALOG === "object" && CATALOG && CATALOG["skills/" + domain]) || [];
    return Array.isArray(list) ? list.slice() : [];
  }
  function ensureSelection() {
    if (Array.isArray(S.domains) && S.domains.length && S.domains.indexOf(S.draft.name.domain) === -1) {
      S.draft.name.domain = S.domains[0];
    }
    if (Array.isArray(S.products)) {
      if (!S.products.length) S.draft.name.product = "";
      else if (S.products.indexOf(S.draft.name.product) === -1) S.draft.name.product = S.products[0];
    }
  }
  async function fetchDomains(quiet) {
    try {
      var body = await apiGet("/catalog?path=skills");
      var names = dirNames(body);
      if (!names.length) throw new Error("empty catalog entries");
      fetched.domains = names;
      S.domains = names.slice();
      ensureSelection();
      await fetchProducts(S.draft.name.domain, true);
    } catch (err) {
      fetched.domains = null;
      var staticDomains = (typeof CATALOG === "object" && CATALOG && Array.isArray(CATALOG.skills)) ? CATALOG.skills.slice() : [];
      S.domains = staticDomains;
      ensureSelection();
      S.products = fallbackProducts(S.draft.name.domain);
      ensureSelection();
      if (!quiet) toastOnce("catalog", msg("华为云目录读取失败，已回退到内置目录：", "Catalog unavailable, using the built-in fallback: ") + errText(err), "warn");
    }
    safe("catalog-domains-render", function () { if (S.view === "form") renderForm(); });
  }
  async function fetchProducts(domain, quiet) {
    var seq = ++catalogSeq;
    var names = null;
    try {
      var body = await apiGet("/catalog?path=" + encodeURIComponent("skills/" + domain));
      if (seq !== catalogSeq) return;
      names = dirNames(body);
      if (!names.length) throw new Error("empty catalog entries");
      fetched.products = names;
      fetched.productsDomain = domain;
    } catch (err) {
      if (seq !== catalogSeq) return;
      fetched.products = null;
      fetched.productsDomain = null;
      names = fallbackProducts(domain);
      if (!quiet) toastOnce("catalog", msg("华为云目录读取失败，已回退到内置目录：", "Catalog unavailable, using the built-in fallback: ") + errText(err), "warn");
    }
    if (seq !== catalogSeq) return;
    S.products = (names || []).slice();
    ensureSelection();
    safe("catalog-products-render", function () { if (S.view === "form") renderForm(); });
  }

  /* ── 9. 环境自检（GET /status） ────────────────────────────────────────── */
  async function fetchStatus(quiet) {
    var ok = false;
    var body = null;
    try {
      body = await apiGet("/status");
      ok = !!(body && body.ok === true);
    } catch (_) {
      ok = false;
    }
    fetched.statusDone = true;
    fetched.statusOk = ok;
    var env = body && body.environment && typeof body.environment === "object" ? body.environment : null;
    S.preflight = Object.assign({}, ok ? READY_PREFLIGHT : OFFLINE_PREFLIGHT, ok && env ? {
      git: env.git === true,
      bash: env.bash === true,
      python: env.python === true,
      net: env.net === true,
      cacheDays: num(env.cacheDays, 3),
      cred: env.cred === true,
    } : {});
    safe("preflight-render", function () {
      renderPreflight();
      if (S.view === "env") { renderEnvPane(); renderPreflight(); renderSidebar(true); }
      else renderSidebar();
    });
    if (!ok && !quiet) {
      toastOnce("status", msg("Host 状态接口不可用：环境页按离线状态显示", "Host status API unavailable: showing the offline state"), "warn");
    }
    return ok;
  }
  function preflightAllReady() {
    var p = S.preflight || {};
    return !!(p.git && p.bash && p.python && p.net && p.cred);
  }
  async function refreshPreflight() {
    S.preflight = null;
    safe("preflight-skeleton", renderPreflight);
    var ok = await fetchStatus(false);
    if (ok) toast(preflightAllReady()
      ? msg("自检完成：全部就绪", "Preflight: all ready")
      : msg("自检完成：部分环境未就绪", "Preflight: some checks are not ready"));
    return ok;
  }

  /* ── 10. embedded 启动清理 ─────────────────────────────────────────────── */
  function closeDialogQuietly() {
    safe("close-dialog", function () { if (S.dialog && typeof closeDialog === "function") closeDialog(); });
  }
  function purgeLocalState() {
    try {
      store.set("proto.runs", "[]");
      store.set("proto.runs.shadow", "[]");
      store.set("proto.draft", "");
    } catch (_) { /* localStorage 不可用时原型本身也退化为内存 */ }
  }
  function resetEmbeddedState() {
    S.freshMode = false;
    S.noRuns = false;
    S.credSim = false;
    S.demoUi = false;
    S.demo = "success";
    S.apiLive = false;
    S.refLive = { cases: null, reco: {} };
    S.refData = { huawei: { cases: [], skillsByDomain: {} }, generic: { cases: [], skills: [] } };
    S.refSource = "none";
    S.ticker = null;
    S.polling = null;
    S.live = null;
    S.run = null;
    S.runs = [];
    S.domains = null;
    S.products = null;
    S.preflight = null;
    S.mode = "generic";
    S.view = "form";
    S.logFilter = "all";
    S.logFollow = true;
    S.tab = "artifact";
    S.recFilter = "all";
    S.recQuery = "";
    S.draft = { generic: "", huawei: "", name: { domain: "computing", product: "ecs", suffix: "ecs-manage" } };
    S.touched = { desc: false, name: false };
    if (S.timers && typeof S.timers.forEach === "function") {
      S.timers.forEach(function (id) { clearTimeout(id); });
      S.timers.clear();
    }
    stopPolling();
    closeDialogQuietly();
    purgeLocalState();
  }
  function hideDemoControls() {
    /* #demo 是原型演示脚手架；renderAll() 会写它的 innerHTML，所以只能隐藏、不能删。 */
    var wrap = $("demo-wrap");
    if (wrap) { wrap.hidden = true; wrap.style.display = "none"; }
    var select = $("demo");
    if (select) {
      select.hidden = true;
      select.style.display = "none";
      select.setAttribute("aria-hidden", "true");
      select.tabIndex = -1;
    }
    var label = document.querySelector('label[for="demo"]');
    if (label) { label.hidden = true; label.style.display = "none"; }
  }
  function stripDemoParams() {
    try {
      var qs = new URLSearchParams(location.search);
      var strip = ["auto", "dialog", "scenario", "fresh", "noruns", "live", "cred", "demo", "selftest", "flowtest"];
      var changed = false;
      strip.forEach(function (key) {
        if (qs.has(key)) { qs.delete(key); changed = true; }
      });
      if (changed) {
        var search = qs.toString();
        history.replaceState(null, "", location.pathname + (search ? "?" + search : "") + location.hash);
      }
    } catch (_) { /* file:// 等场景下 history 可能不可用 */ }
  }
  /** boot 里还有两个 900ms 的模拟定时器（静态 CATALOG / 假 preflight）；它们读不到句柄，
      只能在之后把真实数据再写回去。 */
  function restoreHostData() {
    if (fetched.domains && fetched.domains.length) S.domains = fetched.domains.slice();
    if (fetched.products && fetched.productsDomain === S.draft.name.domain) S.products = fetched.products.slice();
    ensureSelection();
    if (fetched.statusDone) S.preflight = Object.assign({}, fetched.statusOk ? READY_PREFLIGHT : OFFLINE_PREFLIGHT);
    safe("restore-host-data", function () {
      renderPreflight();
      if (S.view === "env") { renderEnvPane(); renderPreflight(); }
      else if (S.view === "form") renderForm();
      renderSidebar(true);
      if (S.view === "records") renderRecords(true);
      renderReferences();
    });
  }

  /* ── 11. 初始化 ────────────────────────────────────────────────────────── */
  async function initialise() {
    await Promise.all([
      fetchStatus(true),
      fetchRunsInitial(),
      fetchDomains(false),
    ]);
    ensureSelection();
    safe("initial-render", renderAll);
    void fetchRefs();
    if (S.view === "env") safe("initial-env", function () { renderEnvPane(); renderPreflight(); });
    /* 原型 boot 的模拟异步在 900ms 才落地：1050 / 1600 各回写一次真实数据。 */
    setTimeout(function () { restoreHostData(); }, 1050);
    setTimeout(function () { restoreHostData(); }, 1600);
    initialised = true;
    bridge.ready = true;
    document.documentElement.dataset.scBridge = "ready";
  }

  function stateSnapshot() {
    return {
      initialised: initialised,
      view: S.view,
      mode: S.mode,
      live: S.live ? { id: S.live.id, status: S.live.status } : null,
      run: S.run ? {
        id: S.run.id, kind: S.run.kind, status: S.run.status,
        score: S.run.score, verdict: S.run.verdict, spec: S.run.spec,
        round: S.run.round, maxEvalRounds: S.run.maxEvalRounds,
        manualRetryCount: S.run.manualRetryCount, retryable: S.run.retryable,
        installedPath: S.run.installedPath, installedName: S.run.installedName,
        phases: (S.run.phases || []).map(function (p) { return p.title + ":" + p.state; }),
        steps: (S.run.steps || []).length,
      } : null,
      runs: S.runs.map(function (r) {
        return { id: r.id, kind: r.kind, status: r.status, score: r.score };
      }),
      domains: S.domains, products: S.products,
      preflight: S.preflight,
      polling: pollTimer !== null,
      lang: S.lang,
      theme: S.theme,
    };
  }

  /* 只把「用户真实点击开始创建 / 在名称框按回车」算作启动意图。 */
  document.addEventListener("click", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("#btn-start") : null;
    if (el) userStart = true;
  }, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && event.target && event.target.id === "f-name") userStart = true;
  }, true);

  /* DSH 主题变化：iframe 读不到外层主题，由 client 用 postMessage 通知。
     只接受 { type: "sc-theme", theme: "light"|"dark" }；其它消息一律安静忽略。 */
  window.addEventListener("message", function (event) {
    var data = event && event.data;
    if (!data || typeof data !== "object" || data.type !== "sc-theme") return;
    var theme = data.theme;
    if (theme !== "light" && theme !== "dark") return;
    /* 只信任父窗口 / 本窗口（后者让无头测试可以在顶层页面直接投递） */
    if (event.source && event.source !== window.parent && event.source !== window) return;
    if (S.theme === theme) return;
    safe("sc-theme-message", function () { S.theme = theme; renderAll(); });
  });

  /* 记录页「刷新」按钮：真实拉一次 GET /run（原型的 renderAll 只是重绘缓存）。 */
  document.addEventListener("click", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("#btn-reload-runs") : null;
    if (el) void refreshRuns();
  }, true);

  window.addEventListener("pagehide", stopPolling);
  window.addEventListener("beforeunload", stopPolling);

  bridge.api = {
    status: function () { return apiGet("/status"); },
    runs: function () {
      return apiGet("/run").then(function (body) {
        var runs = normalizeList(body);
        runs.forEach(prepareRunForRender);
        return runs;
      });
    },
    run: function (id) {
      return apiGet("/run?id=" + encodeURIComponent(id)).then(function (body) {
        var run = normalizeRun(body.run);
        prepareRunForRender(run);
        return run;
      });
    },
    start: function (spec) {
      return apiPost("/run", { spec: spec }).then(function (body) {
        var run = normalizeRun(body.run);
        prepareRunForRender(run);
        return run;
      });
    },
    cancel: function (id) {
      return apiPost("/cancel", { id: id }).then(function (body) {
        var run = normalizeRun(body.run);
        prepareRunForRender(run);
        return run;
      });
    },
    remove: function (id) { return apiDelete("/run?id=" + encodeURIComponent(id)); },
    catalog: function (path) { return apiGet("/catalog?path=" + encodeURIComponent(path || "skills")); },
  };

  resetEmbeddedState();
  hideDemoControls();
  stripDemoParams();
  document.documentElement.dataset.scBridge = "loading";
  safe("fresh-render", renderAll);
  initialise().catch(function (err) {
    bridge.lastError = "initialise: " + errText(err);
    try { document.documentElement.dataset.scBridge = "error"; } catch (_) {}
  });
})();