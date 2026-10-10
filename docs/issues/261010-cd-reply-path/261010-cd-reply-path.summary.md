# 261010-cd-reply-path 总结

**问题**：`cd` 之后，模型在回答里给出的相对路径（markdown 链接/图片、文件提及）也按覆盖目录为基准书写，导致 GUI 里链不上。

## 根因

dsh 里存在两个不同的路径基准，dsh-cd 只改了工具侧，没告诉模型回答侧没变：

- **工具参数**：dsh-cd 在注册表影子层把相对路径解析到覆盖目录（`entry.cwd`）。
- **回答里的路径**：GUI 点击链接时按 `sessions.list[sessionId].cwd`（= 冻结的 `session.header.cwd`，即会话工作区根）解析（`dsh-util-workspace-path` 的 `sessionFileAddress`）。dsh-cd 明确不动会话身份，所以这个基准始终是工作区根。

原注入文案只强调了"相对路径解析到覆盖目录"，等于**主动**把模型往错误基准上引。

## 修复

`contextTextFor`（runtime-context 快照文案）补齐第二种基准：明确"回答里的链接/图片/文件提及以会话工作区根为基准"，并在覆盖目录位于工作区根之内时给出换算示例（`entry.cwd` 下 `report.md` → 写成 `workspaceRelative(root, entry.cwd)/report.md`）。`cd` 工具描述同步加一句同义提示（常驻 schema，每次请求可见）。

注入时机无需额外机制：`preStep` 每个模型步骤都重渲染快照，且仅在文本变化时注入一次并留在会话 surface 上——`cd` 之后的**下一步**模型就能看到新规则，之后每轮持续可见。

## 验证

- `pnpm check` + `pnpm build` 通过。
- `workspaceRelative` 换算自检：根内子目录 → 相对路径；等于根、根外目录、不相关目录 → `undefined`（不输出示例）。
- 未跑 GUI e2e：本次是纯注入文案改动（插件运行时行为未变），且当前机器可用内存 ~670MB、swap 已用 4.8G，不起实例 + 浏览器更稳妥。

## 未覆盖面

回答侧路径基准由 GUI 决定，插件无法改写模型输出，只能靠提示词约束——模型不遵守时仍会链不上；若实测仍高频出错，可考虑在文案中加强示例或改为要求一律绝对路径。
