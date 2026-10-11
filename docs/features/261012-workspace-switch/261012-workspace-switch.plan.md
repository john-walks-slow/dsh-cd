# dsh-cd 真切工作区切换 计划（2026-10-12）

## 目标

现状：`cd` 只覆盖**工具参数的路径基准**，会话身份不变（沙箱根、AGENTS.md/skills 发现、存储位置、侧边栏分组仍锚定原工作区）。

本次要补上**真切工作区**：切换后该会话真正属于新目录——沙箱根、项目指令与 skills 发现根、会话存储位置、侧边栏工作区分组全部跟随；并给用户一个可调用的命令入口。

## 事实基线（dsh 0.2.0-rc.2，证据见 `261012-workspace-switch.explore.md`）

| # | 事实 | 对方案的含义 |
|---|---|---|
| 1 | 工作区成员资格 = `workspace.json` 里 `sessionIds` 名单 **AND** 会话磁盘 header 的 cwd 规范化后 == `workspace.path`（双向强校验，不匹配者在投影时被过滤、下次写操作被剪除） | 搬迁必须**同时**改磁盘 header 与工作区账本，缺一不可 |
| 2 | 无任何官方搬迁/改 cwd 的 RPC；`session.header` 深冻结 | 只能插件自建引擎；换 header **引用**（对象冻结，字段可写） |
| 3 | header 只在 materialize 时写一次（第一帧），追加帧永不含 header；追加落盘路径由写入句柄 `JsonlSessionHandle.header.cwd` 现算 | 磁盘要重写第一帧；内存要重定向写入句柄，否则搬迁后下一次追加 ENOENT / 写到旧路径 |
| 4 | 冷读有 `coldLogMemo(id)` 缓存；存储路径由 `projectKey(cwd)` 派生 | 搬迁后需失效缓存；文件必须物理搬到新 projectKey 目录 |
| 5 | 沙箱根与文件工具相对路径**每次调用现读** `session.header.cwd` | 换掉 header 引用即即时生效，无需重启 |
| 6 | 命令入口 `ctx.commands.register({name, description, input, handler})`，host 侧执行、**不过模型** | 用户命令可 canonical 实现 |
| 7 | GUI 的 `session/list` 只在网关重连时拉取；工作区分组走 `workspace/follow` 增量流 | 注册表变更会推 upsert（分组可能自动更新），`summary.cwd` 可能需刷新页面——待实测 |
| 8 | Node 22.23 自带 `zlib.zstdCompressSync/DecompressSync`，dsh 自身即用 `node:zlib`（带 checksum 选项） | 帧手术在进程内完成，**不引外部 zstd CLI** |

## 用户使用路径

**路径 A — 模型（可选升级）**

```
cd {"path": "/path/to/other-project", "workspace": true}
```

- 本回合内：与今天一致，相对路径/默认 workdir 立即跟随该目录；
- 回合结束、会话空闲时：真正搬迁（header、磁盘、工作区账本、沙箱根、AGENTS.md/skills 全部跟随）；
- 结果文本会说明"已登记真切切换，本回合结束生效"。

**路径 B — 用户命令**

```
/cd <directory>   # 立即真切工作区切换（会话需空闲）
/cd               # 查看当前 cwd / 所属工作区 / 是否处于路径基准覆盖
```

**路径 C — 维持现状**：`cd {"path": "..."}`（不带 `workspace`）行为不变。

## 设计决策

- **D1 真切时机**：真切搬迁要求会话空闲（无运行中回合、无活跃子代理、写入句柄静止）。工具选项因此采用「本回合路径基准 + 回合结束搬迁」；命令要求空闲即时执行，运行中直接报错提示。
- **D2 工作区创建权限**：模型与用户**都可以**新建并切换工作区（用户决策，覆盖了"模型仅限已注册工作区"的初版建议）。代价必须如实记录并写进 README：在 `workspace-write` 沙箱模式下，模型可通过新建工作区把沙箱根指向任意已存在目录，即**模型可自主扩权**；`danger-full-access` 下无额外影响。缓解面：新建工作区是持久且可见的（侧边栏出现新分组、工具结果与命令回执都写明新建了哪个工作区），不是静默行为。
- **D3 语义分离**：工具 = 工作基准（可选提升为真切）；命令 = 会话身份（真切）。两者共享同一搬迁引擎。
- **D4 边界**：目标必须是已存在目录（realpath 规范化）；等于当前 cwd 时 no-op；目标是文件/不存在 → 明确报错。
- **D5 子代理**：存在活跃子代理时拒绝搬迁；历史子代理会话不随迁（它们的 cwd 是自己的历史）。
- **D6 失败处理**：不降级。搬迁任一步失败即回滚（删新副本、恢复内存、旧目录不动），把真实原因返回给调用方；工具路径下保留路径基准覆盖并在下一轮 runtime-context 里说明失败原因。

## 实现方案

### 模块拆分（当前 `src/index.ts` 单文件 ~390 行，加引擎后需拆）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件装配：cd 工具、影子工具、命令、agent 生命周期、回合结束钩子 |
| `src/state.ts` | 覆盖状态与 `state.json` 持久化（现 `CdState` 部分整体搬出） |
| `src/relocate.ts` | 真切搬迁引擎（磁盘帧手术 + 内存重绑 + 工作区账本），自成一体 |
| `src/command.ts` | `/cd` 命令实现 |

### 搬迁引擎 `relocate(session, targetDir)`

前置检查：目标是目录（realpath）、≠ 当前 cwd、会话空闲、无活跃子代理、持久化 flush 完成且写入句柄静止。

1. 计算目标路径 `sessions/<projectKey(newCwd)>/<encodeSegment(id)>/`；目标已存在 → 报错。
2. 逐代重写并投放：会话目录内每一代日志（`session.jsonl[.zst]`、`session.vN.jsonl[.zst]`，按规范名扫描，忽略 `.bak-*`）复制到目标目录，并重写**第一帧** header 的 cwd：
   - zstd：只解码帧 1 → 改 cwd → 用与 dsh 一致的 checksum 选项重编码为单帧 → 与其余原始帧逐字节拼接（**绝不整文件重压**，否则破坏"第一帧=仅 header"不变量）；
   - 非压缩：直接替换首行。
3. 校验副本：首帧 cwd == 新值、帧数与原文件一致；失败即删副本、中止。
4. 内存重绑：`session.header = { ...header, cwd: newCwd }`；写入句柄 `tracker.writers.get(id).header.cwd = newCwd`；失效 `coldLogMemo` 与相关投影缓存。
5. 删除旧目录（仅在第 3、4 步成功后）。
6. 工作区账本：`oldWorkspace.detachSession(id)` → `registry.create(newCwd, basename)`（已注册则复用，未注册则新建）→ `newWorkspace.attachSession(id)`（attach 会重读磁盘 header 做校验，所以必须在第 2 步之后）。
7. 清除该会话的路径基准覆盖状态。

### cd 工具

新增参数 `workspace?: boolean`（描述写明语义、限制与生效时机）。

- `workspace` 缺省/false：现状不变。
- `workspace: true`：校验目标是否为已注册工作区（realpath 比对）→ 设置路径基准覆盖 → 登记 pending relocation → 结果文本说明"本回合用该目录作工作基准，回合结束真正搬迁"。

### 回合结束钩子

订阅会话 `turn/end` 事件：若该会话有 pending relocation 且满足前置条件 → 执行搬迁；成功则清覆盖；失败保留覆盖，并把失败原因写进下一轮 runtime-context 文本。

### 命令

```ts
ctx.commands.register({
  name: "cd",
  description: "切换本会话的工作区（或查看当前工作区状态）",
  input: { hint: "[<directory>]" },
  handler
});
```

- 无参：返回 `header.cwd`、所属工作区（path/title）、路径基准覆盖状态。
- 有参：真切切换；空闲校验不通过 → `{kind:"error"}`，文案说明原因（如"会话正在运行，回合结束后再试"）。

### 文档与提示词

- runtime-context 文案区分两种模式，并说明真切切换后的生效范围与"可能需要刷新页面"。
- README（中/英）新增：`cd` 的 `workspace` 选项、`/cd` 命令、权限与兼容说明（搬迁会改会话存储位置与工作区归属；**模型可新建工作区**在 `workspace-write` 模式下等于可自主扩权，如实写明）。
- AGENTS.md 更新机制要点（header 可换引用、写入句柄重定向、工作区双向校验）。
- 新增 `docs/features/261012-workspace-switch/261012-workspace-switch.summary.md`（实施后）。

## 宿主假设的验证结果（已完成）

三点关键假设由隔离实例 GUI e2e 证实（13/13，详见 validation.md）：

1. `session.header` 换引用后下游一致跟随——搬迁后同一会话第二轮对话正常，文件工具与沙箱都按新目录工作。
2. `persistence.tracker.writers` 可从插件侧访问，重定向 `handle.header.cwd` 足以让后续追加落到新路径（第二轮日志在新目录增长 27292 → 38054 字节，旧目录未被重建）。
3. 冷读缓存未复活旧 cwd（`/cd` 命令产生的 `command/*` 事件写进了搬迁后的日志）。

未断言：搬迁后 GUI 侧边栏是否必须刷新页面（命令回执里提示 F5，e2e 用同一页面继续对话说明会话本身不需要刷新）；存在活跃子代理时的延后分支；进程重启后结算持久化 pending 的分支。

## 验证计划

- 静态：`pnpm check` + `pnpm build`。
- 帧手术自测：多帧 zstd / 非压缩 / 多代文件样本的往返校验（自造 fixture，脚本不进 npm files）。
- 隔离 e2e（一次窄跑，按 dsh-e2e 流程）：
  1. 命令搬迁：`/cd <dir>` 后磁盘出现在新 projectKey 目录、旧目录消失、`workspace.json` 归属更新、重启实例后仍在新工作区；
  2. 搬迁后相对路径 `write` 落到新目录（沙箱/文件工具跟随）；
  3. 工具选项：`cd --workspace` 后回合结束自动搬迁，下一轮 header.cwd 已是新值；
  4. 未注册工作区：模型调用与命令都会新建工作区记录，侧边栏出现新分组；
  5. GUI 分组刷新行为（记录事实）。
- 发布：minor 版本 `0.2.0`（新增能力、向后兼容），README 与 awesome 条目描述同步更新。

## 非目标

- 不改上游 dsh；不提供批量/跨会话搬迁 UI（用户命令只作用于当前会话）。
- 不搬历史子代理会话。
- 不做失败降级（D6）。
