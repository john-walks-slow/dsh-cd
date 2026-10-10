# dsh-cd 发布准备报告（261010）

执行者：主会话 · 日期：2026-10-10 · 范围：本轮只做「发布准备」——未建 GitHub 仓库、未 npm 发布、未改线上 profile。

## 一、隐私/密钥扫描

扫描面：`git ls-files` 全部跟踪文件（工作树）＋ `git rev-list --all` 全历史逐 commit；模式覆盖密钥/token、私人域名（`*.qzz.io`）、真实姓名/邮箱、内网 IP、设备型号与宿主环境叙述（K30S / 骁龙 / chroot / termux / apk）、隧道与代理拓扑。

### 干净项确认

- **Git 提交者身份**：全部 3 个 commit 均为 `john-walks-slow <john-walks-slow@users.noreply.github.com>`，无需 filter-branch。
- **全历史无泄漏**：逐 commit 扫描设备型号 / 私人域名 / 内网 IP / 宿主环境关键词，零命中。
- **工作树无凭据**：无 token / 密码 / 私钥；`$DSH_HOME` 只以变量形式出现。
- **LICENSE 署名** `dsh-cd contributors`；package.json 的 `author: "johnnren"`（公开笔名）与仓库 URL 为发布元数据，非泄漏。

### 已处置（文档类 → 通用占位）

| 位置 | 原文（摘要） | 处置 |
|---|---|---|
| docs/features/260927-cd-tool/plan.md:32 | `DSH_HOME=/root/.dsh-e2e:4188` | 「独立 DSH_HOME，端口 4188」 |
| docs/features/260927-cd-tool/validation.md:11 | `DSH_HOME=/root/.dsh-e2e，线上 profile 副本` | 「独立 DSH_HOME」 |
| docs/features/260927-cd-tool/validation.md:11,15,21 | `/root/projects/virtual-connect` | `~/projects/virtual-connect` |
| docs/features/260927-cd-tool/validation.md:26 | 共享 e2e 环境内存耗尽（free 87MB） | 「e2e 环境资源耗尽」 |
| docs/issues/261010-cd-reply-path/summary.md:24 | 可用内存 ~670MB、swap 已用 4.8G | 「本机当时内存紧张」 |

### 仅报告（代码类，按惯例保留）

| 位置 | 摘录 | 说明 |
|---|---|---|
| e2e/cd-tool.mjs:12,82 | `import pw from "/root/projects/camoufox-mcp/..."`、`/root/.cache/camoufox/camoufox-bin` | 本机绝对路径；e2e 仅开发用、不进 npm `files`，与已收录的 dsh-qol 等仓库同形（dsh-set-model 用环境变量参数化，本仓库未改以免动到未复跑的脚本） |

## 二、改动文件清单

| 文件 | 改动 |
|---|---|
| package.json | description 改英中双语一段（EN 前 CN 后）；keywords 补中文 5 词；补 `author`/`repository`（`git+https://github.com/john-walks-slow/dsh-cd.git`）/`homepage`/`bugs`；`files` 加 `README.en.md`、`LICENSE`；scripts 补 `prepare`（`npm run build`，GitHub 直装必需）、`prepublishOnly`（`npm run check`）、`release`、`e2e:cd`；**依赖结构变更**：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths` 从 `dependencies@0.1.5-rc.3` 改为 `peerDependencies@^0.1.5-rc.3 \|\| ^0.2.0-rc.1`，并在 `devDependencies` 钉宿主基线 `0.2.0-rc.2` |
| LICENSE | 新建 MIT（`dsh-cd contributors`） |
| README.md | 重写至发布规格：居中语言切换、一行价值、`dsh plugin --profile web add dsh-cd` 安装命令 + GitHub 直装（含 pnpm allowBuilds 提示）、功能表、细节行为、新增「模型看到什么」（真实注入文本）、「权限与兼容」（无网络 / 唯一写入 state.json / 不改会话身份 / 宿主版本要求 / 提示词而非机制）、开发、发新版 |
| README.en.md | 新建，忠实英文版 |
| src/index.ts | `agent/created` 监听器显式 `return undefined`（0.2.0-rc.2 起该监听器签名要求 `Promise<undefined> \| undefined`，旧代码编译不过） |
| AGENTS.md | 「必须了解」补依赖基线与 peer/dev 约定、宿主基线升级流程；「常用命令」补 `e2e:cd`、`release` |
| .gitignore | 补 `.worktrees/`、`.mnemon/`、`pnpm-lock.yaml` |
| docs/freeform/261010-awesome-entry-draft.yml | 新建 awesome 投稿草稿（category `tools`，双语 keyword 密集描述，yaml 合法） |
| docs/features 与 docs/issues 的 4 份文档 | 见上表脱敏 |

## 三、构建 / 打包 / 隔离验证

- `npm install`（对齐基线） ✅ — 触发 `prepare` 时**先暴露出类型不兼容**（见 src/index.ts 一行），修复后重跑全绿
- `npm run check` ✅ / `npm run build` ✅（产出 `dist/index.js`，16.4 kB）
- `npm pack --dry-run` ✅：6 个文件 — `LICENSE`、`README.en.md`、`README.md`、`cordis.patch.yml`、`dist/index.js`、`package.json`；11.4 kB，与 `files`/`main`/`exports` 一致，无多余文件
- 隔离安装验证 ✅：`dsh plugin --profile cdverify add /tmp/dsh-cd-0.1.0.tgz` 装成功 → `dsh --profile cdverify --dump-config` 出现 `# == dsh-cd` 层（`id: cd` / `name: dsh-cd`）→ 从 profile 目录 `import('dsh-cd')` 得 `apply: function`、`inject: ["tools","agents"]`；验完已删除 scratch profile 与 tgz
  - ⚠️ 严格性说明：本机 `/root/.dsh/profiles/node_modules` 存在 profile 级 hoist，peer 是从那里解析到的，因此这次不算完全干净环境；tarball 的可安装性、layer 注册、入口导出三项结论不受影响
- npm 名称可用性 ✅：`npm view dsh-cd` 返回 404（名称未被占用）

## 四、依赖结构变更的理由（需要留意的一处非纯元数据改动）

profile 里 `@deepseek-ai/dsh-tools` 已是 `0.2.0-rc.2`。原 `dependencies: 0.1.5-rc.3` 会让 pnpm 在 profile 内再装一份**框架包副本**（两套 dsh-tools 实例）。改为 peerDependencies（范围含显式预发布分支，符合 awesome contributing 的 node-semver 警告）后由宿主单一供给；`devDependencies` 钉基线仅用于本地类型检查与构建。awesome contributing 明文推荐官方 `@deepseek-ai/*` 用 peerDependencies。

## 五、后续动作（待用户确认）

1. 建 GitHub 公开仓库 `john-walks-slow/dsh-cd` → push（含 `--follow-tags` 前先有 tag）→ `gh repo edit --add-topic dsh-plugin`（可加 deepseek-harness、cordis、cd、working-directory）
2. npm 指纹发布：`npm run release` 或直接 `npm pack --pack-destination /tmp` + `publish-webauthn.cjs`（0.1.0 首发；`repository` 已指回仓库）
3. **2026-10-11 起**提 awesome PR：`data/plugins/john-walks-slow__dsh-cd.yml`（内容即 `docs/freeform/261010-awesome-entry-draft.yml`）
4. 未做 `screenshots.json`：本插件是上下文注入类，无可视产物，市场会自动从 README 抽图（README 内无图，故详情页无截图；如后续要，可补一张「模型看到什么」的 GUI 实拍）
5. 与本轮无关但未决：线上 dsh 需重启才会加载 `df265f1` 的 `cd` 文案修复（宿主插件在启动时加载 dist）
