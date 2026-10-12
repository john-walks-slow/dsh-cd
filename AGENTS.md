# dsh-cd 项目指引

单插件项目：给 dsh 补 `cd` 能力——**只换相对路径基准**，不搬会话。源码在 `src/`（`index.ts` 装配 + 工具定义、`context.ts` 上下文文案、`state.ts` 状态持久化），构建产物 `dist/`。

真切工作区切换（改会话身份、存储位置、沙箱根、工作区归属）**已迁出本插件**，现在由 `dsh-manage-session` 的 `session_move` 工具与 `/move`（`/cd` 别名）提供；本插件不再注册任何命令，也不再读写 dsh 的会话日志与 `workspace.json` 账本。

## 必须了解

- 机制：dsh 的 `session.header.cwd` 是会话身份（冻结、派生存储路径），且 `tools/pre-execute` waterfall 不改写参数——因此本插件**不改会话身份**，而是在每个 agent 自己的作用域注册影子工具（registry 文档化行为：scoped 注册遮蔽继承定义），仅在 execute 内改写路径类参数。原始工具对象在注册影子之前经 `ctx.tools.get(name, agent)` 取得。
- 运行时状态存 `$DSH_HOME/dsh-cd/state.json`（tmp+rename 原子写；30 天剪除；启动时异步加载，`state.ready` 门控竞态）。子代理经 `session.header.parentSession` 继承父会话覆盖，继承条目不落盘。
- **读旧 state 文件必须容错**：历史版本（≤0.2.1）在这里写过真切搬迁字段 `relocate` / `needsConsent` / `relocateError`。`loadPersisted` 逐字段重建条目（只认 `cwd` / `previous` / `updatedAt`），这些字段被静默丢弃，不会报错、也不会触发任何搬迁。
- 系统提示注入走 `systemPrompt.context` 快照（order 112，name 固定为 `cd-working-directory`）——**不要改名**：迁移后的真切上下文用别的 name（`dsh-manage-session` 用 `session-move`），同名 scoped context 会互相遮蔽。仅覆盖激活时输出文本。
- `agent/created` 监听器内任何抛错会否决 agent 发布——插件内全部 try/catch 包裹。
- defineTool 的 output.schema 必须用 `satisfies ValueSchemaSpec`，不能用类型注解（否则 properties 推断成 never）。
- 框架包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`，即运行时真正 import 的那些）走 **peerDependencies**（范围 `^0.1.5-rc.3 || ^0.2.0-rc.1`），由宿主提供；`devDependencies` 钉宿主当前基线（现为 `0.2.0-rc.2`）供本地类型检查。写进 dependencies 会在 profile 里装出第二份框架包。其余 `@deepseek-ai/*`（`dsh-agent`、`dsh-llm`、`cordis`）都是 type-only import，只放 devDependencies。
- 随宿主基线升级时：同步 devDependencies 版本 → `npm install`（会自动跑 prepare 构建）→ `npm run check`。0.1.5-rc.3 → 0.2.0-rc.2 的破坏性变更：`agent/created` 监听器必须返回 `Promise<undefined> | undefined`。

## 常用命令

```bash
pnpm check      # tsc --noEmit
pnpm build      # 构建 dist/
npm test        # 构建 + 行为测试（基准覆盖 / `-` / 清除 / 重启恢复）
npm run e2e:cd  # 基准覆盖 GUI e2e
npm run release # test + npm version patch（commit+tag）+ pack 到 /tmp
```

e2e 走 GUI（camoufox + playwright-core），按 dsh-e2e skill 起隔离实例后运行。注意 0.2 起新 profile 会先弹 Preview Notice 与（缺 provider key 时）API key 弹窗遮罩 UI，e2e 脚本里要先点掉；e2e home 的 profile 用户层还需补 `llm-pi-ai` 的 provider 配置（`dsh-e2e start --patch <file>`），否则模型报 `no adapter registered for provider`。

## 工作流

实施/修改：/workflow-implement-review。设计与调研记录见 `docs/features/260927-cd-tool/`（路径基准覆盖的方案对比与否决记录）与 `docs/features/261012-workspace-switch/`（真切工作区切换的宿主源码探索、计划与验证记录——该能力已迁至 `dsh-manage-session`，此处仅作历史留存）。
