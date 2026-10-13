# dsh-cd

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

把 `cd` 借给 dsh——工作基准要换就换，会话要搬就搬。`cd` 把后续工具的相对路径挪过去（轻、可逆）；`cd` 加上确认还能把整个会话搬到另一个项目（沙箱、AGENTS.md、skills、会话存储、侧边栏分组都跟着走）。

> 只想装一下？从 [装一行](#装一行) 一路读到底就能用。想看清两条粒度的边界与切换条件，往下读 [它给你什么](#它给你什么)。

## 装一行

```bash
dsh plugin --profile web add dsh-cd
```

装上之后无需改任何配置：插件自带的 `cordis.patch.yml` 自动挂载，多出 `cd` 工具与 `/cd` 命令。

从 GitHub 源码直装：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-cd
# 首次 add 会被 pnpm 拦截：把 pnpm 提示的包名加入
# ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 后重跑
```

## 它给你什么

### `cd`（工具）

两个粒度，**默认是轻的**。

| 粒度 | 调用 | 效果 |
|---|---|---|
| **基准覆盖** | `cd {"path": "..."}` | 把后续工具的相对路径解析挪到 `path`；会话身份不变 |
| **真切切换** | `cd {"path": "...", "workspace": true, "confirmed": true}` | 会话**整体**搬过去：沙箱根、AGENTS.md、skills 发现、会话存储、侧边栏分组都跟随 |
| 查询 | `cd {}` | 回报当前覆盖目录与排队中的真切切换 |
| 回退 | `cd {"path": "-"}` | 切回上一个覆盖目录 |

调用范例（`path` 支持绝对路径 / 相对路径 / `~` 开头；目标必须是已存在目录）：

```
cd {"path": "/tmp/some-dir"}
cd {"path": "/path/to/other-project", "workspace": true, "confirmed": true}
cd {}
cd {"path": "-"}
```

### `/cd`（用户命令）

输入框直接打，无需走工具调用（命令由宿主直接执行，不消耗模型回合）：

```
/cd <dir>    # 把这个会话搬到 <dir>（要求会话不在回合中）
/cd          # 查看当前目录、所属工作区、覆盖状态与排队中的真切切换
```

### 行为边界

装上之后你需要知道的几条：

- **覆盖影响**：`bash`/`pwsh` 默认 workdir；`read`/`write`/`edit`/`read_image`/`grep`/`glob`/`present` 的相对路径。其他工具按原语义，需要绝对路径。
- **覆盖不动的**：MCP 配置、沙箱策略根、项目指令（AGENTS.md）、skills 发现、会话存储位置——这些只在真切切换时才跟过去。
- **回答里的路径解析**：工具参数写到覆盖目录的相对路径会自动解析；但**回复里的 markdown 链接 / 图片 / 文件路径仍以会话工作区根为基准**——否则链在 GUI 上打不开。`cd` 回会话工作区根即清除覆盖。
- **跨重启**：覆盖状态持久化到 `$DSH_HOME/dsh-cd/state.json`（原子写、30 天未用自动剪除）；下次打开同一会话自动恢复。
- **子代理**：会话派生的子代理在创建时快照父会话的覆盖目录（不落盘）。
- **真切切换必须用户点头**：插件没有审批弹窗（默认 Full access 预设下会被自动拒绝），而是「先问、用户同意后重调带上 `confirmed: true`」的协议。`workspace: true` 但**不**带 `confirmed` 的调用只换基准，并在结果里回报「等待同意」。调用方不得自行补 `confirmed`。
- **真切切换只在空闲时搬迁**：调用方调 `workspace: true` 的回合仍按基准工作（相对路径立刻生效），回合结束空闲时自动完成搬迁。
- **工作树里一般不需要真切切换**：git worktree 协作场景下保持 `workspace: false` 即可；真切切换留给「工作重心长期搬走」的项目。

## 真切切换做了什么（实现参考）

dsh 没有官方的会话搬迁接口，本插件自己三步：

1. **磁盘**：会话目录迁到新工作区下，日志头部第一帧改写，其余帧**逐字节复制**，整文件不重压。
2. **内存**：换掉冻结的 `session.header`、重定向 JSONL 写入、刷新 header 索引。
3. **账本**：脱离旧工作区、绑定新工作区。

任意一步失败即回滚，搬迁不做失败降级。

## 权限与兼容

- **零网络、零外部服务**：仅维护本地「会话 → 覆盖目录」表，并调用宿主的工作区注册表 / 会话持久化服务。
- **写入**：`$DSH_HOME/dsh-cd/state.json`（原子写、30 天未用自动剪除）；真切切换还会**迁移会话自身的日志文件**并更新 `$DSH_HOME/storages/workspace.json` 的归属账本——这两个都是 dsh 自己的数据文件。
- **真切切换带同意闸**：搬迁只在调用同时带 `confirmed: true` 时排队；插件不提供绕过方式，也不降级。用户本人执行 `/cd <dir>` 不需要二次确认。
- **模型可以新建工作区**：`workspace: true, confirmed: true` 且目标尚非工作区时，插件会为它新建一条工作区记录。这意味着在 `workspace-write` 沙箱模式下，用户一旦同意搬迁，`cd` 即可把沙箱根指向任意已存在目录；`danger-full-access` 下无额外影响。若不接受，请勿向调用方授予 `cd` 工具或改用更受限的预设。
- **提示词而非机制**：回复里的路径基准由 DSH Web GUI 决定（固定为会话工作区根），插件无法改写模型输出，只能靠注入文案约束。
- **搬迁后 GUI 分组**：会话本身搬迁后立刻可用（e2e 已验证同一页面可继续对话），但侧边栏的分组依赖客户端缓存的会话列表，通常需要刷新页面（F5）才显示到新工作区下；`/cd` 回执会提示。
- **宿主版本要求**：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths` 声明为 `^0.1.5-rc.3 || ^0.2.0-rc.1` 的 peerDependencies（由宿主提供，不重复安装）；真切切换另需宿主的 `sessionPersistence` 与 `workspaceRegistry` 服务（`dsh-base` 提供，缺失时 `cd`/`/cd` 会明确报错）。Node.js ≥ 22.5。

## 开发

本地以 `link:` 方式接进 profile 调试：

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-cd@link:/path/to/dsh-cd
# 把 "dsh-cd" 加进 package.json 的 dsh.profile.bundles 数组，再重启 dsh
```

构建与测试：

```bash
npm install       # 触发 prepare → 构建 dist/
pnpm check        # 类型检查
npm test          # 构建 + 行为测试（帧手术 / 账本 / 回滚 / 真实日志往返）
npm run e2e:cd          # 基准覆盖 e2e
npm run e2e:workspace   # 真切切换 e2e
```

源码与设计记录：

- `src/index.ts`（装配）、`src/relocate.ts`（搬迁引擎）、`src/command.ts`、`src/context.ts`、`src/state.ts`
- `docs/features/260927-cd-tool/` 与 `docs/features/261012-workspace-switch/`

## 发新版

```bash
npm run release                                                # test + npm version patch（自动 commit+tag）+ pack 到 /tmp
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-cd-<新版>.tgz
git push --follow-tags
```

发布后用 `npm view dsh-cd version` 复验。

## License

MIT

## 社区

感谢 [LINUX DO](https://linux.do/) 社区提供的交流环境。
