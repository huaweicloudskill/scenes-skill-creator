# Scenes Skill Creator

**DeepSeek Harness 的通用技能 / 华为云技能创建插件。** 在 DSH 的 Web 面板里填写需求，调用官方 creator 真实生成、评测并修复技能，达标后一键安装到 DSH 技能目录。

![面板预览](docs/panel.png)

## 这是什么

Scenes Skill Creator 是一个 **DeepSeek Harness bundle 插件**。它不自己“编”技能，而是把创建和评审交给官方 creator：

- **通用技能**：调用 `common-skill-creator`，适合日常 Agent Skill、工具封装、流程自动化；
- **华为云技能**：调用 `huawei-cloud-skill-creator`，按华为云规范生成基础云服务技能，覆盖三级目录、hcloud CLI、测试夹具和评测；
- 面板负责收集需求、展示阶段和日志、呈现 10 分制评测结果，并在未达标时把扣分项交回 creator 修复。

一次创建流程：

```text
填写需求 → 官方 creator 生成 → 实时阶段 / 日志 → 10 分制评测
        → 达标：安装到 DSH 技能目录
        → 未达标：自动或手动打回修复 → 再评测
```

## 优点

- **真实执行，不是演示数据**：每个阶段、步骤、评测结果都来自真实 creator 运行；面板不伪造进度和分数。
- **通用 + 华为云双场景**：同一套界面覆盖两种技能规范，华为云目录从真实仓库懒加载。
- **自动评测与打回修复**：10 分制评分，默认通过线 8.5；不达标自动进入修复轮次，最多 3 轮。
- **通用技能快速模式**：默认只跑 1 轮评测，先保证功能可用；结果页可以反复「继续修复并复评」，直到你满意。
- **创建记录跨类型管理**：通用和华为云记录一起展示，支持类型 / 状态筛选，不限制记录数量。
- **一键安装**：达标后把成品目录复制到 DSH 技能目录，并刷新技能发现。
- **参考数据不写死**：参考案例和推荐技能从公共 JSON 数据仓库读取，更新数据不需要发新版插件。
- **MIT 开源**：代码、npm 包、数据来源全部公开，可自由使用、修改和分发。

## 安装

### 方式一：DSH 插件页（推荐）

1. 打开 DSH → **插件**；
2. 选择安装插件 / 从 npm 安装；
3. 输入包名：

   ```text
   @huaweicloud-plugins/scenes-skill-creator
   ```

4. 安装完成后重启 DSH（或让 DSH 完成热加载）；
5. 左侧栏出现 **Scenes Skill Creator** 即安装成功。

插件页会自动处理 profile 依赖和 bundle 注册，适合日常安装。

### 方式二：`dsh plugin` 命令

先**完全退出 DSH**，然后在终端执行：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @huaweicloud-plugins/scenes-skill-creator
```

如果你的 `dsh` 已经在 PATH 里，也可以直接：

```powershell
dsh plugin --profile desktop add @huaweicloud-plugins/scenes-skill-creator
```

说明：

- 命令格式是 `dsh plugin --profile desktop add <包名>`；
- 如果 `dsh` 不在 PATH，使用 DSH 安装目录下的 `resources\runtime\cli\bin\dsh.cmd`；
- `desktop` 是 DSH 桌面版保留 profile，必须使用 DSH 自带的 CLI；普通 npm CLI 不能管理它；
- 安装会通过 profile 的 pnpm 完成，新 bundle 默认加入 `dsh.profile.bundles`；
- 重新打开 DSH 后生效；
- 卸载：

  ```powershell
  & "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove @huaweicloud-plugins/scenes-skill-creator
  ```

### 安装后检查

侧栏出现 **Scenes Skill Creator**，打开面板能看到两个场景、参考案例卡和推荐技能卡。

Windows 上如果 DSH 启动时报 `Unexpected token '\uFEFF'`，通常是 profile 的 `package.json` 带了 UTF-8 BOM。可以运行：

```powershell
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@huaweicloud-plugins\scenes-skill-creator\bin\dsh-skill-doctor.mjs"
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@huaweicloud-plugins\scenes-skill-creator\bin\dsh-skill-doctor.mjs" --fix
```

### 运行环境

- DSH Desktop 0.2.x（已在 `0.2.2-rc.1` 验证）；
- 能访问 `gitcode.com`：creator、参考数据、华为云目录都从这里拉取；
- `git`、`bash`（Windows 用 Git Bash）、`python3`；
- 华为云场景还需要可用的 hcloud / AKSK 配置；
- creator 需要执行 shell / CLI，默认使用 `danger-full-access` 权限，建议只在可信工作区使用。

## 创建通用技能

1. 顶部选择 **通用技能**；
2. 在需求框描述要做什么，例如“创建一个能查询天气的 skill，支持城市名和摄氏度/华氏度参数”；
3. 点击开始创建；
4. 运行页会显示创建、评测、修复阶段和步骤日志；
5. 结果页显示总分、各维度、扣分项和改进建议；
6. 达标后可点击「安装 / 启用该技能」复制到 DSH 技能目录。

通用技能默认走快速模式：1 轮评测、优先最小可用路径。未达标时点「继续修复并复评」即可反复修复，不自动无限循环。

## 创建华为云技能

1. 顶部选择 **华为云基础云服务技能**；
2. 依次选择 domain → product，填写 skill 名称和需求；
3. 点击开始创建，creator 会按华为云规范生成技能、CLI 命令、测试夹具和评测；
4. 评测不达标时自动修复；通用技能则可手动复评；
5. 完成后安装到 DSH 技能目录，或打开产物目录查看。

华为云目录来自真实仓库，首屏可能短暂使用缓存；刷新目录会重新拉取。

## 创建记录

- 记录页默认展示通用 + 华为云全部记录；
- 支持「全部类型 / 通用 / 华为云」和「全部 / 进行中 / 未达标」筛选；
- 可打开详情、返回列表、删除已结束记录；
- 运行中的记录不能直接删除，先取消再删。

## 评测与修复

- 10 分制评分，默认通过线 **8.5**；
- 自动评测最多 **3 轮**；
- 通用技能默认只跑 **1 轮**，结果页可反复手动「继续修复并复评」；
- 评测覆盖功能可用、稳定性、成本、效率、安全等维度；
- 通用技能如果没有 `evals/evals.json`，插件会从 `SKILL.md` 的只读命令示例生成最小测试夹具，再由评测 agent 实际执行并给出证据。

## 配置（可选）

默认配置在 `cordis.patch.yml`。需要覆盖时，在 profile 的 `cordis.patch.yml` 的 `config` 下写同名键；profile 覆盖是整块替换。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `run.cwd` | Host cwd | 技能落盘根目录，建议显式设置为自己的工作区 |
| `run.permissionPreset` | `danger-full-access` | creator 执行 bash/CLI 所需；仅在可信工作区使用 |
| `run.passScore` | `8.5` | 通过线 |
| `run.maxEvalRounds` | `3` | 最多自动评测轮数；`0` 关闭评测 |
| `run.genericFastMode` | `true` | 通用技能快速模式 |
| `run.genericMaxEvalRounds` | `1` | 通用技能自动评测轮数；显式值优先于快速模式 |
| `run.installDir` | `$DSH_HOME/skills` | 「安装 / 启用」复制目标 |
| `refs.*` | 公共 JSON 仓库 | 参考案例 / 推荐数据源 |
| `catalog.*` | 华为云仓库 | 三级目录来源 |
| `creators.*` | 官方 creator | 两个 creator 仓库和路径 |

## 参考与推荐数据

数据位于公共仓库 `developer-skill/common-skill-dev` 的 `dsh-plugin` 分支：

- 华为云：5 个案例；7 个 domain 每个最多 10 条推荐；
- 通用：2 个案例 + 10 个精选推荐。

插件通过 Host `/refs` 拉取 JSON，失败时回落到 last-good 缓存。更新数据只需改数据仓库，不需要发新版插件。

## 开源与许可

- GitHub：`https://github.com/huaweicloudskill/scenes-skill-creator`
- GitCode：`https://gitcode.com/developer-skill/scenes-skill-creator`
- npm：`https://www.npmjs.com/package/@huaweicloud-plugins/scenes-skill-creator`
- 许可证：**MIT**，见 [LICENSE](LICENSE)。

插件完全开源，Host、桥接层、面板、CLI 和测试都在仓库里；欢迎 issue / PR。

## 开发者

```sh
npm test          # host + bridge + client 测试
npm run check     # node --check
npm run doctor    # 检查本机 DSH profile 的 manifest / bundle / 面板资源
```

- 测试结果：**65 tests / 0 fail**；
- Host 测试使用 mock，不访问网络、不启动真实 agent；
- Bridge 测试用 mock API + 无头 Edge 打开面板；
- 发布版 `assets/panel.html` 不内嵌参考数据，数据全部走 Host `/refs`。

### 目录

| 路径 | 作用 |
| --- | --- |
| `src/client.js` | Web client：sidebar 图标 + iframe 面板 |
| `assets/panel.html` | 面板 UI |
| `assets/panel-bridge.js` | 面板 ↔ Host API 适配 |
| `src/core/plugin.mjs` | Host 入口：creator provider、API、静态面板 |
| `src/core/routes.mjs` | `/scenes-skill-creator/api` 与 `/app` |
| `src/core/runner.mjs` / `evaluator.mjs` | 创建、修复、评测 |
| `src/core/refs.mjs` | 公共参考 / 推荐数据 |
| `bin/dsh-skill-doctor.mjs` | profile 自检 / BOM 修复 |
| `cordis.patch.yml` | bundle 声明与默认配置 |

## 已知限制

- 不做内容创作：`SKILL.md`、references、夹具由官方 creator 生成；
- 必须能跑 creator：需要网络、git、bash、python3，华为云另需 hcloud/AKSK；
- 默认完整权限，只在可信工作区使用；
- Host 快照暂不提供产物文件统计，结果页显示 0 文件 / 0.0 KB；
- 暂未实现平台侧 PR / A2A 交接；
- 记录日志显示截断到最近 120 步，Host 侧保留 200 步。