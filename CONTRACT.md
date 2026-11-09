# scenes-skill-creator — 实现契约

## 目标

本仓库交付一个 **DeepSeek Harness bundle 插件**：

- 名称：`@huaweicloud-plugins/scenes-skill-creator`（`src/client.js` 里 `window.__ModuleLoader__.load({ id })` 必须与 `package.json` name 一致）。
- Host 半侧：参考官方 `@cloudplugin/scenes-skill-creator` 的创建 / 评审流程；
- Client 半侧：以设计原型为 UI 源，把发布版放进 `assets/panel.html`，用 iframe 铺满 main slot；
- 原型 UI 通过 `assets/panel-bridge.js` 接到 Host 真实 API，替换原型里的模拟定时器 / 种子记录；
- 只保留 **通用技能 generic**、**华为云基础云服务技能 huawei** 两个场景。
- 参考、推荐数据全部由公共 JSON 数据仓库提供，发布版面板不内嵌数据快照。

## 目录与写入范围（防冲突）

| 范围 | 负责人 | 内容 |
| --- | --- | --- |
| `src/core/**`、`src/lib/**`、`bin/**`、`test/host/**` | backend-dev | Host 核心、2 模式裁剪、静态 app 路由、无记录上限、Host 测试 |
| `assets/panel.html`、`assets/panel-bridge.js`、`test/bridge/**` | bridge-dev | 原型 UI 内嵌适配、mock API 服务、无头浏览器验证 |
| `src/client.js`、`package.json`、`cordis.patch.yml`、`README.md`、`icon.svg`、`locale/**` | Lead | bundle 声明、iframe client、文档、集成验证 |

不要跨范围改别人的文件；确需改动先在群里说明。

## Host API 契约（bridge 与 client 都依赖）

前缀：`/scenes-skill-creator/api`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | `{ok, revision, catalog, creators: {generic, huawei}, environment: {git,bash,python,net,cacheDays,cred}}` |
| GET | `/catalog?path=skills` / `?path=skills/<domain>&refresh=1` | 华为云三级目录，`{ok, entries:[{name,type}], stale?}` |
| GET | `/refs` | 从公共仓库 `dsh-plugin` 分支拉取参考/推荐数据；返回 `{ok, source: remote|cache|none, scenes: {huawei, generic}, warnings}`；GitCode Contents API 的 base64 会解码 |
| GET | `/creator?mode=generic|huawei&refresh=1` | creator 拉取状态 `{ok, present, skill, branch, commit, files, dir, web}` |
| GET | `/run` | `{ok, runs:[run]}` |
| GET | `/run?id=<id>` | `{ok, run}` / 404 |
| DELETE | `/run?id=<id>` | 删除已结束记录；运行中返回 409 |
| POST | `/run` | body `{spec}`；`spec.mode` 只接受 `generic` / `huawei`；返回 `{ok, run}` |
| POST | `/run/retry` | body `{id}`；仅 generic + below-threshold + 有评测/目标目录；复用原 creator，会话已结束则新起 creator 修复，再跑下一轮；未达标可反复手动复评，不自动循环；返回 `{ok, run}` / 409 |
| POST | `/install` | body `{id}`；把已完成的 skill 复制到 `run.installDir`（默认 `$DSH_HOME/skills`）并 invalidate skills 目录；返回 `{ok, installed, name, path}` / 409 |
| POST | `/cancel` | body `{id}`，返回 `{ok, run}` |
| POST | `/handoff` | 调试用，返回 creator handoff 文本 |
| POST | `/validate` | 保留参考实现 |

**run 对象**（Host `runner` 已有，bridge 直接映射到原型 `S.run`）：

```js
{
  id, sessionId, kind: "generic"|"huawei", creator, commit,
  spec: { mode, description, name?, domain?, product? },
  cwd, target, agentPreset, permission,
  status: "creating"|"evaluating"|"fixing"|"done"|"below-threshold"|"cancelled"|"interrupted"|"failed",
  startedAt, lastActivityAt,
  phases: [{ id, title, state: "pending"|"active"|"done" }],
  steps: [{ at, kind, text }],
  round, maxEvalRounds, passScore, verdict, score,
  dimensions: { stability, cost, efficiency, security },
  itemScores, deductions, checks, metrics, evaluations, report, error
}
```

## 静态 UI 路由

- `GET /scenes-skill-creator/app/` → `assets/panel.html`
- `GET /scenes-skill-creator/app/panel-bridge.js` → `assets/panel-bridge.js`
- Host 读文件后返回；`Content-Type: text/html; charset=utf-8` / `text/javascript; charset=utf-8`，`Cache-Control: no-store`。
- **不要**使用 DSH 的通用静态目录服务（本项目只用 `ctx.webServer.register` prefix route）。
- 允许路径白名单，禁止 `..` 穿越。

## Bridge 契约（必须真实、不模拟）

`panel-bridge.js` 在原型页面脚本**之后**执行，设置 `window.__SC_EMBED__ = true`，并：

1. 清掉种子/本地演示记录：`S.runs = []`；不读 `proto.runs` / `proto.draft` 的旧值（或只保留空草稿）。
2. 启动时 `GET /run` 拉真实记录，`S.runs = body.runs`；按 `startedAt` 倒序。
3. `startRun()` 覆盖为：收集原型表单 spec（generic `{mode,description}`；huawei `{mode,name,domain,product,description}`），`POST /run`；把返回 run 设为 `S.live` / `S.run`，`S.view="run"`，`renderAll()`。
4. 运行中每 1s `GET /run?id=`；用返回的 run 覆盖当前视图；状态离开 `creating/evaluating/fixing` 后停轮询：
   - 若正在看该 run → `S.view="result"`，`renderAll()`；
   - 否则只刷新记录列表 / 侧栏，不抢视图。
5. `doCancel()` 覆盖为 `POST /cancel`，按返回 run 更新并回结果页。
6. `openRun(id)` 覆盖为 `GET /run?id=` 后按状态进 run/result；不再 `hydrateRun` 造模拟数据（embedded 下 `hydrateRun` 改为恒等）。
6c. `retryEval()` 覆盖为：结果页「继续修复并复评」→ `POST /run/retry {id}` → 新 run 设为 `S.live`/`S.run` 并轮询；失败恢复按钮并 toast。
6b. `confirmDelete(id)` 包一层：先 `DELETE /run?id=` 持久删除，成功后才执行原型原处理（本地移除/关窗）；失败 toast 并保留记录。
7. `loadRuns()` 覆盖为 `GET /run`（不报错时更新 `S.runs`）；`?fresh=1` 等演示参数不再造种子。
8. 华为云目录：embedded 时 `S.domains` / `S.products` 从 `/catalog` 拉；`loadProducts(domain)` 改为 `GET /catalog?path=skills/<domain>`；切换下拉时沿用原型事件流。失败时保留原型静态 `CATALOG` 兜底并只提示一次。
9. 环境页：启动时 `GET /status`，成功则 `S.preflight = {git:true,bash:true,python:true,net:true,cacheDays:3,cred:true}` 并 `renderPreflight()`（UI 结构不变，只填真实可用状态）；失败时按原型离线态展示。
10. 参考案例 / 技能推荐 / 视频弹窗：通过 Host `GET /refs` 读取公共 JSON 数据；发布版不保留面板内嵌 `API_SNAPSHOT`，远程失败时按 Host 的 last-good / 空数据处理，不伪造数据。
11. **禁止**在 embedded 模式下跑原型的 `seedRuns()`、`clearSim()` 定时模拟、`finishCreation()` 假评分；所有 run 字段来自 Host。
12. 隐藏只对演示有意义的控件（`#demo` 场景选择），其余顶栏 / 菜单 / 卡片 / 语言 / 主题按钮保持原型。
13. 提供 `window.__SC_BRIDGE__`：`{ ready, refreshRuns, api }` 供测试；页面加载完成设置 `document.documentElement.dataset.scBridge = "ready"`。

网络调用必须同源相对路径；不要发外部请求。

## 验收

- backend：`node --test test/host/*.test.mjs` 全绿；`node --check` 所有 .mjs；API 只有 generic/huawei；`MAX_RUNS` 上限移除（含持久化 slice）；`/status` 的 creators 只有两项。
- bridge：`node --check assets/panel-bridge.js`；用 `test/bridge/mock-server.mjs` + 无头 Edge 跑通：无种子记录、POST /run 被调用、轮询更新阶段/步骤、结束后进结果页、取消、记录打开、华为云目录、参考 tab 还在。
- Lead 集成：`npm test` 全绿；`node --check src/client.js`；`cordis.patch.yml` 与 package 对齐；README 写清安装/权限/限制。

## 参考

- Host 流程 / 评审：官方 `@cloudplugin/scenes-skill-creator`（runner / evaluator / creators）。
- UI 设计原型：本仓库发布版 `assets/panel.html`（开发原型快照不随插件发布）。
- 参考 / 推荐数据：`developer-skill/common-skill-dev` 仓库的 `dsh-plugin` 分支。