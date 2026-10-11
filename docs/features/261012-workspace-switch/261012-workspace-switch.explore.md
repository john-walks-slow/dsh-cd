# dsh 宿主源码探索报告：会话工作区（workspace / session.header.cwd）与 Slash Command 机制分析

本报告针对 `@deepseek-ai/dsh` 0.2.0-rc.2 宿主源码进行深入调研，厘清「会话工作区绑定与存储」、「会话搬迁/重绑定能力」、「磁盘 Header 可变性」、「Slash Command 注册机制」、「GUI 会话列表分组与响应」、「沙箱 workspace-write 判定」六项核心事实，为 `dsh-cd` 插件开发真切工作区能力提供底层依据。

---

## 1. 会话归属与存储布局

### 结论
1. **会话存储路径的派生机制**：
   - 存储根路径为 `$DSH_HOME/sessions`（默认为 `~/.dsh/sessions`）。
   - 派生规则为：`projectDir = path.join(root, projectKey(session.header.cwd))`。若 `cwd` 为 undefined 则归入 `_no-cwd`。
   - `projectKey(cwd)` 会将路径中的 `/`、`\`、`:` 统一折叠为 `-`，非安全字符编码为 `~XXXX`，并前后包裹双连字符，形如 `--root-projects-dsh-cd--`。
   - 会话目录为 `sessionDir = path.join(projectDir, encodeSegment(sessionId))`。
   - 会话物理文件为 `path.join(sessionDir, "session.v4.jsonl.zstd")`（或无压缩时的 `.jsonl`）。
2. **工作区（Workspace）实体与存在位置**：
   - Workspace 在 dsh 中由服务 `WorkspaceRegistry`（`ctx.workspaceRegistry`）统一管理。
   - 它是一个 schema-validated domain 存储实体，物理存储在 `$DSH_HOME/storages/workspace.json`（由 `dsh-storage-json` 管理的 `single` 格式 KV 存储）。
   - 数据结构包含全局状态 `workspaceDomainState`（`workspaceIds` 排序数组、`archivedSessionIds`、`pinnedSessionIds`）以及单表 `workspaces`，每条记录包含 `id`（UUID）、`path`（通过 `fs.realpath` 规范化后的绝对路径）、`title`、`sessionIds`（归属该工作区的会话 ID 数组）、`createdAt`、`updatedAt`。
3. **会话与工作区的关联规则（双向强校验）**：
   - 工作区记录的 `sessionIds` 只是候选名单（candidate account）。
   - 会话要真正被认定属于该工作区，必须满足**硬性双向约束**：`sessionId` 既要在 `workspace.sessionIds` 中，其物理读取出的 `session.header.cwd` 经 `fs.realpath` 后的规范化路径也必须严格等于 `workspace.path`。
   - 任何 cwd 不匹配的会话在内存投影时都会被过滤掉，并在后续写操作时被从 `workspace.sessionIds` 中永久剪除（prune）。
4. **GUI 侧边栏的会话分组依据**：
   - 侧边栏插槽 `sidebar.workspaces` 渲染组件依赖 `dsh-client-ui-workspace`。
   - 客户端根据从 Host 订阅的 `remote.workspace.follow()` 数据和 `remote.session.list()` 数据，调用 `groupByWorkspace(...)`。
   - 它按 Host 下发的工作区列表顺序遍历，取 `workspace.sessionIds` 中与当前 `list.byId[id]` 匹配的会话构成分组列表；任何不属于已知工作区或 cwd 不符的会话会被归入未分组的 `stray` 列表。

### 证据
- **路径与编码派生**：
  - `dsh-session-persistence-jsonl/lib/index.js:885-920`：
    ```javascript
    function projectKey(cwd) {
        if (cwd.length === 0) throw new Error("cannot encode an empty project path");
        let readable = "";
        let separatorRun = false;
        for (let i = 0; i < cwd.length; i++) {
            const code = cwd.charCodeAt(i);
            const ch = String.fromCharCode(code);
            if (ch === "/" || ch === "\\" || ch === ":") {
                if (!separatorRun) readable += "-";
                separatorRun = true;
            } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
                readable += ch;
                separatorRun = false;
            } else {
                readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
                separatorRun = false;
            }
        }
        return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
    }
    function projectDir(root, cwd) {
        if (cwd === void 0) return join(root, "_no-cwd");
        return join(root, projectKey(cwd));
    }
    function sessionDir(root, cwd, id) {
        return join(projectDir(root, cwd), encodeSegment(id));
    }
    function logPath(root, cwd, id, compression) {
        return generationLogPath(root, cwd, id, SESSION_FORMAT_VERSION, compression);
    }
    ```
- **配置根目录绑定**：
  - `dsh-base/cordis.patch.yml:130-134`：
    ```yaml
    - id: session-persistence-jsonl
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('sessions')
    ```
- **Workspace 存储与实体校验**：
  - `dsh-workspace/lib/types/spec.d.ts:16-24` / `dsh-workspace/lib/index.js:256-270`：
    - 定义了 `workspaceDomainSpec`，domain 名为 `"workspace"`，存入 `ctx.storage.domain`。
  - `dsh-workspace/lib/types/types.d.ts:60-75`：
    ```typescript
    export interface Workspace {
        readonly id: WorkspaceId;
        readonly path: string; // fs.realpath of path given at create time
        readonly title: string;
        readonly sessionIds: readonly SessionId[];
        // ...
    }
    ```
  - `dsh-workspace/lib/types/entity.d.ts:40-75`：
    > "Membership requires both an id in that account and a session header whose canonical cwd equals the workspace path... The durable candidate account is filtered synchronously: missing headers, invalid cwd values, and canonical cwd mismatches are never returned."
- **客户端侧边栏分组**：
  - `dsh-client-ui-workspace/lib/client.js:420-439`：
    ```javascript
    function groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {
        const current = mainSessionId(list);
        const groups = [];
        const accounted = new Set();
        for (const workspace of workspaces) {
            const members = [];
            for (const id of workspace.sessionIds) {
                const summary = list.byId[id];
                if (summary === void 0) continue;
                accounted.add(id);
                if (!sessionVisible(summary, current, archived, archivedFilter)) continue;
                members.push(summary);
            }
            if (archivedFilter === "only" && members.length === 0) continue;
            groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members));
        }
        const stray = list.ids.map((id) => list.byId[id]).filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, current, archived, archivedFilter));
        if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", orderedUngrouped(stray, ungroupedOrder, list.byId)));
        return groups;
    }
    ```

### 不确定项
- 无不确定项。存储结构、路径编解码、实体定义及前端分组逻辑在源码中全部有确凿实现。

---

## 2. 官方是否提供"搬迁会话 / 改 cwd"的能力与 RPC

### 结论
1. **完全不存在任何会话搬迁/改 cwd 的官方能力或 RPC**：
   - 在 `dsh-api-session-controller`、`dsh-api-workspace-controller`、`dsh-workspace`、`dsh-session-persistence`、`dsh-session-persistence-jsonl` 中，没有声明任何诸如 `move`、`relocate`、`re-pin`、`setCwd`、`changeCwd` 的方法。
   - `WorkspaceController` 提供的与移动相关的接口仅限于：
     - `insertBefore`：调整工作区在侧边栏的展示排序；
     - `insertSessionBefore`：调整同一工作区内部会话的前后展示排序。
   - `SessionPersistence` 接口仅定义了 `create`, `open`, `flush`, `stat`, `list`，没有提供修改元数据或重命名的通道。
2. **`ApiSessionCwdConflict` 细节**：
   - 定义位置：`dsh-api-session-controller/lib/types/agent.d.ts:18` 及 `dsh-api-session-controller/lib/index.js:96-105`。
   - 触发场景：在客户端尝试使用显式 `sessionId` 调用 `session.create`（即尝试绑定或领养一个既有会话）时：
     - 若该会话已经在内存中有活跃的 Agent 实例，且 `agent.session.header.cwd !== cwd`；
     - 或者该会话未活跃，但在持久化存储中已存在，通过 `sessionQuery.observeSession(sessionId)` 读出其磁盘 `observation.header.cwd !== cwd`。
   - 错误表现：构造异常 `new ApiSessionCwdConflict(sessionId, requestedCwd, existingCwd)`，并由网关层包装为 RPC 错误 `RemoteError("session/conflict")` 返回给前端。

### 证据
- **RPC 接口完整清单**：
  - `dsh-api-workspace-controller/lib/typert.remote-client.d.ts:18-30`：
    工作区所有 RPC 为：`archiveSession`, `create`, `delete`, `follow`, `initializeDefault`, `insertBefore`, `insertSessionBefore`, `pinSession`, `rename`, `unarchiveSession`, `unpinSession`。
  - `dsh-api-session-controller/lib/typert.remote-client.d.ts:14-30`：
    会话所有 RPC 为：`attachment`, `cancel`, `canOpenWorkspacePath`, `control`, `create`, `follow`, `fork`, `initializeDefaultModel`, `list`, `modelCatalog`, `openWorkspacePath`, `page`, `projections`, `prompt`, `rename`, `search`, `selectModel`, `updateQueue`, `workspacePathApplications`。
- **`ApiSessionCwdConflict` 源码**：
  - `dsh-api-session-controller/lib/index.js:96-105`：
    ```javascript
    var ApiSessionCwdConflict = class extends Error {
        requestedCwd;
        constructor(sessionId, requestedCwd, existingCwd) {
            super(existingCwd === void 0 ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"` : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`);
            this.requestedCwd = requestedCwd;
        }
    };
    ```
  - `dsh-api-session-controller/lib/index.js:273` & `426`：
    ```javascript
    // 在 ensureSession 中检查 live agent：
    if (agent.session.header.cwd !== cwd) throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd);

    // 在 createOrAdopt 中检查 persisted observation：
    if (observation.header.cwd !== cwd) throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd);
    ```

### 不确定项
- 宿主设计意图：dsh 设计上将 `session.header.cwd` 视作会话的不可变身份（immutable identity），所有跨工作区逻辑均通过创建新会话（New Session）或 `fork` 会话来处理，故意未设计运行时改绑路径的 API。

---

## 3. 磁盘 Header 可变性与规范做法

### 结论
1. **Header 的写入时机**：
   - 会话文件 `session.v4.jsonl.zstd` 中的 Header 是**在会话初次持久化物化（materialize）时只写一次（first record）**，后续所有事件交互（如消息、工具调用、模式切换）均通过追加帧（`appendLines` / append Zstandard frame）追加在文件尾部。
   - `HeaderLine` 格式为第一行 JSON：`{"type":"session","version":4,"id":...,"createdAt":...,"cwd":...}`。
2. **冷启动/重启时的读取来源**：
   - 冷启动或打开会话时，`dsh-session-persistence-jsonl` 会**直接从磁盘读取第一帧/第一行**，解析出 `HeaderLine`，验证结构后重建成 `SessionHeader` 对象；同时内存中仅持有一个带 LRU 的 `coldLogMemo` 缓存。
   - 若进程重启，内存缓存清空，完全以磁盘文件第一行的数据为准。
3. **将磁盘 Header 的 cwd 变更为新值的 Canonical 做法**：
   - 官方完全没有提供原位修改 Header 的逻辑。
   - 若要实现真正的底层搬迁，**必须在存储层进行物理迁移**：
     1. **释放写锁**：确保该会话在当前进程中处于关闭状态（无打开的 write handle、无活跃 Agent，或在进程关闭/隔离状态下操作）。
     2. **重写文件第 1 行**：读取旧的 `session.v*.jsonl[.zstd]` 文件，解压/读取第一行，将 `cwd` 字段替换为新的绝对路径；保留后续所有事件批次，重新编码压缩。
     3. **迁移文件目录**：因为目录路径强依赖 `projectKey(newCwd)`，必须将原本在 `$DSH_HOME/sessions/<oldProjectKey>/<encodedSessionId>` 下的文件移动到 `$DSH_HOME/sessions/<newProjectKey>/<encodedSessionId>`。
     4. **更新 Workspace 注册表**：修改 `$DSH_HOME/storages/workspace.json`（或通过 `WorkspaceRegistry` 的 `detachSession`/`attachSession`），将 `sessionId` 从旧工作区移除并加入新工作区，否则 `WorkspaceEntity` 会在下一次扫描时将 cwd 不符的会话从列表中 prune 剔除。
     5. **使缓存失效**：清除 `coldLogMemo` 以及 `session_projcache` 缓存。

### 证据
- **Materialize 与追加实现**：
  - `dsh-session-persistence-jsonl/lib/index.js:3111-3140`：
    ```javascript
    async materialize(meta, inheritedEventCount, events) {
        const project = projectDir(this.root, meta.cwd);
        const dir = sessionDir(this.root, meta.cwd, meta.id);
        const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression);
        // ...
        const content = await this.encodeMaterialization(meta, inheritedEventCount, events);
        // ...
    }
    async encodeMaterialization(meta, inheritedEventCount, events) {
        const header = JSON.stringify(toHeaderLine(meta, meta.isSeeded ? inheritedEventCount : void 0)) + "\n";
        if (events.length === 0) return this.compression === "none" ? header : compressZstdFrame(header);
        const body = eventLines(events) + "\n";
        if (this.compression === "none") return header + body;
        const headerFrame = await compressZstdFrame(header);
        const eventFrame = await compressZstdFrame(body);
        return Buffer.concat([headerFrame, eventFrame]);
    }
    ```
- **读取第一行逻辑**：
  - `dsh-session-persistence-jsonl/lib/index.js:3060-3075`：
    ```javascript
    first = this.compression === "zstd" ? await this.readFirstZstdLine(selected.sourcePath, signal) : await this.readFirstLine(selected.sourcePath, signal);
    // ...
    value = JSON.parse(first);
    assertNoRetiredHeaderFields(value);
    const result = sessionFormatCatalog.readHeader(value);
    const header = this.currentHeader(result.header);
    ```
- **追加阶段绝不再写 Header**：
  - `dsh-session-persistence-jsonl/lib/index.js:3215-3235`（`appendLines` 直接以 `"a"` 模式打开并写入编码后的 events）。

### 不确定项
- 若会话正被内存中的 Agent 占用并持有文件句柄（`open(..., "a")` 或 `session.lock` 文件），外部在磁盘上强行修改文件内容并移动目录会导致活动会话的写操作崩溃（`ENOENT` 或写入到旧文件描述符）。

---

## 4. 用户可调用命令（Slash Command）注册 API

### 结论
1. **命令服务定位**：
   - 宿主服务名：`ctx.commands`（来自包 `@deepseek-ai/dsh-commands`，服务类为 `CommandRuntime`）。
   - 在内置插件（如 `dsh-command-compact`、`dsh-command-goal`、`dsh-plan-mode`）中，插件的 `inject` 必须声明 `["commands"]`。
2. **命令定义契约（`CommandDefinition`）**：
   - `definitionId`: 可选，通常用 `CommandDefinitionId("your-package-name")`。
   - `name`: 必须为小写字母字符串，**不带前导斜杠**（例如 `"cd"` 而不是 `"/cd"`）。
   - `description`: 命令在 GUI 弹窗列表中展示的说明文案。
   - `input`: 可选对象，`{ hint: string, attachments?: boolean }`。`hint` 会在输入框补全时以灰色占位符/提示展现。
   - `handler`: `(invocation: CommandInvocation) => CommandResult | Promise<CommandResult>`。
     - `invocation` 包含：`agent`（当前执行的 Agent）、`rawInput`（命令名后带空格的原始字符串）、`commandId`、`signal`、`attachments`。
     - 返回值必须为 `{ kind: 'success', text?: string }` 或 `{ kind: 'error', text: string }`。
3. **客户端呈现与交互流程**：
   - 前端包 `@deepseek-ai/dsh-client-ui-commands` 监听用户的 `/` 触发器输入。
   - 打开弹窗时，前端通过 RPC `ctx.remote.commands.list(sessionId)` 向 Host 请求当前可用命令列表（会结合全局命令和当前 agent-scoped 遮蔽命令）。
   - 回车或空格提交时，前端直接调用 RPC `ctx.remote.commands.execute(sessionId, line, attachments)`，Host 执行该命令并在会话日志中追加 `command/run` 与 `command/done` 生命周期事件，而**完全不发送给大模型（never model surface）**。

### 证据
- **`CommandRuntime.register` 接口与事件**：
  - `dsh-commands/lib/types/index.d.ts:40-60` 及 `260-275`：
    ```typescript
    export interface CommandDefinition {
        readonly definitionId?: CommandDefinitionId;
        readonly name: string;
        readonly description: string;
        readonly input?: CommandInputDescriptor;
        readonly recordInput?: boolean;
        readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
    }
    ```
- **内置插件实装范例**：
  - `dsh-command-compact/lib/index.js:9-10 & 90-100`：
    ```javascript
    const name = "command-compact";
    const inject = ["commands", "compaction"];
    function apply(ctx) {
        ctx.commands.register({
            definitionId: CommandDefinitionId("@deepseek-ai/dsh-command-compact"),
            name: "compact",
            description: "Compact older conversation history",
            handler: (invocation) => executeCompact(ctx, invocation)
        });
    }
    ```
  - `dsh-command-goal/lib/index.js:10 & 174-184`：
    ```javascript
    const name = "command-goal";
    const inject = ["commands", "goals"];
    function apply(ctx) {
        ctx.commands.register({
            definitionId: CommandDefinitionId("@deepseek-ai/dsh-command-goal"),
            name: "goal",
            description: "Set or view the goal for a long-running task",
            input: {
                hint: "[<objective>|clear|edit <objective>|pause|resume]",
                attachments: true
            },
            handler: (invocation) => executeGoalCommand(ctx, invocation)
        });
    }
    ```

### 最小可用示例代码（Plugin 实现）
```typescript
import { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';

export const name = 'dsh-plugin-sample-command';
export const inject = ['commands'];

export function apply(ctx: Context) {
  const dispose = ctx.commands.register({
    name: 'switch-workspace',
    description: '切换当前会话绑定的工作区目录',
    input: {
      hint: '<target-path>',
    },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const targetPath = invocation.rawInput.trim();
      if (!targetPath) {
        return {
          kind: 'error',
          text: '用法: /switch-workspace <目标绝对路径>',
        };
      }
      
      // 业务处理逻辑 ...
      
      return {
        kind: 'success',
        text: `已准备切换至: ${targetPath}`,
      };
    },
  });

  // 随插件生命周期注销
  ctx.on('dispose', () => {
    dispose();
  });
}
```

### 不确定项
- 无不确定项。注册协议与交互契约完备且已被官方多个内置命令稳定使用。

---

## 5. GUI 会话列表与响应更新机制

### 结论
1. **会话列表的 RPC 与数据源**：
   - 基础会话数据来自 RPC：`remote.session.list({})`（Host 对应 `ApiSessionList.list()`）。
   - 响应结构为 `SessionListValue { items: SessionSummary[] }`，每一项 `SessionSummary` **显式携带 `cwd` 字段**（来自于会话的 `header.cwd`）。
   - 工作区与树形分组数据来自 RPC 流：`remote.workspace.follow()`（Host 对应 `WorkspaceController.follow()`），下发全量 baseline 与后续的增量更新（`upsert`、`remove`、`order`、`pinned`、`archived`）。
2. **若某会话在后端 cwd 改变，GUI 是否需要刷新（Reload）？**：
   - **需要页面刷新（Reload），或者必须重新拉取会话列表**。
   - 原因：
     1. `remote.session.list({})` 不是持久长连接流（Push Stream），它是一个单次拉取的 RPC 调用。
     2. 客户端 `SessionManager`（`dsh-api-session-controller/lib/client.js`）只在特定时机触发 `refreshList()`（如初次建立连接、重连 `handleConnected()`、或本地创建/删除会话的显式突变）。Host 侧**没有**在会话元数据（如 cwd）发生变动时主动通知客户端 `session.list` 发生变化的全局广播事件。
     3. 客户端侧边栏在分组渲染 `deriveGroups(...)` 时，读取的是内存快照中的 `list.byId[id]`。如果后端只静默改动了底层存储，客户端快照不会自发检测到 `cwd` 的变更，导致视图保持旧分组，直至用户刷新页面触发新的 `remote.session.list()` 和 `remote.workspace.follow()`。

### 证据
- **`SessionSummary` 包含 `cwd` 字段**：
  - `dsh-api-session-controller/lib/types/types.d.ts:160-170`：
    ```typescript
    export interface SessionSummary {
        readonly agentAvailable: boolean;
        readonly sessionId: SessionId;
        readonly updatedAt: number;
        readonly running: boolean;
        readonly blank: boolean;
        readonly parentSessionId?: SessionId;
        readonly origin?: 'subagent';
        readonly cwd?: string;
        readonly projections?: SessionProjectionHints;
    }
    ```
- **会话列表拉取时机**：
  - `dsh-api-session-controller/lib/client.js:2603-2645`：
    `refreshList()` 发起 `await this.remote.session.list({})`。
  - `dsh-api-session-controller/lib/client.js:2923-2928`：
    只在网关重连 `handleConnected()` 时调用 `this.refreshList()`。
- **侧边栏分组直接依赖 `summary.cwd` 与 `workspace.sessionIds`**：
  - `dsh-client-ui-workspace/lib/client.js:426-435`（见第 1 条证据）。

### 不确定项
- 客户端暂无公开的 RPC 方法允许第三方插件命令触发客户端执行 `ctx.sessionController.refresh()`（该方法在客户端内部 `SessionManager` 上，但非远程 RPC）。因此若不通过 Web 插件向前端注入信号，纯后端修改后只能依赖用户手动刷新浏览器页面。

---

## 6. 沙箱（Sandbox）`workspace-write` 根路径判定

### 结论
1. **沙箱根路径的读取时机**：
   - **每次工具调用（Tool Execution）时现读，绝非进程启动时缓存**。
2. **读取与解析逻辑**：
   - 核心服务为 `ctx.sandboxPolicy`（来自 `@deepseek-ai/dsh-sandbox-policy`）。
   - 在各工具执行入口（例如 `dsh-tool-fs` 的 `write`/`edit`，`dsh-tool-bash` 的命令执行，`dsh-plugin-manager` 等）：
     - 每次执行均会调用：
       ```javascript
       const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
       ```
     - 在 `SandboxPolicyService.resolve(...)` 内部，按如下逻辑动态解析：
       ```javascript
       workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)
       ```
   - 只要工具执行时传入的 `session.header.cwd` 发生变化，或者运行时 `session` 对象上能够反映出新的 `header.cwd`，沙箱在当下工具调用时便会即时以新的路径作为 `workspace-write` 的合法根路径。
   - 此外，文件工具在解析相对路径时（`dsh-tool-fs/lib/index.js`），也是在每次调用时通过 `exec.agent.session.header.cwd` 解析相对路径。

### 证据
- **`resolve` 源码**：
  - `dsh-sandbox-policy/lib/index.js:141-148`：
    ```javascript
    resolve(request = {}) {
        const { session } = request;
        return {
            mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,
            workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
            ...session === void 0 ? {} : { sessionId: session.id }
        };
    }
    ```
- **工具层调用证明（每次调用执行）**：
  - `dsh-tool-bash/lib/index.js:349`：
    ```javascript
    const resolveSandboxPolicy = (exec) => sandboxPolicy?.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session });
    ```
  - `dsh-tool-fs/lib/index.js:581-582`：
    ```javascript
    const sandboxPolicy = await sandbox.resolvePolicy("write", args, exec);
    const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, sandboxPolicy?.workspaceRoot));
    ```

### 不确定项
- 虽为每次现读 `session.header.cwd`，但由于 `session.header` 在运行时被深冻结（`deepFreeze`）且属性为 `readonly`，运行时直接对 `agent.session.header.cwd` 赋值会触发不可写异常；如果通过黑客手段（如 `Object.defineProperty`）热补丁覆写了运行时 `session.header.cwd`，内存中当下是可以立即影响后续沙箱判定的，但若未同步持久化，重启后依然会失效。

---

## 总结与对 `dsh-cd` 插件的指导意义

1. **为什么原插件只做“路径基准覆盖”**：
   由于 dsh 将 `session.header.cwd` 设计为不可变身份，直接牵动了物理落盘路径（`sessions/--root-.../`）、工作区成员资格（`workspace.sessionIds` 强一致校验）以及沙箱根目录，修改它的“牵一发而动全身”程度极高。
2. **若要实现“真切工作区”的路径与技术挑战**：
   - **Slash Command 入口**：通过 `ctx.commands.register` 注册 `/cd` 或 `/switch-workspace` 命令可行且 canonical，可直接接收用户输入并同步返回执行状态。
   - **运行时不可变性突破**：需在内存中更新当前 `agent.session.header`（或构造代理），以使沙箱 `ctx.sandboxPolicy.resolve({ session })` 与工具相对路径即时指向新目录。
   - **物理搬迁不可缺**：若要让会话在重启/刷新后依然留在新工作区，必须同步重写该会话物理日志的第 1 行 Header，将磁盘文件移至新 `projectKey(cwd)` 对应目录，并在 `workspace.json` 中执行注销与重新绑定。
   - **前端感知**：改绑后 GUI 不会自动刷新侧边栏分组，通常需要提示用户刷新浏览器（F5）以重新加载工作区归属。
