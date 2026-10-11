# 261012-workspace-switch 验证记录

## 静态与单元（全通过）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm check` | 零错误 |
| 构建 | `pnpm build` | `dist/{index,state,context,relocate,command}.js` |
| 行为测试 | `npm test`（build + `node --test test/*.test.mjs`） | **7/7 通过** |

`test/relocate.test.mjs` 覆盖：projectKey / encodeSegment 与磁盘既有目录名一致的 golden 值；压缩多帧日志搬迁后**除第一帧外逐字节不变**且被参考解码器 `zstd -dc` 完整读回；非压缩日志；多世代同时改写；attach 失败时**全量回滚**（内存 header、写入句柄、旧目录、新副本）；目标等于当前目录时 no-op；以及**本机真实 dsh 会话日志**的跨目录往返（帧一 = 补丁后 header 一行、事件逐行等价）。

## GUI e2e（隔离实例，13/13 通过）

命令：`dsh-e2e start --patch <用户层 patch（补 llm-pi-ai provider 配置）>` → `dsh-e2e run e2e/workspace-switch.mjs`（隔离 home `<worktree>/.dsh-e2e-home`，端口 acquire-port 动态分配）。

流程：GUI 新建会话 → 模型执行 `cd {"path": A, "workspace": true}` + 一次相对路径 `write` → 回合结束由插件自动真搬迁 → 断言 → 同一会话第二轮对话 → 再执行 `/cd B` 命令。

| # | 断言 | 结果 |
|---|---|---|
| 1 | 模型确实调用了 `cd` 与 `write` | PASS |
| 2 | 会话日志已移动到目标工作区目录 `--tmp-dsh-cd-ws-a-<ts>--` | PASS |
| 3 | 磁盘 header 的 cwd 已是目标目录 | PASS |
| 4 | 原会话目录已消失 | PASS |
| 5 | 相对路径 `write` 落在新目录 | PASS |
| 6 | `storages/workspace.json` 把该会话记到新工作区 | PASS |
| 7 | 真切切换后路径基准覆盖被清除 | PASS |
| 8 | 搬迁后第二轮对话仍写入**新目录**（写入句柄重定向有效） | PASS |
| 9 | 第二轮后日志增长（27292 → 38054 字节） | PASS |
| 10 | 旧目录没有被重新创建（同一会话没有分裂成两个文件） | PASS |
| 11 | `/cd <dir>` 命令把同一会话再迁到新目录 | PASS |
| 12 | 命令后磁盘 header 已是命令指定的目录 | PASS |
| 13 | 会话日志里记录了命令回执（`Moved this session to …`） | PASS |

spike 阶段列出的 5 处宿主内部假设由此全部证实：header 换引用后下游（文件工具/沙箱/持久化）一致跟随；`tracker.writers` 可达且重定向句柄足以让后续追加落到新路径；冷读缓存未复活旧 cwd（命令事件写入了搬迁后的日志）；回合结束边界确实空闲（搬迁如期执行）；活跃子代理的延后分支未在该流程触发。

## 未覆盖 / 未断言

- **GUI 分组刷新**：搬迁后侧边栏是否需要刷新页面未做断言（命令回执里已提示用户 F5）。e2e 用同一页面继续对话，说明会话本身不需要刷新。
- **活跃子代理时的延后**：未构造该场景（代码路径为「延到下一次回合结束」）。
- **持久化的 pending 搬迁**：进程重启后再结算的分支未做行为级断言。
- **npm 发布产物**：`0.2.0` 的 pack / scratch 安装验证留到发布时执行。
