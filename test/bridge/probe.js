/**
 * test/bridge/probe.js — 无头浏览器里的端到端断言（mock server 注入到面板末尾）。
 *
 * 用 `?case=full` / `?case=cancel` 选择场景；结果以 JSON 写进 `<pre id="bridge-test">`，
 * 由 bridge.test.mjs 用 Edge --dump-dom 读回断言。
 *
 * 全部断言都走真实 UI：点按钮、改下拉、等 bridge 自己轮询 mock /run。
 */
(function () {
  "use strict";

  var CASE = new URLSearchParams(location.search).get("case") || "none";
  var out = {
    case: CASE,
    ok: false,
    checks: {},
    errors: [],
    samples: [],
    startedAt: Date.now(),
    finishedAt: null,
  };

  var pre = document.createElement("pre");
  pre.id = "bridge-test";
  pre.textContent = JSON.stringify({ case: CASE, ok: false, pending: true });
  document.body.appendChild(pre);

  /* 捕获未处理异常：结果页「评测报告」等交互如果炸了，这里能直接看到。 */
  var pageErrors = [];
  window.addEventListener("error", function (event) {
    pageErrors.push(String(event.message || (event.error && event.error.message) || "unknown error"));
  });
  function recordPageErrors() {
    check("no-page-errors", pageErrors.length === 0, pageErrors.join(" | "));
  }

  /* ── helpers ────────────────────────────────────────────────────────────── */
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function text(el) { return el ? String(el.textContent || "").trim() : ""; }
  function check(name, ok, detail) {
    out.checks[name] = { ok: !!ok, detail: detail === undefined ? "" : String(detail) };
    return !!ok;
  }
  function must(name, ok, detail) {
    if (!check(name, ok, detail)) throw new Error(name + ": " + (detail === undefined ? "" : detail));
    return true;
  }
  async function waitFor(fn, timeoutMs, label, onTick) {
    var deadline = Date.now() + (timeoutMs || 20000);
    var lastErr = null;
    while (Date.now() < deadline) {
      if (onTick) { try { onTick(); } catch (_) { /* ignore sample errors */ } }
      try {
        var value = fn();
        if (value) return value;
      } catch (err) { lastErr = err; }
      await wait(40);
    }
    throw new Error("timeout " + (timeoutMs || 20000) + "ms waiting for " + label
      + (lastErr ? " (last error: " + lastErr.message + ")" : ""));
  }
  function state() {
    return window.__SC_BRIDGE__ && window.__SC_BRIDGE__.state ? window.__SC_BRIDGE__.state() : null;
  }
  function setInput(el, value) {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function setSelect(el, value) {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function optionValues(sel) {
    return sel ? Array.prototype.slice.call(sel.options).map(function (o) { return o.value; }) : [];
  }
  function visible(el) {
    if (!el) return false;
    var rects = el.getClientRects();
    if (!rects || !rects.length) return false;
    var cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }
  async function requests() {
    var res = await fetch("/__requests", { cache: "no-store" });
    var body = await res.json();
    return body.requests || [];
  }
  function lastPost(reqs, suffix) {
    var hits = reqs.filter(function (r) { return r.method === "POST" && r.path.slice(-suffix.length) === suffix; });
    return hits.length ? hits[hits.length - 1] : null;
  }
  function countPolls(reqs, id) {
    return reqs.filter(function (r) {
      return r.method === "GET" && r.path.slice(-4) === "/run" && r.query.indexOf("id=" + encodeURIComponent(id)) !== -1;
    }).length;
  }
  function sample() {
    var s = state();
    if (!s || !s.run) return;
    var last = out.samples[out.samples.length - 1];
    if (last && last.status === s.run.status && last.steps === s.run.steps) return;
    if (out.samples.length > 200) return;
    out.samples.push({ status: s.run.status, steps: s.run.steps });
  }
  function emit() {
    out.finishedAt = Date.now();
    var ok = out.errors.length === 0;
    Object.keys(out.checks).forEach(function (key) {
      if (!out.checks[key].ok) ok = false;
    });
    out.ok = ok;
    pre.textContent = JSON.stringify(out);
  }

  var KNOWN_SEED_IDS = [
    "session-dd921b72", "session-a31f0c55", "session-a32a16c4",
    "session-58c1d0aa", "session-9c02aa17", "session-4d77b1e2",
  ];

  async function waitReady() {
    await waitFor(function () {
      return window.__SC_BRIDGE__ && window.__SC_BRIDGE__.ready === true;
    }, 25000, "window.__SC_BRIDGE__.ready");
    must("bridge-attr-ready", document.documentElement.dataset.scBridge === "ready",
      String(document.documentElement.dataset.scBridge));
  }

  /* ── 场景 full：通用 + 记录/详情/筛选 + 华为云目录 + 环境 + 参考/视频 + 语言/主题 ── */
  async function runFull() {
    await waitReady();

    must("embed-flag", window.__SC_EMBED__ === true, String(window.__SC_EMBED__));
    var bridge = window.__SC_BRIDGE__;
    must("bridge-shape",
      bridge.source === "host" && typeof bridge.refreshRuns === "function" && bridge.api
        && typeof bridge.api.runs === "function" && typeof bridge.api.run === "function"
        && typeof bridge.api.start === "function" && typeof bridge.api.cancel === "function"
        && typeof bridge.api.catalog === "function" && typeof bridge.api.status === "function",
      JSON.stringify(Object.keys(bridge.api || {})));

    /* 1. 初始记录只能来自 GET /run，且没有原型种子 */
    var apiRuns = await bridge.api.runs();
    var st = state();
    var stateIds = st.runs.map(function (r) { return r.id; });
    must("initial-runs-from-api",
      stateIds.length === apiRuns.length && stateIds.join(",") === apiRuns.map(function (r) { return r.id; }).join(","),
      "state=" + stateIds.join(",") + " api=" + apiRuns.map(function (r) { return r.id; }).join(","));
    var seedHit = stateIds.filter(function (id) { return KNOWN_SEED_IDS.indexOf(id) !== -1; });
    must("no-seed-records", seedHit.length === 0, "seed ids still present: " + seedHit.join(","));
    must("no-local-runs",
      localStorage.getItem("proto.runs") === "[]" || localStorage.getItem("proto.runs") === null,
      "proto.runs=" + localStorage.getItem("proto.runs"));
    must("existing-runs-visible",
      stateIds.indexOf("api-run-existing-generic") !== -1 && stateIds.indexOf("api-run-existing-huawei") !== -1,
      stateIds.join(","));

    /* iframe URL 的 ?theme= 走原型原有 boot 逻辑（client 初始 src 带着它） */
    must("initial-theme-from-url",
      state().theme === "dark" && document.documentElement.dataset.theme === "dark",
      "theme=" + state().theme + " root=" + document.documentElement.dataset.theme);

    /* 2. 华为云目录在启动时就来自 /catalog（通用页也先备好） */
    await waitFor(function () {
      var s = state();
      return s.domains && s.domains.indexOf("nosql") !== -1;
    }, 15000, "domains from /catalog (nosql)");
    check("catalog-domains", state().domains.indexOf("middleware") !== -1, state().domains.join(","));

    /* 3. 通用技能：填表单 → 开始创建 → 轮询到结果页 */
    await waitFor(function () { return $("#f-desc") && $("#btn-start"); }, 15000, "generic form");
    await waitFor(function () { return $("#refs") && $("#refs").getAttribute("data-source") === "remote"; }, 15000, "generic remote refs");
    var genericCases = $$("#ref-panel .ref-card");
    check("generic-refs-fixed-cases", genericCases.length === 2 && text($("#ref-panel")).indexOf("通用 Skill 创建") !== -1,
      "cards=" + genericCases.length + " text=" + text($("#ref-panel")).slice(0, 80));
    $('[data-ref-tab="reco"]').click();
    await waitFor(function () { return $$("#ref-panel .ref-card").length > 0; }, 8000, "generic recommendations");
    check("generic-refs-reco", $$("#ref-panel .ref-card").length > 0, "cards=" + $$("#ref-panel .ref-card").length);
    $('[data-ref-tab="cases"]').click();
    setInput($("#f-desc"), "把接口文档整理成速查表并生成目录索引（bridge 全流程测试）");
    await waitFor(function () { var b = $("#btn-start"); return b && !b.disabled; }, 8000, "start button enabled");
    $("#btn-start").click();
    var pendingBtn = $("#btn-start");
    must("start-pending",
      !!pendingBtn && pendingBtn.disabled === true && pendingBtn.getAttribute("aria-busy") === "true"
        && !!pendingBtn.querySelector(".spin") && !$(".start-overlay")
        && pendingBtn.textContent.trim().length > 0,
      pendingBtn ? `disabled=${pendingBtn.disabled} busy=${pendingBtn.getAttribute("aria-busy")} spin=${!!pendingBtn.querySelector(".spin")} overlay=${!!$(".start-overlay")}` : "button gone");
    $("#btn-start").click();   // disabled button: second click must be a no-op
    await waitFor(function () {
      var s = state();
      return s && s.run && s.run.status;
    }, 10000, "generic run created");
    var genericId = state().run.id;
    check("run-view-after-start", state().view === "run", "view=" + state().view);
    check("live-after-start", !!state().live, JSON.stringify(state().live));

    await waitFor(function () {
      var s = state();
      return s && s.view === "result" && s.run && s.run.status === "done";
    }, 30000, "generic run done + result view", function () { sample(); });

    var done = state();
    must("generic-done", done.run.status === "done", done.run.status);
    must("generic-score-from-api", done.run.score === 9.2 && done.run.verdict === "pass",
      "score=" + done.run.score + " verdict=" + done.run.verdict);
    var ringScore = text($("#workspace .ring .val b"));
    must("result-shows-api-score", ringScore === "9.2", "ring=" + ringScore);
    must("result-badge", !!$("#workspace .badge"), "no result badge");
    var installBtn = $("#btn-install");
    must("install-button", !!installBtn, "install/enable button missing");
    installBtn.click();
    await waitFor(function () { return state().run && state().run.installedPath; }, 8000, "install POST applied");
    check("install-path", /skills/.test(state().run.installedPath), state().run.installedPath);
    check("install-button-reinstall", /重新安装|Reinstall/.test(text($("#btn-install"))), text($("#btn-install")));
    var durationText = text($("#workspace .pane-head .sub"));
    var durationMatch = durationText.match(/用时\s*([\d,]+)\s*分钟/) || durationText.match(/([\d,]+)\s*min/);
    var durationMin = durationMatch ? Number(durationMatch[1].replace(/,/g, "")) : NaN;
    check("result-duration", Number.isFinite(durationMin) && durationMin >= 1 && durationMin <= 1440,
      `text="${durationText.slice(0, 60)}" minutes=${Number.isFinite(durationMin) ? durationMin : "n/a"}`);

    var reqsAfterRun = await requests();
    var postRun = lastPost(reqsAfterRun, "/api/run");
    must("post-run-called-generic", !!postRun && postRun.body && postRun.body.spec && postRun.body.spec.mode === "generic",
      postRun ? JSON.stringify(postRun.body) : "no POST /run");
    must("post-run-description", !!postRun && String(postRun.body.spec.description).indexOf("bridge 全流程测试") !== -1,
      postRun ? String(postRun.body.spec.description) : "");
    must("polling-updated-run", countPolls(reqsAfterRun, genericId) >= 2, "polls=" + countPolls(reqsAfterRun, genericId));
    must("polls-saw-progress", out.samples.length >= 2, JSON.stringify(out.samples));
    var statuses = out.samples.map(function (s) { return s.status; });
    check("samples-cover-progress",
      statuses.indexOf("creating") !== -1 && statuses.indexOf("done") !== -1,
      statuses.join(","));

    var detail = await bridge.api.run(genericId);
    must("steps-from-host",
      detail.steps.length > 3 && detail.steps.some(function (s) { return s.text.indexOf("mock-") === 0; }),
      "steps=" + detail.steps.length + " first=" + (detail.steps[0] && detail.steps[0].text));
    var fakeTexts = [];
    try {
      stepTexts("generic").forEach(function (p) { fakeTexts.push(p[1]); });
      stepTexts("huawei").forEach(function (p) { fakeTexts.push(p[1]); });
    } catch (_) { /* 原型存在 stepTexts，这里只是辅助断言 */ }
    var overlapped = detail.steps.filter(function (s) { return fakeTexts.indexOf(s.text) !== -1; });
    must("no-simulated-step-texts", overlapped.length === 0, overlapped.map(function (s) { return s.text; }).join("|"));

    /* 4. 创建记录：列表 + 打开详情 + 日志筛选 */
    var recordsNav = $('[data-nav="records"]');
    must("records-nav", !!recordsNav, "sidebar records nav missing");
    recordsNav.click();
    await waitFor(function () { return state().view === "records" && $("#rec-list"); }, 8000, "records pane");
    var expectedRecs = state().runs.length;
    await waitFor(function () { return $$("#rec-list .rec").length > 0; }, 8000, "records rows");
    must("records-list-count", $$("#rec-list .rec").length === expectedRecs,
      "dom=" + $$("#rec-list .rec").length + " expected=" + expectedRecs);
    var kindSeg = $("#rec-kind");
    must("records-kind-filter", !!kindSeg && kindSeg.querySelectorAll("[data-rk]").length === 3,
      kindSeg ? "buttons=" + kindSeg.querySelectorAll("[data-rk]").length : "kind filter missing");
    kindSeg.querySelector('[data-rk="generic"]').click();
    var genericRows = $$("#rec-list .rec");
    check("records-kind-generic", genericRows.length > 0 && genericRows.every(function (row) {
      var item = state().runs.filter(function (r) { return r.id === row.dataset.open; })[0];
      return item && item.kind === "generic";
    }), "rows=" + genericRows.length);
    kindSeg.querySelector('[data-rk="all"]').click();
    var statusSeg = $("#rec-filter");
    statusSeg.querySelector('[data-rf="active"]').click();
    check("records-status-active", $$("#rec-list .rec").every(function (row) {
      var item = state().runs.filter(function (r) { return r.id === row.dataset.open; })[0];
      return item && ["creating", "evaluating", "fixing"].indexOf(item.status) !== -1;
    }), "active rows=" + $$("#rec-list .rec").length);
    statusSeg.querySelector('[data-rf="bad"]').click();
    check("records-status-bad", $$("#rec-list .rec").every(function (row) {
      var item = state().runs.filter(function (r) { return r.id === row.dataset.open; })[0];
      return item && ["below-threshold", "failed"].indexOf(item.status) !== -1;
    }), "bad rows=" + $$("#rec-list .rec").length);
    statusSeg.querySelector('[data-rf="all"]').click();
    must("records-has-new-run", !!$('#rec-list [data-open="' + genericId + '"]'), "new run not listed");
    $('#rec-list [data-open="' + genericId + '"]').click();
    await waitFor(function () { var s = state(); return s.view === "result" && s.run && s.run.id === genericId; },
      10000, "open run detail from records");
    check("open-run-detail", state().run.id === genericId, JSON.stringify(state().run));

    var detailTab = $('[data-tab="detail"]');
    must("detail-tab", !!detailTab, "detail tab missing");
    detailTab.click();
    await waitFor(function () { return $$("#log .ln").length > 0; }, 8000, "detail log lines");
    var logLines = $$("#log .ln").length;
    check("detail-log-lines", logLines > 0, "lines=" + logLines);
    var phaseFilter = $('[data-f="phase"]');
    must("log-filter-button", !!phaseFilter, "phase filter missing");
    phaseFilter.click();
    await waitFor(function () {
      var lines = $$("#log .ln");
      var kinds = lines.map(function (n) { var k = n.querySelector(".kind"); return text(k); });
      return kinds.length > 0 && kinds.every(function (k) { return k === "phase"; });
    }, 8000, "log filtered to phase", function () { /* retry */ });
    check("log-filter-phase", $$("#log .ln").every(function (n) { return text(n.querySelector(".kind")) === "phase"; }),
      "kinds=" + $$("#log .ln").map(function (n) { return text(n.querySelector(".kind")); }).join(","));

    /* 4b. 删除记录必须落到 Host DELETE，而不是只删面板内存 */
    $('[data-nav="records"]').click();
    await waitFor(function () { return state().view === "records" && $("#rec-list"); }, 8000, "records pane for delete");
    var delBtn = $('#rec-list [data-del="' + genericId + '"]');
    must("delete-button", !!delBtn, "record delete button missing");
    delBtn.click();
    await waitFor(function () { return $("#dlg-yes"); }, 8000, "delete confirm dialog");
    $("#dlg-yes").click();
    await wait(800);
    var afterDelete = await window.__SC_BRIDGE__.api.runs();
    must("delete-persisted", afterDelete.every(function (r) { return r.id !== genericId; }),
      "still listed: " + afterDelete.map(function (r) { return r.id; }).join(","));
    var reqsDelete = await requests();
    must("delete-called-host", reqsDelete.some(function (r) {
      return r.method === "DELETE" && /\/run$/.test(r.path) && String(r.query || "").indexOf(genericId) !== -1;
    }), "no DELETE /run request");

    /* 5. 华为云：目录下拉来自 /catalog，再跑一次真实运行 */
    $('[data-mode="huawei"]').click();
    await waitFor(function () { return state().mode === "huawei" && $("#tax2") && $("#tax3"); }, 10000, "huawei form");
    await waitFor(function () { return optionValues($("#tax2")).indexOf("nosql") !== -1; }, 10000, "tax2 options from /catalog");
    check("tax2-from-catalog", optionValues($("#tax2")).indexOf("nosql") !== -1, optionValues($("#tax2")).join(","));
    setSelect($("#tax2"), "computing");
    await waitFor(function () {
      return state().products && state().products.indexOf("cce") !== -1 && optionValues($("#tax3")).indexOf("cce") !== -1;
    }, 10000, "tax3 options from /catalog");
    check("tax3-from-catalog", optionValues($("#tax3")).indexOf("cce") !== -1, optionValues($("#tax3")).join(","));
    setSelect($("#tax3"), "cce");
    setInput($("#f-name"), "cce-deploy");
    setInput($("#f-desc"), "部署 CCE 集群并输出只读巡检报告（bridge 华为云测试）");
    await waitFor(function () { var b = $("#btn-start"); return b && !b.disabled; }, 8000, "huawei start enabled");
    $("#btn-start").click();
    await waitFor(function () {
      var s = state();
      return s && s.run && s.run.kind === "huawei";
    }, 10000, "huawei run created");
    var huaweiId = state().run.id;
    await waitFor(function () {
      var s = state();
      return s && s.view === "result" && s.run && s.run.id === huaweiId && s.run.status === "done";
    }, 30000, "huawei run done", function () { sample(); });

    var h = state();
    must("huawei-done", h.run.status === "done" && h.run.score === 9.2, JSON.stringify(h.run));
    var reqsHuawei = await requests();
    var huaweiPost = lastPost(reqsHuawei, "/api/run");
    must("post-run-huawei", !!huaweiPost && huaweiPost.body.spec.mode === "huawei", huaweiPost ? JSON.stringify(huaweiPost.body.spec) : "no post");
    var spec = huaweiPost.body.spec;
    check("huawei-spec-fields",
      spec.name === "huawei-cloud-cce-deploy" && spec.domain === "computing" && spec.product === "cce"
        && String(spec.description).indexOf("bridge 华为云测试") !== -1,
      JSON.stringify(spec));
    check("huawei-run-spec", h.run.spec.name === "huawei-cloud-cce-deploy" && h.run.spec.domain === "computing",
      JSON.stringify(h.run.spec));
    must("polling-updated-huawei", countPolls(reqsHuawei, huaweiId) >= 2, "polls=" + countPolls(reqsHuawei, huaweiId));

    /* 5b. 结果页「评测报告」tab：r.gates / r.metrics / r.excluded 都必须是数组，渲染不许抛错 */
    var reportTab = $('[data-tab="report"]');
    must("report-tab", !!reportTab, "report tab missing");
    reportTab.click();
    await waitFor(function () { return $("#btn-copy-report") && $$("#tabpanel table.tbl").length >= 2; },
      8000, "report tab tables");
    var reportTables = $$("#tabpanel table.tbl");
    var gateRows = reportTables[0] ? reportTables[0].querySelectorAll("tbody tr").length : 0;
    var metricRows = reportTables[1] ? reportTables[1].querySelectorAll("tbody tr").length : 0;
    check("report-gates", gateRows > 0, "gate rows=" + gateRows);
    check("report-metrics", metricRows > 0, "metric rows=" + metricRows);
    check("report-excluded", $$("#tabpanel ul li").length > 0, "excluded items=" + $$("#tabpanel ul li").length);
    check("report-rendered", !!$("#btn-copy-report") && !!$("#btn-dl-report"), "report actions missing");
    var huaweiDetail = await bridge.api.run(huaweiId);
    check("report-data-normalized",
      Array.isArray(huaweiDetail.gates) && huaweiDetail.gates.length > 0
        && Array.isArray(huaweiDetail.metrics) && huaweiDetail.metrics.length > 0
        && Array.isArray(huaweiDetail.excluded) && typeof huaweiDetail.report === "string" && huaweiDetail.report.length > 0,
      "gates=" + (huaweiDetail.gates && huaweiDetail.gates.length)
        + " metrics=" + (huaweiDetail.metrics && huaweiDetail.metrics.length)
        + " excluded=" + (huaweiDetail.excluded && huaweiDetail.excluded.length)
        + " report=" + (huaweiDetail.report || "").length);

    /* 6. 参考案例 / 技能推荐 / 视频弹窗仍来自内嵌快照（不发外部请求） */
    $('[data-mode="huawei"]').click();
    await waitFor(function () { return $("#refs") && $("#ref-panel"); }, 8000, "references section");
    must("refs-present", !!$("#refs") && !!$('[data-ref-tab="cases"]') && !!$('[data-ref-tab="reco"]'), "tabs missing");
    await waitFor(function () { return $("#refs").getAttribute("data-source") === "remote"; }, 8000, "remote refs source");
    must("refs-remote-source", $("#refs").getAttribute("data-source") === "remote",
      "#refs data-source=" + $("#refs").getAttribute("data-source"));
    await waitFor(function () { return $$("#ref-panel .ref-card").length > 0; }, 8000, "reference case cards");
    check("refs-cards", $$("#ref-panel .ref-card").length > 0, "cards=" + $$("#ref-panel .ref-card").length);
    var videoBtn = $("#ref-panel [data-ref-video]");
    must("refs-video-button", !!videoBtn, "case video button missing");
    videoBtn.click();
    await waitFor(function () { return $("#ref-video-player") && $("#backdrop"); }, 8000, "case video dialog");
    check("refs-video-dialog", !!$("#ref-video-player"), "video element missing");
    $("#dlg-video-close").click();
    await waitFor(function () { return !$("#backdrop"); }, 8000, "video dialog closed");
    check("refs-video-closed", !$("#backdrop"), "dialog still open");

    /* 7. 环境页：GET /status 成功后六项就绪（结构不变，不再有骨架） */
    $('[data-nav="env"]').click();
    await waitFor(function () { return state().view === "env" && $("#preflight .pf-row"); }, 8000, "env pane");
    await waitFor(function () { return $$("#preflight .pf-row").length === 6; }, 8000, "six preflight rows");
    var okRows = $$("#preflight .pf-row .chip.ok").length;
    must("preflight-six-rows", $$("#preflight .pf-row").length === 6, "rows=" + $$("#preflight .pf-row").length);
    must("preflight-all-ready", okRows === 6, "ok rows=" + okRows);
    check("preflight-no-skeleton", $$("#preflight .skel").length === 0, "skel=" + $$("#preflight .skel").length);
    var pf = state().preflight;
    check("status-preflight-fields",
      pf && pf.git === true && pf.bash === true && pf.python === true && pf.net === true
        && pf.cacheDays === 3 && pf.cred === true,
      JSON.stringify(pf));

    /* 8. 只隐藏演示控件，其它顶栏/导航/语言/主题保留 */
    var demo = $("#demo");
    var demoWrap = $("#demo-wrap");
    must("demo-hidden", !!demo && !visible(demo) && (!demoWrap || !visible(demoWrap)),
      "demo visible=" + visible(demo) + " wrap=" + visible(demoWrap));
    must("appbar-kept", !!$(".appbar #btn-lang") && !!$(".appbar #btn-theme") && !!$("#mode-nav"), "topbar/menu missing");

    /* 9. refreshRuns 公开方法真实拉取 */
    var refreshed = await window.__SC_BRIDGE__.refreshRuns();
    must("refresh-runs", Array.isArray(refreshed) && refreshed.length === state().runs.length,
      "returned=" + (refreshed && refreshed.length) + " state=" + state().runs.length);
    var reqsRefresh = await requests();
    check("refresh-runs-http", reqsRefresh.filter(function (r) { return r.path.slice(-4) === "/run" && r.method === "GET"; }).length >= 2,
      "GET /run count=" + reqsRefresh.filter(function (r) { return r.path.slice(-4) === "/run" && r.method === "GET"; }).length);

    /* 10. 语言 / 主题按钮仍然工作 */
    $("#btn-lang").click();
    await waitFor(function () { return state().lang === "en" && document.documentElement.lang === "en"; }, 8000, "language switch");
    check("lang-switch", state().lang === "en", "lang=" + state().lang);
    $("#btn-lang").click();
    await waitFor(function () { return state().lang === "zh"; }, 8000, "language switch back");
    var themeBefore = state().theme;
    $("#btn-theme").click();
    await waitFor(function () { return state().theme !== themeBefore; }, 8000, "theme switch");
    check("theme-switch",
      state().theme !== themeBefore && document.documentElement.dataset.theme === state().theme,
      "before=" + themeBefore + " after=" + state().theme + " root=" + document.documentElement.dataset.theme);

    /* 11. 宿主 client 的 sc-theme postMessage：light/dark 生效，非法值安静忽略 */
    window.postMessage({ type: "sc-theme", theme: "light" }, "*");
    await waitFor(function () {
      return state().theme === "light" && document.documentElement.dataset.theme === "light";
    }, 8000, "sc-theme light message");
    check("theme-message-light", state().theme === "light", "theme=" + state().theme);
    window.postMessage({ type: "sc-theme", theme: "dark" }, "*");
    await waitFor(function () {
      return state().theme === "dark" && document.documentElement.dataset.theme === "dark";
    }, 8000, "sc-theme dark message");
    check("theme-message-dark", state().theme === "dark", "theme=" + state().theme);
    window.postMessage({ type: "sc-theme", theme: "auto" }, "*");
    window.postMessage({ type: "sc-other", theme: "light" }, "*");
    await wait(400);
    check("theme-message-invalid-ignored", state().theme === "dark", "theme=" + state().theme);
    recordPageErrors();
  }

  /* ── 场景 cancel：取消是终局、轮询停止、回结果页 ────────────────────────── */
  async function runCancel() {
    await waitReady();
    await waitFor(function () { return $("#f-desc") && $("#btn-start"); }, 15000, "generic form");
    setInput($("#f-desc"), "取消测试用例（bridge 取消场景）");
    await waitFor(function () { var b = $("#btn-start"); return b && !b.disabled; }, 8000, "start enabled");
    $("#btn-start").click();
    await waitFor(function () {
      var s = state();
      return s && s.run && s.run.status;
    }, 10000, "cancel run created");
    var id = state().run.id;
    must("cancel-run-active", !!state().live && ["creating", "evaluating", "fixing"].indexOf(state().live.status) !== -1,
      JSON.stringify(state().live));
    must("cancel-button", !!$("#btn-cancel"), "cancel button missing on run page");

    $("#btn-cancel").click();
    await waitFor(function () { return $("#dlg-cancel"); }, 8000, "cancel confirm dialog");
    check("cancel-dialog", !!$("#dlg-cancel"), "dialog not open");
    $("#dlg-cancel").click();
    await waitFor(function () {
      var s = state();
      return s && s.view === "result" && s.run && s.run.id === id && s.run.status === "cancelled";
    }, 15000, "cancelled result view");

    var after = state();
    must("cancel-status", after.run.status === "cancelled", after.run.status);
    must("cancel-live-cleared", after.live === null, JSON.stringify(after.live));
    must("cancel-polling-stopped", after.polling === false, "polling=" + after.polling);
    await wait(1500);
    must("cancel-is-terminal", state().run && state().run.status === "cancelled", state().run && state().run.status);
    check("cancel-result-no-score", !!$("#workspace .status-panel") || !$("#workspace .ring"),
      "score panel present=" + !!$("#workspace .ring"));

    var reqs = await requests();
    var cancelPost = lastPost(reqs, "/api/cancel");
    must("post-cancel-called", !!cancelPost && cancelPost.body && cancelPost.body.id === id,
      cancelPost ? JSON.stringify(cancelPost.body) : "no POST /cancel");
    var runDetail = await window.__SC_BRIDGE__.api.run(id);
    must("cancel-step-from-host",
      runDetail.steps.some(function (s) { return s.text.indexOf("已取消") !== -1; }),
      runDetail.steps.map(function (s) { return s.text; }).join("|"));
    check("cancel-no-fake-score", runDetail.score === null && runDetail.verdict === null,
      "score=" + runDetail.score + " verdict=" + runDetail.verdict);

    /* 取消后记录仍在 */
    var runsList = await window.__SC_BRIDGE__.api.runs();
    check("cancel-run-listed", runsList.some(function (r) { return r.id === id && r.status === "cancelled"; }),
      runsList.map(function (r) { return r.id + ":" + r.status; }).join(","));
    recordPageErrors();
  }

  /* 手动复评：1 轮未达标 → 结果页按钮 → POST /run/retry → 修复 → 第 2 轮达标 */
  async function runRetry() {
    await waitFor(function () { return state().runs && state().runs.length > 0; }, 15000, "seeded below-threshold run");
    $('[data-nav="records"]').click();
    await waitFor(function () { return state().view === "records" && $("#rec-list"); }, 8000, "records pane");
    var row = $('#rec-list [data-open="api-run-retry-generic"]');
    must("retry-record-listed", !!row, "below-threshold generic record not listed");
    row.click();
    await waitFor(function () {
      var s = state();
      return s.view === "result" && s.run && s.run.id === "api-run-retry-generic";
    }, 10000, "below-threshold result page");
    var btn = $("#btn-retry-eval");
    must("retry-button", !!btn, "result page has no manual-retry button");
    check("retry-button-label", /复评|evaluat/i.test(text(btn)), "label=" + text(btn));
    btn.click();
    check("retry-button-pending", btn.disabled === true && btn.getAttribute("aria-busy") === "true",
      "disabled=" + btn.disabled + " busy=" + btn.getAttribute("aria-busy"));
    await waitFor(function () {
      var s = state();
      return s.view === "run" && s.live && s.live.status !== "below-threshold";
    }, 10000, "retry switched to run view");
    await waitFor(function () {
      var s = state();
      return s.view === "result" && s.run && s.run.status === "done" && s.run.score === 9.2;
    }, 30000, "manual retry finished at 9.2");
    var finalRun = state().run;
    check("retry-round-2", finalRun.round === 2 && finalRun.maxEvalRounds === 2,
      "round=" + finalRun.round + "/" + finalRun.maxEvalRounds);
    check("retry-passed", finalRun.verdict === "pass" && finalRun.score === 9.2, "score=" + finalRun.score + " verdict=" + finalRun.verdict);
    check("retry-button-gone", !$("#btn-retry-eval"), "retry button still visible after passing");
    var reqs = await requests();
    var retryReqs = reqs.filter(function (r) { return r.path.indexOf("/run/retry") !== -1 && r.method === "POST"; });
    must("retry-post", retryReqs.length === 1 && retryReqs[0].body && retryReqs[0].body.id === "api-run-retry-generic",
      "posts=" + retryReqs.length);
    recordPageErrors();
  }

  (async function main() {
    try {
      if (CASE === "full") await runFull();
      else if (CASE === "cancel") await runCancel();
      else if (CASE === "retry") await runRetry();
      else check("case-known", false, "probe got unsupported case: " + CASE);
    } catch (err) {
      out.errors.push(String((err && err.stack) || err));
    } finally {
      emit();
    }
  })();
})();