# dsh-cd 项目指引

单插件项目：给 dsh 补 `cd` 能力（路径基准覆盖 + 真切工作区切换）与用户命令 `/cd`。源码在 `src/`（`index.ts` 装配、`relocate.ts` 搬迁引擎、`command.ts` 命令、`context.ts` 上下文文案、`state.ts` 状态持久化），构建产物 `dist/`。

## 必须了解

- 机制：dsh 的 `session.header.cwd` 是会话身份（冻结、派生存储路径），且 `tools/pre-execute` waterfall 不改写参数——因此本插件**不改会话身份**，而是在每个 agent 自己的作用域注册影子工具（registry 文档化行为：scoped 注册遮蔽继承定义），仅在 execute 内改写路径类参数。原始工具对象在注册影子之前经 `ctx.tools.get(name, agent)` 取得。
- 运行时状态存 `$DSH_HOME/dsh-cd/state.json`（tmp+rename 原子写；30 天剪除；启动时异步加载，`state.ready` 门控竞态）。子代理经 `session.header.parentSession` 继承父会话覆盖，继承条目不落盘。
- 系统提示注入走 `systemPrompt.context` 快照（order 112），仅覆盖激活时输出文本。
- `agent/created` 监听器内任何抛错会否决 agent 发布——插件内全部 try/catch 包裹。
- defineTool 的 output.schema 必须用 `satisfies ValueSchemaSpec`，不能用类型注解（否则 properties 推断成 never）。
- **真切工作区切换**（`cd {"workspace": true}` / `/cd`）必须自己做，宿主没有任何搬迁 RPC。三步缺一不可（代码在 `src/relocate.ts`）：① 磁盘——把会话目录迁到 `projectKey(新cwd)` 并重写日志**第一帧** header（多帧 Zstandard 容器，只解码/重编码第一帧，其余帧逐字节复制；`encodeSegment`/`projectKey`/帧扫描器/生成文件名正则都是从 `dsh-session-persistence-jsonl` 逐字移植的，改动需同步核对该文件）；② 内存——换 `session.header` 引用（对象深冻结、字段可写）并重定向写入句柄，否则后续追加会写回旧路径或 ENOENT；③ 账本——`detachSession` → `registry.create` → `attachSession`，且 attach 会**重读磁盘 header** 校验，所以必须排在磁盘改写之后，并调 `registry.indexHeader()` 刷新索引。
- **真切搬迁只在会话空闲时执行**（无运行中回合、无活跃子代理）。模型调用发生在回合中，因此走「本回合用路径基准 + `turn/end` 结算」；失败保留覆盖并把原因写进 runtime-context。
- **真切切换带同意闸**：`workspace: true` 只在同一次调用同时带 `confirmed: true` 时才排队搬迁（它改的是会话身份，必须先问用户）；不带 `confirmed` 的调用只换工作基准，并在结果与 runtime-context 里回报"等待用户同意"。**不要改成审批弹窗路线**：Full access 预设是 `approval: never`，审批请求会被自动拒绝，默认配置下必然走不通。用户执行 `/cd` 即用户本人操作，无需二次确认；工作树场景一般传 `false`。
- dsh 把 `sessionPersistence.tracker` / `config.root` / `Session.header` 标成 private，插件用**窄化结构类型**访问（`RelocateServices`），缺失时明确报错、不降级。`ctx.get(name, false)` 取非注入服务；`commands` 服务缺失时 `/cd` 不注册并告警。
- Node ≥ 22.15 自带 `zlib.zstdCompressSync/DecompressSync`，dsh 自身也用 `node:zlib`——帧手术**不需要外部 zstd CLI**；但 Node 的 zstd 解码器只解第一帧（一次性与流式都是），测试里验证整份日志要用 `zstd -dc`。
- 框架包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`，即运行时真正 import 的那些）走 **peerDependencies**（范围 `^0.1.5-rc.3 || ^0.2.0-rc.1`），由宿主提供；`devDependencies` 钉宿主当前基线（现为 `0.2.0-rc.2`）供本地类型检查。写进 dependencies 会在 profile 里装出第二份框架包。其余 `@deepseek-ai/*` 都是 type-only import，只放 devDependencies。
- 随宿主基线升级时：同步 devDependencies 版本 → `npm install`（会自动跑 prepare 构建）→ `npm run check`。0.1.5-rc.3 → 0.2.0-rc.2 的破坏性变更：`agent/created` 监听器必须返回 `Promise<undefined> | undefined`。

## 常用命令

```bash
pnpm check             # tsc --noEmit
pnpm build             # 构建 dist/
npm test               # 构建 + 行为测试（帧手术 / 账本 / 回滚 / 真实日志往返）
npm run e2e:cd         # 基准覆盖 e2e
npm run e2e:workspace  # 真切工作区切换 e2e
npm run release        # test + npm version patch（commit+tag）+ pack 到 /tmp
```

e2e 都走 GUI（camoufox + playwright-core），按 dsh-e2e skill 起隔离实例后运行。注意 0.2 起新 profile 会先弹 Preview Notice 与（缺 provider key 时）API key 弹窗遮罩 UI，e2e 脚本里要先点掉；e2e home 的 profile 用户层还需补 `llm-pi-ai` 的 provider 配置（`dsh-e2e start --patch <file>`），否则模型报 `no adapter registered for provider`。

## 工作流

实施/修改：/workflow-implement-review。设计与调研记录见 docs/features/260927-cd-tool/（路径基准覆盖的方案对比与否决记录）与 docs/features/261012-workspace-switch/（真切工作区切换的宿主源码探索、计划与验证记录）。
