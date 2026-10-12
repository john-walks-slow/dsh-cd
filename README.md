# dsh-cd

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）补一个 `cd`：**只换工作基准**——让文件工具的相对路径与 bash 默认工作目录跟随新目录，会话本身原地不动。

> **0.3.0 起真切搬迁已迁出本插件（breaking change）。** 改变会话身份的操作（迁移会话存储、换沙箱根、改工作区归属）现在由
> [dsh-manage-session](https://github.com/john-walks-slow/dsh-manage-session) 的 `session_move` 工具与
> `/move`（`/cd` 为别名）提供，**不再属于 dsh-cd**。

## 是什么 / 为什么需要

dsh 会话的工作目录（`session.header.cwd`）在创建时冻结，是会话身份的一部分——它决定会话存储位置、沙箱根、AGENTS.md 与 skills 的发现根，因此 dsh 出于设计不支持中途修改它。于是模型在需要操作工作区之外的目录时（比如"去 /tmp 帮我整理这些日志"），只能在每一次 read/write/bash 调用里写完整绝对路径，又长又容易错。

dsh-cd 的答案很轻：不动会话身份，只把「相对路径解析基准」挪过去，随时可以挪回来。

覆盖模式下各工具的行为变化：

| 工具 | 行为变化 |
|---|---|
| `bash` / `pwsh` | 不传 `workdir` 时，默认在覆盖目录执行；相对 `workdir` 也解析到那里 |
| `read` / `write` / `edit` / `read_image` | 相对 `file_path` 解析到覆盖目录 |
| `glob` / `grep` | 不传 `path` 时默认搜覆盖目录；相对 `path` 解析到那里 |
| `present` | `files[].path` 相对路径解析到覆盖目录 |
| 其他工具 | 不受影响，仍按原语义（需要绝对路径） |

**明确不迁移的**：沙箱策略根、项目指令（AGENTS.md）、skills 发现、MCP 配置、会话存储位置、工作区归属——`cd 回会话工作区根` 即清除覆盖，恢复原状。要连这些一起搬，请用 dsh-manage-session 的 `session_move` / `/move`。

## 安装

```bash
dsh plugin --profile web add dsh-cd
```

安装后无需手动改配置，插件自带的 `cordis.patch.yml` 自动挂载生效：模型多出一个 `cd` 工具。

从 GitHub 直装（源码安装，pnpm ≥10 需允许构建脚本）：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-cd
# 首次 add 会被 pnpm 拦截：把 pnpm 提示的包名加入
# ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 后重跑
```

## 模型用法

```
cd {"path": "/tmp/some-dir"}   # 换基准：绝对路径 / 相对当前基准 / ~ 开头
cd {"path": "-"}               # 回到上一个目录
cd {}                          # 查询当前目录
```

细节行为：

- 目标必须是已存在的目录（符号链接会解析成真实路径），否则报错。
- 覆盖按**会话**隔离：一个会话 cd 走不影响其他会话。
- cd 回会话工作区根 = 清除覆盖，一切回到原状。
- 切换后系统提示里会注入一段说明（cache 安全的 runtime-context 快照，仅覆盖激活时存在）：**工具参数的**相对路径解析到覆盖目录，而**回答里的** markdown 链接/图片/文件提及仍以会话工作区根为基准（必须写工作区相对路径或绝对路径，否则链不上）。
- **跨重启持久化**：覆盖状态写入 `$DSH_HOME/dsh-cd/state.json`（原子写，30 天未使用自动剪除）。实例重启后再打开该会话，覆盖自动恢复。
- **子代理继承**：会话派生的子代理在创建时快照父会话的覆盖目录（继承条目不落盘）。
- **工作树场景就是本插件的典型用法**：在 git worktree 里干活时，用基准切换就够了。

## 模型看到什么

覆盖激活时，每个 step 组装的 Runtime Context 快照里会多出一段（仅在文本变化时追加，内容不变则复用上一条）：

```
[dsh-cd] Working-directory override active for this session: /home/me/project/legacy. Relative paths in read/write/edit/glob/grep/read_image/present and the bash tool's default workdir resolve against it; other tools need absolute paths. Markdown links, images, and file mentions in your visible reply use a different base: they resolve against the session workspace root (/home/me/project), so write them workspace-relative (a file at /home/me/project/legacy/report.md is written "legacy/report.md") or absolute — reply paths written relative to the override will not open. The session workspace root still anchors sandbox policy, project instructions (AGENTS.md), skills, and session storage.
```

覆盖目录在工作区根之外时，末尾不会出现那句换算示例（此时回答里只能写绝对路径）。

## 权限与兼容

- **无网络、无外部服务**：插件只在本地内存与状态文件里维护「会话 → 覆盖目录」表。
- **只看不写会话数据**：唯一的文件写入是插件自己的 `$DSH_HOME/dsh-cd/state.json`（tmp+rename 原子写、30 天未使用自动剪除）；插件**不触碰** dsh 的会话日志、`workspace.json` 账本或任何工作区登记。
- **提示词而非机制**：回答里的路径基准由 DSH Web GUI 决定（固定为会话工作区根），插件无法改写模型输出，只能靠注入文案约束。
- **宿主版本要求**：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths` 声明为 `^0.1.5-rc.3 || ^0.2.0-rc.1` 的 peerDependencies（由宿主提供，不重复安装）；Node.js >= 22.5。

## 开发

本地以 `link:` 方式接进 profile 调试：

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-cd@link:/path/to/dsh-cd
# 再把 "dsh-cd" 加进 package.json 的 dsh.profile.bundles 数组，然后重启 dsh
```

```bash
npm install    # 触发 prepare → 构建 dist/
pnpm check     # 类型检查
npm test       # 构建 + 行为测试（基准覆盖 / `-` / 清除 / 重启恢复）
npm run e2e:cd # GUI 端到端（需先 dsh-e2e start --wait-ready）
```

- 源码：`src/index.ts`（装配 + `cd` 工具 + 影子工具）、`src/context.ts`（runtime-context 文案）、`src/state.ts`（状态持久化）。
- 设计与调研记录见 `docs/features/260927-cd-tool/`；真切搬迁的宿主源码探索与实施记录见 `docs/features/261012-workspace-switch/`（该能力已迁至 dsh-manage-session）。

## 发新版

```bash
npm run release                                                # test + npm version patch（自动 commit+tag）+ pack 到 /tmp
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-cd-<新版>.tgz
git push --follow-tags
```

发布后用 `npm view dsh-cd version` 复验。

## License

MIT
