# dsh-cd

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）补一个 `cd` 工具：让模型在会话内**原地切换工作目录**。切换之后，文件工具的相对路径和 bash 的默认工作目录都解析到新目录，而不需要每条命令都写绝对路径。

## 是什么 / 为什么需要

dsh 会话的工作目录（`session.header.cwd`）在创建时冻结，是会话身份的一部分——它决定会话存储位置、沙箱根、AGENTS.md 与 skills 的发现根，因此 dsh 出于设计不支持中途修改它。于是模型在需要操作工作区之外的目录时（比如"去 /tmp 帮我整理这些日志"），只能在每一次 read/write/bash 调用里写完整绝对路径，又长又容易错。

dsh-cd 注册一个模型可调用的 `cd` 工具来解决这个问题：它不动会话身份，只在工具执行层为当前会话维护一个"工作目录覆盖"。调用 `cd /some/dir` 之后：

| 工具 | 行为变化 |
|---|---|
| `bash` / `pwsh` | 不传 `workdir` 时，默认在新目录执行；相对 `workdir` 也解析到新目录 |
| `read` / `write` / `edit` / `read_image` | 相对 `file_path` 解析到新目录 |
| `glob` / `grep` | 不传 `path` 时默认搜新目录；相对 `path` 解析到新目录 |
| `present` | `files[].path` 相对路径解析到新目录 |
| 其他工具 | 不受影响，仍按原语义（需要绝对路径） |

**明确不迁移的**（会话工作区根保持不变）：沙箱策略根、项目指令（AGENTS.md）、skills 发现、MCP 配置、会话存储位置。`cd 回会话工作区根` 即清除覆盖，恢复原状。

## 安装

以 web profile 为例（其他 profile 同理）：

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-cd@link:/root/projects/dsh-cd   # 或发布后的版本号
```

编辑 `~/.dsh/profiles/web/package.json`，把 `dsh-cd` 加进 `dsh.profile.bundles` 数组：

```json
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "dsh-cd"
    ]
  }
}
```

然后重启 dsh 生效。

## 使用

无需配置，装上即生效。模型多了一个 `cd` 工具：

```
cd {"path": "/tmp/some-dir"}   # 绝对路径 / 相对路径 / ~ 开头
cd {"path": "-"}               # 回到上一个目录
cd {}                          # 查询当前目录（返回 cwd、override、previous）
```

细节行为：

- 目标必须是已存在的目录（符号链接会解析成真实路径），否则报错。
- 覆盖是**按会话**隔离的：一个会话 cd 走不影响其他会话。
- cd 回会话工作区根 = 清除覆盖，一切回到原状。
- 切换后系统提示里会注入一段说明（cache 安全的 runtime-context 快照，仅覆盖激活时存在）：**工具参数的**相对路径解析到覆盖目录，而**回答里的** markdown 链接/图片/文件提及仍以会话工作区根为基准（必须写工作区相对路径或绝对路径，否则链不上），以及不迁移的边界。
- **跨重启持久化**：覆盖状态写入 `$DSH_HOME/dsh-cd/state.json`（原子写，30 天未使用自动剪除）。实例重启后再打开该会话，覆盖自动恢复。
- **子代理继承**：会话派生的子代理在创建时快照父会话的覆盖目录（继承条目不落盘）。

## 开发

```bash
pnpm build   # tsc 编译到 dist/
pnpm check   # 类型检查
```

- 源码就一个文件：`src/index.ts`。
- e2e：`e2e/cd-tool.mjs`（GUI 驱动，需按 [dsh-e2e](file:///root/.agents/skills) 流程起隔离实例后运行）。

## License

MIT
