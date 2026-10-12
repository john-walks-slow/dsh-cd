# 261012-workspace-switch 总结

**需求**：把 `cd` 从"只换路径基准"升级为**可真切切换会话所属工作区**（沙箱根、AGENTS.md、skills 发现、会话存储位置、侧边栏分组全部跟随），并给用户一个命令入口。

## 方案（关键决策）

调研结论（详见 explore.md）：dsh 把 `session.header.cwd` 当作不可变的会话身份——存储路径由它派生（`<root>/<projectKey(cwd)>/<encoded id>`）、工作区成员资格要求「id 在 `workspace.sessionIds` 中 **且** 磁盘 header 的 realpath 等于 `workspace.path`」、沙箱根与文件工具相对路径**每次调用现读**该 header；宿主**没有任何**搬迁/改 cwd 的 RPC。因此真切切换只能自己实现三步：改写日志第一帧 header + 把会话目录迁到新 projectKey + 重绑 workspace 账本。

选定的实现要点：

1. **磁盘**：Zstandard **帧保留手术**——只解码第一帧（dsh 保证第一帧恰好是 header 一行）、按该世代自己的 header 打补丁（只改 cwd，保留旧格式字段）、用与 dsh 一致的 checksum 选项重编码，其余帧逐字节复制。Node 22 自带 `node:zlib` zstd，**不依赖外部 zstd CLI**。
2. **内存**：`session.header` 是普通可写字段（对象深冻结，换引用即可）+ 重定向 JSONL 写入句柄 `tracker.writers.get(id).header.cwd`（否则搬迁后追加会写回旧路径/ENOENT）+ `workspaceRegistry.indexHeader()` 刷新注册表索引。
3. **账本**：`detachSession` 旧工作区 → `create(path)` 复用或新建 → `attachSession` 新工作区（attach 会重读磁盘 header 校验，故必须排在磁盘改写之后）。
4. **时机**：真切搬迁要求会话空闲（无运行中回合、无活跃子代理、写入句柄静止）。用户命令要求空闲即时执行；模型工具调用正在回合中，故采用「**本回合仍用路径基准 + 回合结束（`turn/end`）自动搬迁**」。
5. **权限**（用户决策）：模型与用户**都可以**新建工作区；代价是 `workspace-write` 沙箱模式下模型可借此把沙箱根指向任意已存在目录（README 已如实写明）。
6. **用户同意闸**（2026-10-12 追加）：真切切换改的是会话身份，因此 `workspace: true` 只在同一次调用带 `confirmed: true` 时才排队；不带 `confirmed` 的调用只换基准，并在工具结果与 runtime-context 里回报"等待用户同意、先问用户"。否决审批弹窗路线（Full access 预设 `approval: never` 会确定性拒绝审批请求，默认配置下走不通）。工作树场景不是豁免，而是本来就该传 `false`。
7. `session.header` / `tracker` / `config.root` 在 dsh 类型里是 private，插件用窄化结构类型访问并在缺失时报明确错误（不降级）。

## 交付物

- `src/relocate.ts`（搬迁引擎）、`src/command.ts`（`/cd` 命令）、`src/context.ts`（运行时上下文文案）、`src/state.ts`（状态与持久化，从 index.ts 拆出）
- `src/index.ts`：装配 + `cd` 工具新增 `workspace` 参数 + `turn/end` 钩子 + pending 搬迁结算
- `test/relocate.test.mjs`：7 条行为测试（帧手术逐字节、非压缩、多世代、失败回滚、no-op、projectKey/encodeSegment golden、真实 dsh 日志往返）
- `e2e/workspace-switch.mjs`：13 条断言的 GUI e2e
- README（中/英）/ AGENTS.md / docs/features/261012-workspace-switch/*

## 验证状态

静态（check/build）、单元（7/7）、隔离实例 e2e（13/13）全通过，详见 validation.md。发布状态：版本 `0.2.0`，待用户验收后推送与发布。

## 已知边界

- 搬迁后 GUI 侧边栏分组可能仍显示在旧工作区，需要刷新页面（命令回执里已提示）。
- 历史子代理会话不随迁；存在活跃子代理时回合结束不搬迁（延到下一次回合结束）。
- 磁盘搬迁是 copy → 校验 → 删旧；任何一步失败即回滚（删副本、恢复内存 header），旧目录始终不动。
