# dsh-cd 项目指引

单插件项目：给 dsh 注册 `cd` 工具，实现会话级工作目录覆盖。源码仅 `src/index.ts`，构建产物 `dist/index.js`。

## 必须了解

- 机制：dsh 的 `session.header.cwd` 是会话身份（冻结、派生存储路径），且 `tools/pre-execute` waterfall 不改写参数——因此本插件**不改会话身份**，而是在每个 agent 自己的作用域注册影子工具（registry 文档化行为：scoped 注册遮蔽继承定义），仅在 execute 内改写路径类参数。原始工具对象在注册影子之前经 `ctx.tools.get(name, agent)` 取得。
- 运行时状态存 `$DSH_HOME/dsh-cd/state.json`（tmp+rename 原子写；30 天剪除；启动时异步加载，`state.ready` 门控竞态）。子代理经 `session.header.parentSession` 继承父会话覆盖，继承条目不落盘。
- 系统提示注入走 `systemPrompt.context` 快照（order 112），仅覆盖激活时输出文本。
- `agent/created` 监听器内任何抛错会否决 agent 发布——插件内全部 try/catch 包裹。
- defineTool 的 output.schema 必须用 `satisfies ValueSchemaSpec`，不能用类型注解（否则 properties 推断成 never）。
- 框架包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`，即运行时真正 import 的那些）走 **peerDependencies**（范围 `^0.1.5-rc.3 || ^0.2.0-rc.1`），由宿主提供；`devDependencies` 钉宿主当前基线（现为 `0.2.0-rc.2`）供本地类型检查。写进 dependencies 会在 profile 里装出第二份框架包。其余 `@deepseek-ai/*` 都是 type-only import，只放 devDependencies。
- 随宿主基线升级时：同步 devDependencies 版本 → `npm install`（会自动跑 prepare 构建）→ `npm run check`。0.1.5-rc.3 → 0.2.0-rc.2 的破坏性变更：`agent/created` 监听器必须返回 `Promise<undefined> | undefined`。

## 常用命令

```bash
pnpm check        # tsc --noEmit
pnpm build        # 构建 dist/
npm run e2e:cd    # GUI e2e（dsh-e2e 隔离实例）
npm run release   # check + npm version patch（commit+tag）+ pack 到 /tmp
```

e2e：`e2e/cd-tool.mjs`，GUI 驱动（camoufox + playwright-core），按 dsh-e2e skill 起隔离实例后运行。

## 工作流

实施/修改：/workflow-implement-review。设计调研与方案否决记录见 docs/features/260927-cd-tool/。
