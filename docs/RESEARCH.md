# dsh-shell-getaway — 核心调研与实施方案

> **目标**：让 agent 在 Windows 上能把默认的 PowerShell 换成 bash（Git Bash / WSL2 / Cygwin），
> 不再为 PowerShell 5/7 的转义、引号、`$env:`、`-Command` 长难句买单。
> **本轮只做调研与规划**，不落代码。
>
> 环境：DSH `0.2.0-rc.2`（desktop profile）· Node `24.21.0` · Windows 11 22631
> DSH 源码：`F:\dsh\resources\app.asar`（已解包到 `.research/dsh-src/`）
> 实测机器：已装 Git for Windows（bash 5.2.21 msys）、Cygwin 3.5.4、WSL2 3.0.3.0（Ubuntu + docker-desktop，kernel 6.18.54.1）
>
> **状态**：调研完成 → 用户已拍板 2 项（§13）→ 等待 agent 4 环境报告后出最终 plan。
> **计划中的决策**：① 默认 Git Bash，WSL2 一等公民；② 沙箱问题**必须显式报错**（fail closed）。
>
> ⚠️ **勘误**：§6.3 的初版结论（"反斜杠被 MSYS2 剥离"）**是错的**，已在原位更正 ——
> 见 §6.3 的 7 组对照实测。§6.7b 的 `-lc` 启动开销也是补充的新数据（**+1.22 s/次**）。

---

## 0. 结论速览

| # | 结论 | 依据 |
|---|---|---|
| 1 | DSH **没有**"运行时切换 shell"的现成开关；选择发生在**组合期**，由 `cordis.patch.yml` 里 `!!js process.platform === 'win32'` 决定，而 `!!js` **读不到用户设置** | `dsh-base/cordis.patch.yml:235-273`、`web-app/presets/standard.patch.yml:20-25` |
| 2 | **一个组合只能挂一个 `ctx.shell` 提供者**（第二个注册直接抛错）。`bash`/`pwsh` 两个 tool 都只是它的外壳 | `dsh-shell/lib/index.js:83-93` |
| 3 | 所以正确实现面 = **自带一个 `ctx.shell` 实现** + **挡住另一个 tool** + **补齐方言文本** | §3 |
| 4 | `dsh-pwsh-local` 已把 `argv(spec)` 抽成**官方扩展点**（`dsh-pwsh-sandbox` 就这么复用）→ 我们**继承 `PwshLocalExecutor`、只覆写 `argv()`**，免费拿到 deadline / job / spill / 输出渲染全套 | `dsh-pwsh-local/lib/index.js:197-206` |
| 5 | `tool-bash` 与 `tool-pwsh` 是**逐行孪生**，只差 tool 名、描述文本、prompt section 文本、workdir 解析 | `dsh-tool-bash/lib/index.js`（713 行）vs `dsh-tool-pwsh`（715 行） |
| 6 | **所以不需要自己写 tool**：直接用官方的 `@deepseek-ai/dsh-tool-bash`，它自带正确的 `bash` 描述和 prompt section | §4.1 |
| 7 | 本机裸名 `bash` 解析是**有毒的**：第一个可解析的是 `C:\WINDOWS\System32\bash.exe`（WSL 启动器），Git Bash **根本不在 PATH 上** → 必须绝对路径 + 身份校验 | 实测 §6.1 |
| 8 | Git Bash 经 DSH 的 Win32 进程层跑 argv **完全可靠**：多行脚本、混合引号、非 ASCII、fork、cwd 全部实测通过。**我们不需要任何转义层** | 实测 §6.2 / §6.8 |
| 9 | ⚠️ **已更正**：反斜杠**不会**在宿主边界或 shell 层被剥离（argv 逐字存活、`ls` 能访问 `F:\...`）。真正的失败来自**消费该路径的工具**（`git -C 'C:\x'` 报错，而 `/f/x`、`F:/x` 都行），以及**未加引号的 `\U` 转义**与 **printf 格式串转义**。所以是"改用正斜杠"的建议，不是"禁令" | 实测 §6.3（7 组对照） |
| 9b | `-lc` 每次多花 **~1.22 s**（1350 ms vs 134 ms，5 次均值）；且 `-lc` 会把 `LANG` 设为 `en_US.UTF-8`，`--noprofile --norc` 下 `LANG` **是 unset** → 必须显式注入 `LANG` | 实测 §6.7b |
| 9c | 🔴 **新发现（严重）**：MSYS2 会**静默改写传给原生 Windows 程序的 POSIX 形态参数**。`/data` → `C:/Program Files/Git/data`；`/data:/mnt/x` → `C:\Program Files\Git\data;C:\Program Files\Git\mnt\x`（`:` 还被改成 `;`！）。这会让 `docker run -v /data:/x` **静默挂载错误目录**。修复：`MSYS_NO_PATHCONV=1`（或 `MSYS2_ARG_CONV_EXCL=*`），实测**零副作用** | 实测 §6.3b（原生 argv oracle） |
| 10 | `spec.cwd` **必须是 Windows 形态**；传 POSIX 路径会让 spawn 以 `ENOENT` 失败，且错误信息会**甩锅给可执行文件** | 实测 §6.4 |
| 11 | Git Bash 输出是**精确 UTF-8**（字节级验证通过），DSH 的 `Buffer.toString('utf8')` 直接可吃，**零解码层** | 实测 §6.7b |
| 12 | `bash -c` 脚本上限 ≈ **32720 字符**（Windows `CreateProcess` 32767 限制）；`bash -s` + stdin 已验证可跑 50k | 实测 §6.6b |
| 13 | WSL 的**命令输出是 UTF-8**（只有 `wsl -l -q` 之类元数据是 UTF-16LE）→ 比预想乐观 | 实测 §6.6 |
| 14 | **Git Bash 与 WSL 都不该走 Windows ACL 沙箱**：Git Bash 撞 MSYS2 的 console isolation / named pipe 边界；WSL 的受限令牌**根本穿不过 Hyper-V 边界** | `04-seam-contracts.md` §3.5 |
| 15 | `SHELL_SETTINGS_NAMESPACE` **在 0.2.0-rc.2 里不存在**（README 说谎）；真正的设置命名空间是 **profile entry id**（`bash-sandbox`/`pwsh-sandbox`） | `dsh-shell/lib/index.js:95`、`dsh-settings/lib/index.js:307` |
| 16 | 切换 shell 会**静默丢掉**一条 Windows 事实："强杀 settle 为 `[exit code: 1]` 无 signal marker" —— 它**只写在 `tool:pwsh` 的 prompt section 里** | `dsh-tool-pwsh/lib/index.js:348-352` vs `dsh-tool-bash:377-381` |
| 17 | 本仓库**不发布任何 `.d.ts`**（尽管每个 `package.json` 都声明了），所有类型需从编译产物反推 | `04-seam-contracts.md` §0 |

**推荐方案（TL;DR）**

做一个 **Host-only bundle**（工作区里两个文件：`package.json` + `cordis.patch.yml`），
用官方的 `plugin_manager install_bundle` 安装（**不要手改 profile 文件**）：

1. **执行器**：`apply()` 内 `ctx.plugin(GetawayExecutor, config)`，
   其中 `GetawayExecutor extends PwshLocalExecutor`，只覆写 `argv()` / `resolve()`
   → 内部按配置派发到 `pwsh` / Git Bash / WSL / Cygwin；
2. **tool 面**：复用官方 `@deepseek-ai/dsh-tool-bash`（省掉 700 行孪生代码）；
3. **挡住旧 tool**：**不能**用 `ctx.tools.restrict()`（它只能在 `agent.ctx` 上调用，全局调用直接抛错）
   → 改为在 bundle patch 里**覆盖 `preset-standard` 声明**并把 `tool-pwsh` 设为 `disabled: true`；
4. **补文本**：一个 `ctx.systemPrompt.section()` 找回"Windows 强杀 = exit 1"这条事实 + 教 POSIX 路径与方言；
5. **环境变量**：`ctx.shellEnv.register()` 注入 POSIX 化变量。

**必须注意**：patch 是**整体替换 `config`、绝不深合并** —— 覆盖 `preset-standard` 时要逐字复述 shipped 列表。

**需要你拍板的 4 件事**见 §12。

---

## 1. 现状：DSH 的 shell 能力怎么搭起来的

### 1.1 分层结构

```
模型看到的 tool            bash / pwsh            ← dsh-tool-bash / dsh-tool-pwsh（孪生，可互换）
        ↓ ctx.shell.execute(spec)
执行能力 seam（全局唯一）  ctx.shell              ← dsh-shell（抽象 Service）
        ↓ 唯一 Provider
执行器实现                 LocalBashExecutor      ← dsh-bash-local   argv = ["bash","-c",cmd]
                          PwshLocalExecutor      ← dsh-pwsh-local   argv = [pwsh,...,"-Command",cmd]
                          SandboxBashExecutor    ← dsh-bash-sandbox （继承 bash-local）
                          SandboxPwshExecutor    ← dsh-pwsh-sandbox （继承 pwsh-local）
        ↓ ctx.subprocess.spawn(spec)
进程服务                   ctx.subprocess         ← dsh-subprocess-local
        ↓ Windows: Win32 Job runner（受限令牌 / 托管进程区间）
```

### 1.2 tool 层是纯文本差异（这是最大的机会）

已确证：`dsh-tool-bash`（713 行）与 `dsh-tool-pwsh`（715 行）**逐行镜像**，
只在 5 处不同：

| 差异点 | bash | pwsh |
|---|---|---|
| tool 名 | `bash` | `pwsh` |
| 描述构造器 | `bashDescription()` | `pwshDescription(escalation)`（多一段 Windows 沙箱附录） |
| prompt section | `tool:bash` order **1000**，文本 1 句 | `tool:pwsh` order **1010**，文本 2 句 |
| `description` 参数示例 | `"git status" → ...` | `"Get-Process" → "List running processes"` |
| workdir 解析 | 裸 `${sep}` 拼接（**有 bug**，会产出 `C:\ws/rel`） | `node:path.resolve`（正确） |
| job `kind` | `"bash"` | `"pwsh"` |

→ **结论**：换 shell 的真正工作量，绝大部分落在"选哪个 executor"和"给模型看什么文本"上，
**而不是重写 tool**。这直接决定了推荐方案（§3.1）。

### 1.3 选择发生在组合期（核心约束）

`dsh-base/cordis.patch.yml:235-273`：

```yaml
    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform === 'win32'
    - id: pwsh-sandbox
      name: '@deepseek-ai/dsh-pwsh-sandbox'
      disabled: !!js process.platform !== 'win32'
    ...
    - id: tool-bash
      name: '@deepseek-ai/dsh-tool-bash'
      disabled: !!js process.platform === 'win32'
    - id: tool-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh'
      disabled: !!js process.platform !== 'win32'
```

`dsh-web-app/presets/standard.patch.yml:20-25` 里**每个 agent preset 又重 declare 了一遍同样的判断**。
本会话的实时插件清单印证：`include:pwsh-sandbox` = active，`include:bash-sandbox` = disabled。

`!!js` 只能看到 `process.platform`，**读不到 profile 设置或 settings 服务**
→ "让用户在设置里选 shell 并即时生效"**不可能靠改 patch 实现**，只能在插件内部派发。

### 1.4 三个"看起来能用、其实不够"的现成后门

| 后门 | 为什么不够 |
|---|---|
| `dsh-pwsh-local.config.pwshPath` | 只换可执行文件，argv 仍是 `-NoLogo -NoProfile -NonInteractive -Command <ps>`；喂 bash 会语法错误 |
| `dsh-terminal-bash.config.shellDialect/shellPath/shellArgs` | **确实支持双方言 + 任意 shellPath**，但它是**持久交互式 PTY 会话**，绑在 `dsh-tool-bash-persistent` 上，工具面与 one-shot 完全不同 |
| 直接启用 `dsh-bash-sandbox` | argv 硬编码 `["bash","-c",cmd]`，**没有 `bashPath` 配置**；本机裸 `bash` 解析到 WSL 启动器（§6.1）；官方明确把 win32 排除在支持外 |

> **现成积木里没有一块能直接完成这件事，必须写插件。**
> 但 `argv()` 扩展点 + `dsh-tool-bash` 的文本层，让插件体量可以压到 ~400 行。

---

## 2. 目标拆解

用户痛点原话："PowerShell 5/7 的转义、字符太过于坑人"。

具体到 DSH：

1. **引号地狱**：`pwsh -Command "..."` 内嵌 `"` 要写 `\"` 或 `""`；DSH 自己的 tool 文档就带着这种转义。
2. **自动变量陷阱**：`$HOME`/`$PID`/`$host` 只读且**大小写不敏感** —— DSH 甚至要把这条写进 tool 描述警告模型。
3. **`$env:NAME` 而非 `$NAME`**：模型（语料以 POSIX 为主）高频写错。
4. **路径形态**：`C:\...` 的反斜杠在 PowerShell 里同时是转义前缀和路径分隔符。
5. **5.1 / 7 分叉**：`dsh-pwsh-local` 会退回 `powershell.exe`（5.1），于是要注入
   `[Console]::OutputEncoding = ...` 前导码（`dsh-pwsh-local:100`），还牵出 ConstrainedLanguage / OEM 代码页一堆差异。
6. **ConstrainedLanguage + named pipe**：沙箱下 `.NET` 静态调用、`Add-Type`、COM、反射全废，
   管道式 stdio 捕获直接 EPERM。这些被**写进发给模型的 tool 描述**里，本身就是巨大认知负担。

**成功标准（建议）**
- 模型能用 POSIX 语法（`$VAR`、`'...'`、`/c/...`、管道、heredoc）完成绝大多数日常工作；
- 拿到一个**单一、诚实、稳定**的 tool 描述，不再随沙箱模式堆叠警告；
- 失败时给**可执行的下一步**，而不是 PowerShell 原始报错；
- 不牺牲已有的：jobs / 后台提升 / spill / 超时归因 / 输出截断 / UI 卡片 / exit-code pill。

---

## 3. 方案设计

### 3.1 推荐方案 A：继承 pwsh 执行器 + 复用官方 bash tool（★ 推荐）

```
                 ┌───────────────────────────────────────────────────────┐
   模型 → bash   │ dsh-shell-getaway                                     │
   tool          │                                                       │
（官方          │  ┌─ tool 层：直接挂 @deepseek-ai/dsh-tool-bash ─────┐  │
 dsh-tool-bash）│  │   自带正确的 bash 描述 + tool:bash prompt section │  │
                 │  │   我们只补两个 section 找补缺失/新增方言知识      │  │
                 │  └───────────────────────────────────────────────────┘  │
                 │                                                       │
                 │  ┌─ 执行器层：GetawayExecutor extends PwshLocalExecutor┐
                 │  │   static Config  → 加 shell / gitBashPath / ...   │  │
                 │  │   resolve(req)   → workdir 归一化 + 长度保护       │  │
                 │  │   argv(spec)     → ★唯一必覆写点：按 shell 派发     │  │
                 │  └───────────────────────────────────────────────────┘  │
                 │                                                       │
                 │  ctx.tools.restrict({ deny: ['pwsh'] })                │
                 │  ctx.shellEnv.register({ DSH_SHELL_KIND, ... })        │
                 └───────────────────────────────────────────────────────┘
                                     ↓ ctx.subprocess（原封不动）
```

**为什么继承 `PwshLocalExecutor`**（而不是 `LocalBashExecutor`、也不是从零写）

- 两者 90% 代码逐行相同；选 pwsh 那支的理由是它**已经带了 `argv(spec)` 这个显式 seam**
  （`dsh-pwsh-local/lib/index.js:197-206`），文档明确说这是给 confining 子类用的 —— 我们就是第 3 个消费者。
- 免费获得：deadline / `graceMs` / `spill` / `executeArgv` 的 provider-failure 归类 /
  `onProcessDone` 钩子 / `ENV_OVERRIDES` 的注入位置。
- `ctx.subprocess` 这一层完全不动 → **jobs、后台提升、UI 卡片、转义全部继续工作**。

**为什么复用官方 `dsh-tool-bash` 而不是自己写 tool**

- 描述文本、参数 schema（含 `run_in_background`/`sandbox_permissions` 的条件广告）、
  渲染管线、job 注册逻辑、`presentCall` 卡片 —— **全部现成且已被官方测试覆盖**。
- 自己 fork 出来会引入 ~700 行需要长期跟上游同步的代码。
- 唯一代价：我们**不能改它的描述文本**（除非走 `tools.restrict` + 自己注册）。
  → 若最终决定要自定义描述，再退回"复制 `defineTool` 定义"这条路（工作量仍可控）。

**要写的只有 4 个点**

| 覆写点 | 做什么 |
|---|---|
| `static Config` | 加 `shell`、`gitBashPath`、`wslDistro`、`cygwinBashPath`、`pathStyle` 等（其余字段与 `pwshPath` 版对齐） |
| `resolveShell()`（新增） | 探测 + 缓存可执行路径（**绝对路径**，§6.1） |
| `argv(spec)` | 按 `shell` 生成 argv；做长度保护（§6.6b） |
| `resolve(request)` | `workdir` 归一化（Windows 形态出参，但接受 POSIX 入参，§6.4） |

### 3.2 方案 B：纯配置 patch（零代码，作为 30 分钟可行性验证）

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: pwsh-sandbox
  disabled: true
- id: bash-sandbox
  disabled: false
- id: preset-standard          # preset 内也要改
  config:
    plugins:
      - id: tool-pwsh
        disabled: true
      - id: tool-bash
        disabled: false
```

**用途**：快速验证"DSH 换成 bash tool 后模型表现如何"，产出基线数据。
**缺点**：`dsh-bash-local` 裸 `"bash"` 在本机不可控甚至有**跨用户执行隐患**（§6.1）；
Windows 上无官方沙箱路径。**不建议作为最终形态**。

### 3.3 方案 C：给 DSH 上游提 PR

在 `dsh-bash-local` 加 `bashPath` 配置、把 `argv()` seam 提到共同基类、新增官方派发 seam。
**最优但本轮不可行**（本机无 SDK 源码树，只有 `app.asar` 打包产物）。
**建议**：把方案 A 的 `argv()` 设计整理成 issue 提给上游，作为长期方向。

### 3.4 方案对比

| 维度 | A 插件 | B patch | C 上游 PR |
|---|---|---|---|
| 不改 DSH 本体 | ✅ | ✅ | ❌ |
| 可配置 / 可切换 | ✅ | ❌ | ✅ |
| 绝对路径解析安全 | ✅ | ❌ | ✅ |
| 保留 jobs/spill/超时 | ✅ | ✅ | ✅ |
| 沙箱行为可控 | ✅ | ❌ 静默错乱 | ✅ |
| 复用官方 tool 文本 | ✅ | 部分 | ✅ |
| 工作量 | 中（≈400 行） | 极低 | 高 |
| 升级冲突面 | 小 | 无 | — |

---

## 4. 插件形态：严格对齐官方标准

### 4.0 ★ 官方有权威规范：随 DSH 发布的 agent skill

**这是本轮最重要的发现之一 —— 不需要逆向工程，DSH 自己带了插件开发规范。**

位置：`<packageDir>/@deepseek-ai/dsh-agent-preset/skills/`

| skill | 内容 |
|---|---|
| **`cordis-plugin-development/`** | `SKILL.md` + 6 个 reference + **可复制的 `templates/`** |
| └ `references/host-plugin.md` | **bundle manifest、安装/启用语义、Host 插件导出形式、Config** |
| └ `references/practices.md` | **扩展点选择准则**（"用最弱的机制"）、稳定性、性能 |
| └ `references/ui-plugin.md` / `mcp-bundle.md` / `user-actions.md` / `verification.md` | 其余场景 |
| └ `templates/decoration/{package.json,cordis.patch.yml,index.js,client.js}` | UI 插件起点（4 文件） |
| └ `templates/mcp/{package.json,cordis.patch.yml}` | 纯配置 bundle 起点（2 文件） |
| **`cordis-composition-reference/`** | patch 方言 + **38 KB 全量可安装插件包索引** |
| **`editing-cordis-compositions/`** | **agent preset 的创建/修改/校验**（我们必须要用） |

⚠️ **注意**：在 Desktop 里这个目录位于 `app.asar` 内，
**shell 命令（`ls`/`cat`/`cp`）、glob/search 工具（走原生 ripgrep）、`node`、pnpm 全部无法读取**；
只有 Host 进程自己的文件读取（也就是 `read` 工具 / `skill` 工具）能打开。
本次调研已经把 `app.asar` 解包到 `.research/dsh-src/`，所以这些文件现在是可以直接 `read` 的。

### 4.1 官方 Host 插件契约（`references/host-plugin.md` 原文要点）

**两种导出形式，不可混用**：

> `index.js` exports one of these forms; do not mix them:
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - **A service class as the default export.**

→ 我们的执行器应该用**第一种**（函数式 `apply`），
在 `apply` 内部 `ctx.plugin(GetawayExecutor, config)` 挂载继承自 `PwshLocalExecutor` 的类。
`dsh-pwsh-local` 自己用的是第二种（`default` 就是那个类），两种都是合法的。

**Bundle manifest（Host-only bundle 连依赖和构建都不需要）**：

```json
{
  "name": "@local/dsh-shell-getaway",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "meta": { "title": "Shell Getaway", "description": "Run bash instead of PowerShell on Windows." },
  "icon": "./icon.svg"
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: shell-getaway
      name: '@local/dsh-shell-getaway'
      config: {}
```

- ⚠️ **不存在 `dsh.plugin` manifest 字段**。全仓 ~233 个 `package.json` 里只有
  `dsh.bundle`（12 个包）、`dsh.client`（72 个）、`dsh.sessionFormatMigration`（4 个），
  以及 profile manifest 上的 `dsh.profile`。
- 显示元数据放 `locale/<lang>.json`（字段同上），icon 是相对 manifest 的路径
  （SVG/PNG/JPEG/WebP ≤ 256 KiB；绝对路径、URL、越界路径、外链符号链接一律拒绝）。
- `name` / `inject` / `Config` / `apply` 具名导出；`inject` 是硬依赖，解析不到就不激活。
- `Config` 用 `@deepseek-ai/schemastery`；`.default()` 给默认值、`.volatile()` 标记"可从 Web 表单编辑"。
- **注册的一切都要用 `ctx.effect` / `ctx.on` 包起来并返回 cleanup**。
- ⚠️ **绝不能在 `apply` 里启动脱管的异步工作**：`apply()` 返回的 promise 之外的未处理 rejection
  **会导致整个 app 退出（非 0）**，与 entry id 无关（`dsh-app-boot/README.md:105`）。
- ⚠️ **兼容性门禁**：只有 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 这些 peer 会被范围校验；
  `@deepseek-ai/cordis` 的 peer **按惯例声明但从不检查**；`engines.dsh` 根本不读。

### 4.1b 我们的插件骨架

```js
import z from '@deepseek-ai/schemastery';
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local';
import * as ToolBash from '@deepseek-ai/dsh-tool-bash';

export const name = 'shell-getaway';
export const inject = ['subprocess', 'tools', 'systemPrompt', 'shellEnv'];

export const Config = z.object({
  // 全部放在 Config 里 —— 官方 practices #22："Put tunable values in the plugin's Config
  // so users change them in cordis.patch.yml; the user's patch layer survives upgrades."
  shell: z.union(['auto', 'pwsh', 'gitbash', 'wsl', 'cygwin']).default('auto'),
  gitBashPath: z.string(),
  wslDistro: z.string(),
  cygwinBashPath: z.string(),
  pathStyle: z.union(['posix', 'windows']).default('posix'),
  timeoutMs: z.number().default(120000).volatile(),      // .volatile() 才能在 Web 表单里编辑
  maxOutputBytes: z.number().default(64000).volatile(),
  // ... 其余与 PwshLocalExecutor.Config 对齐
});

class GetawayExecutor extends PwshLocalExecutor { /* 见 §4.2 */ }

export function apply(ctx, config) {
  // 1. 注册唯一的 ctx.shell（在 host 平面，供所有 preset 的 tool 消费）
  ctx.plugin(GetawayExecutor, config);
  // 2. 复用官方 bash tool
  ctx.plugin(ToolBash, {});
  // 3. 补 prompt section（找补 Windows 强杀语义 + 方言教学）
  ctx.systemPrompt.section({ name: 'shell:getaway', order: 1001, text: POSIX_GUIDANCE });
  // 4. POSIX 化环境变量
  ctx.shellEnv.register({ name: 'shell-getaway', variables: {...}, resolve: ... });
  // 5. 旧 tool 的处理见 §4.3（【不能】在这里 restrict）
}
```

cordis 的 `Service` 基类提供 `static init / check / config / invoke / extend` 等符号钩子
（`cordis/lib/index.js:1742+`）。

- prompt 的 `order`：官方 `TOOL_BASH = 1000` / `TOOL_PWSH = 1010`
  （`dsh-system-prompt/lib/index.js:17-18`）。取 **1001** 落在两者之间；
  ⚠️ 但**是否允许非 `getSectionOrder()` 登记的裸数字**、以及是否会与 preset 内注册的 section 冲突，
  仍需实测（§11 P0）。
- 本仓库**不发布 `.d.ts`**（尽管每个 `package.json` 都声明了），所有类型从编译产物 + README 反推。

### 4.2 执行器骨架（关键覆写点）

```js
class GetawayExecutor extends PwshLocalExecutor {
  // 继承来的：resolve() 的数值钳制、graceMs、spill、deadline 分类、onProcessDone

  /** 覆写：workdir 归一化（入参接受 POSIX，出参必须是 Windows 形态，§6.4） */
  resolve(request) {
    const spec = super.resolve(request);
    return { ...spec, workdir: toWindowsPath(spec.workdir) };
  }

  /** ★ 唯一必覆写点：argv 派发（官方设计的扩展点） */
  argv(spec) {
    this.assertShellAllowed(spec);           // 沙箱拒绝逻辑（§6.5）
    const script = this.prepareScript(spec); // BOM 剥离、CRLF 归一化（可选）
    switch (this.resolvedShell.kind) {
      case 'pwsh':
        return super.argv(spec);             // 完全交回官方实现
      case 'gitbash':
        return [this.resolvedShell.path, '-c', script];
      case 'cygwin':
        return [this.resolvedShell.path, '-c', script];
      case 'wsl':
        return [
          this.resolvedShell.path,
          ...(spec.workdir ? ['--cd', toWindowsPath(spec.workdir)] : []),
          ...(this.config.wslDistro.get() ? ['-d', this.config.wslDistro.get()] : []),
          '-e', 'bash', '-c', script,        // 注意 -e + '--' 语义，§6.6
        ];
    }
  }
}
```

> **`argv()` 是同步的**，所以 `wslpath` 之类的 round-trip 转换要么改用纯 JS 转换，要么走
> `executeArgv(spec, async (signal) => argv)` 那条**接受 prepare 函数**的重载
> （`dsh-pwsh-local/lib/index.js:280-302` 明确支持）。

### 4.3 挡住旧 tool：`ctx.tools.restrict`

`ctx.tools` 的正式契约（实时 Service 查询所得）：

```
restrict(filter: ToolRestriction): () => void
  Restrict global tools for the calling agent scope.
  global-tool mask: `allow` (keep only) and/or `deny` (remove).
  Empty filters, unknown names, scope-local names, and reserved transport names fail.
  Restrictions intersect; scoped registrations remain visible.
  返回精确的 disposer，用于解除限制。
```

⚠️⚠️ **重要更正：`restrict()` 不能全局调用。** 实测源码
`dsh-tools/lib/index.js:2895-2909`：

```js
restrict(filter) {
  const scope = scopeOf(ctx);
  if (scope === void 0) throw new Error(
    "tools.restrict() requires a scoped context (agent.ctx): " +
    "a context-global restriction would mask every agent — deny the tool for the intended agent instead");
  ...
  const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(
    `tools.restrict() names unknown global tool${...} ...; known global tools: ${...}`);
  ...
}
```

两个硬约束：
1. **必须挂在 `agent.ctx` 上**（scoped context），在插件的 host 平面 context 里调用**直接抛错**；
2. **未注册的 tool 名是硬错误** → 顺序敏感（`pwsh` 还没注册时不能 deny）。

官方 `practices.md:17` 也明确了用途边界：

> **Hiding tools from one agent is `ctx.tools.restrict()` on that agent's context**;
> it keeps schema presentation, lookup, and execution aligned.
> ... The framework drives; **use the weakest mechanism that suffices**
> （`restrict` 只能移除；`guard` 只能拒绝；waterfall 能改写；`system-prompt/assemble` 能整体替换）。

补充事实（已确证）：
- `ctx.tools.guard(fn)` 是**唯一能全局生效**的机制，但它**只能拒绝执行、不能隐藏 schema**
  —— 对"别让模型看见 pwsh"这个目标**不够**。
- `dsh-agent` **没有** tool-restriction API；`dsh-permission-presets` **没有** tool 过滤
  （只有 `sandbox` + `approval` 两个旋钮）。该 API **只存在于 `dsh-tools`**。

### 4.3b ★ 正确的做法：改 preset 声明（而不是运行时 restrict）

由于 preset 在**自己的 realm** 里独立声明 `tool-bash` / `tool-pwsh`
（`presets/standard.patch.yml:20-25`），运行时 restrict 既够不到、也不该用。
官方 `editing-cordis-compositions` skill 给了标准做法：

> **Change a shipped preset** — Override the declaration by its Loader row id instead of inserting.
> The override replaces the complete `config`, so restate `id`, `plugins` and every other field
> the shipped file carries.

→ 我们的 bundle patch 里写：

```yaml
# 1) 关掉 host 平面的 pwsh 执行器
- id: pwsh-sandbox
  disabled: true
# 2) 插入我们的执行器（host 平面，供所有 preset 的 tool 消费）
- insert:
    - id: shell-getaway
      name: '@local/dsh-shell-getaway'
      config:
        shell: auto
# 3) 覆盖 preset 声明：把 tool-pwsh 换成 disabled，保留其余全部行
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # ... 逐条复述 shipped 列表，仅把 tool-pwsh 改成 disabled: true
```

⚠️ **patch 是整体替换 `config`，绝不深合并** —— 必须逐字复述 shipped 列表里的每一行，
否则会静默丢掉 `agent-instructions` / `tool-fs` / `planning` / `compaction` / `delegation` 等全部行。
shipped 列表已完整抄录在 `presets/standard.patch.yml`（本地副本：
`.research/dsh-src/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`）。

⚠️ 还要考虑同一个 realm 里的 `minimal.patch.yml`（它用 `shellDialect: pwsh` 的持久 shell）
与 `ptc.patch.yml`；若用户会切 preset，需要一并处理。

⚠️ **未验证**：preset 行 id 与 host 行 id 是否在同一 id 命名空间
（`dsh-base` 里 host 有 `tool-pwsh`，`preset-standard` 里也有 `tool-pwsh`）。
若冲突，需给 preset 内的行改 id 或用 Loader 的 `preset-<id>` 行寻址。列入 §11 P0。

### 4.4 Web 设置页：可以零改动复用（关键发现）

实测 `dsh-client-ui-settings-shell/lib/client.js`：

```js
const BASH_NS = "bash-sandbox";     // :115
const PWSH_NS = "pwsh-sandbox";     // :117
const bash = new ShellCardController(ctx.configForms.get(BASH_NS));   // :176
const pwsh = new ShellCardController(ctx.configForms.get(PWSH_NS));   // :177
ctx.effect(() => ctx.configForms.whileServed([BASH_NS, PWSH_NS], (served) => ctx.slots.inject("plugins.item", () => ctx.slots.register({
  ...
  inject: () => (served.has("pwsh-sandbox") ? pwsh : bash).inject()   // :188
```

而 `dsh-settings/lib/index.js:307`：

```js
shell: process.platform === "win32" ? "pwsh-sandbox" : "bash-sandbox"
```

→ 这个设置页是按 **profile entry id** 绑定的。因此有两条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 占用 `bash-sandbox` id** | 我们的 bundle patch 里 `- id: bash-sandbox / name: '@local/dsh-shell-getaway'` | 设置页**自动出现**（因为 win32 上 `served.has('pwsh-sandbox')` 为 false → 取 bash 分支），且 `dsh-settings` 的 `shell` 命名空间也自然指向我们。**代价**：与 base 层同 id 的行"抢占"，可能触发 duplicate-row 语义，且语义上我们并不是 `dsh-bash-sandbox` |
| **B. 用自己的 id + 自带设置页** | `- id: shell-getaway`，另写一个 client 插件注册到 `plugins.item` slot | 多写一个 UI 插件（`templates/decoration/` 4 文件），但要遵守"不要 import Harness Client 包、只用 `--dsw-alias-*` theme token"等一堆 UI 规范 |

**建议**：MVP 用 **B**（干净、不抢 id、不踩 duplicate 语义），
把 A 作为可选优化（"设置页白嫖"）在阶段 2 评估。**无论哪条路，Config 字段都要用 `.volatile()`**，
否则 Web 表单无法编辑（只有 `.volatile()` 标记的字段可写）。

### 4.5 打包与安装（官方流程）

官方 `cordis-plugin-development/SKILL.md` 的原文规定：

> For implementation, use ordinary workspace files to author a bundle,
> then `plugin_manager` with `action: install_bundle` and **the absolute package directory** as `target`
> to install it in the current profile. Changes affect every session in that profile and survive restart.
>
> **Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`,
> or run pnpm in the profile directory**: `install_bundle` performs those steps, and each hand-made write
> outside the workspace needs its own approval.

→ **这推翻了我最初"手改 profile patch"的思路。** 正确流程是：

1. 在**工作区**（`F:\TidyProjects\dsh-powershell-getaway\`）里写 bundle 目录
   （`package.json` + `cordis.patch.yml` + `index.js`，Host-only 无需依赖/构建）；
2. 复制官方模板做起点（`templates/mcp/` 最接近我们的形态）；
3. syntax check + manifest check；
4. `plugin_manager { action: install_bundle, target: '<绝对目录>' }`；
5. **读返回的 `application` / `warnings` 字段判断是否生效**（不看日志/进程列表/页面 boot payload）；
6. 用 `cordis_inspect_query`（无需审批）确认新行，而不是翻 `list_plugins`。

⚠️ `list_plugins` / `list_bundles` **每次调用都需要审批**（除非 Full access），所以**只在结果决定下一步时才调**。
⚠️ 替换已安装包需要**重启**才能加载新的 JS module generation（安装新 bundle 可走 HMR）。
⚠️ 兼容性门禁见 §4.1（只有 `dsh-*` peer 会被范围校验）。

### 4.6 启用与验证

- 所有可调参数放 `Config`（官方 `practices.md:22`）→ 用户在 `cordis.patch.yml` 里改，
  且用户的 patch 层**在升级后依然存活**。
- 验证清单：
  1. `list_plugins` 看 `shell-getaway` 行 = `active`、`preset-standard` 行无诊断；
  2. `cordis_inspect_query` `Tool.listTools` 断言 **`pwsh` 不存在、`bash` 存在**；
  3. 跑 3 个真实任务（多行脚本 / 中文输出 / `git` 操作）；
  4. 新会话里验证（**已有会话沿用启动时的插件版本**，`editing-cordis-compositions` §74 明确说明）。

---

## 5. 模型可见面：要改哪些文本

> 这是最容易被低估的部分（用户明确问到了"dsh 自己的提示词中是否有 powershell 相关内容"）。
> 完整清单见 `.research/findings/02-powershell-prompt-audit.md`（1497 行，27 项风险登记）。

### 5.1 `pwsh` tool 描述 = 100% PowerShell

本会话实时抓取的 `pwsh` 描述，**每一句都是 PowerShell 专属**：

> Execute a PowerShell command (`pwsh -Command`) ... **Paths use native Windows form (`C:\...`); read
> environment variables with `$env:NAME`.** Managed `$env:DSH_*` variables ...
> **Do not assign to automatic variables such as `$HOME`; variable names are case-insensitive** ...
> **Under the Windows sandbox, read-only pwsh runs in PowerShell ConstrainedLanguage** ...
> prefer cmdlets and core types (`[string]`, `[datetime]`, `[regex]`, `[guid]`); **.NET static calls
> (`[System.IO.*]::`, `[math]::`), `Add-Type`, COM objects, and reflection fail with "only core types"** ...
> **In both confined modes, programs cannot open named pipes, so a command that captures another
> program's output through piped stdio ... fails with EPERM** ...

→ **复用官方 `dsh-tool-bash` 就自动解决这一整段**（它自带正确的 `bash` 描述）。

### 5.2 ⚠️ 切换后会静默丢掉的一条 Windows 事实

`tool:pwsh` 的 prompt section（order 1010，`dsh-tool-pwsh/lib/index.js:348-352`）：

```
Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on.
On Windows a killed process settles as `[exit code: 1]` without a signal marker;
treat a bare exit 1 after an interruption as a termination, not a command failure.
```

`tool:bash` 的 section（order 1000，`dsh-tool-bash:377-381`）**只有**：

```
Check the [exit code: N] marker on every bash result; investigate failures before moving on.
```

→ **第二句（Windows 强杀语义）只在 pwsh 侧！** 换 shell 后必须由我们**补回来**，
否则模型会把"被中断"误判成"命令失败"，然后去修一个根本不存在的问题。

### 5.3 插件要补的 prompt section

| section | order | 内容 |
|---|---|---|
| `shell:getaway:exit` | `getSectionOrder('TOOL_BASH') + 1` | 找回上面那句 Windows 强杀语义（**不要**复用名字 `tool:bash`，同名会冲突） |
| `shell:getaway:dialect` | 紧随其后 | POSIX 路径 / 变量 / 互操作教学（见下） |

方言教学必须覆盖 3 件事：

1. **路径形态（建议而非禁令）**：优先 `/f/TidyProjects/...` 或 `F:/TidyProjects/...`（正斜杠）
   —— 因为多数 POSIX 工具（`git -C`、`cd`、重定向目标）不接受 `\` 作为分隔符。
   含反斜杠的路径**要用单引号**（未加引号时 `\U` 会被 bash 当转义）。
   Git Bash 下可用 `cygpath -u 'C:\x'` 转换。
2. **`workdir` 参数用 Windows 形态**（`F:\x` 或 `F:/x`），**命令体内部**用 POSIX 形态
   —— 这条是硬约束（§6.4），两者**刻意不一致**，必须写清楚。
3. **变量**：`$VAR` / `${VAR}`，**不是** `$env:VAR`；DSH 元数据是 `${DSH_HOME}` 这种形态，
   新增的 POSIX 化变量带 `_POSIX` 后缀。

⚠️ **WSL2 一等公民带来的新问题**：Git Bash 用 `/c/...`，WSL 用 `/mnt/c/...` —— **两套路径约定**。
`systemPrompt.section` 在整个布局组件的作用域内注册，**一次注册一个文本**。
处理办法（见 §13.2）：文本同时客观描述两种约定 + 用 `DSH_SHELL_KIND` 让模型自己判定；
**不要**试图按运行时检测动态改写 prompt（会破坏 KV cache 前缀稳定性，
且官方 `practices.md` 明确要求"Add prompt text with `ctx.systemPrompt.section()`"，
不应通过监听 `system-prompt/assemble` 来增删文本）。

### 5.4 其他 PowerShell 足迹

| 位置 | 内容 | 动作 |
|---|---|---|
| `dsh-tool-pwsh:469` | `"Get-Process" → "List running processes"` 参数示例 | 复用 `dsh-tool-bash` 后自动消失 |
| `presets/minimal.patch.yml:54-61` | 持久 shell 的 pwsh 描述（`Use native Windows paths (C:\...)`） | 阶段 3 再说 |
| `dsh-tool-str-replace-editor:16` / `:284` | `` `view` displays the result of applying `cat -n` `` / `` `/repo/file.py` `` | 本来就偏 POSIX，**无需改** |
| `dsh-tmux-context:1513-1522` | 通过 `ctx.get("shell")` 跑 `[ -n "$TMUX_PANE" ]`、`ps -o tty=` | **唯一**证明 `ctx.shell` 不方言中立的地方；Windows/pwsh 下本来已死，WSL 下会"活但仍坏"（pid 是 Windows pid）→ 插件应禁用或忽略它 |
| `dsh-tool-pwsh:317` | 内部错误文本说 "the mounted **bash** executor confines"（从 pwsh tool 里） | 上游小 bug，无需处理 |
| 其余全部 `dsh-tool-*` 描述 | 实测**方言干净**（全树只有 3 处命中） | 无需改 |

---

## 6. Corner cases（以实测为准）

### 6.1 可执行文件解析：本机 PATH 是雷区 ⚠️⚠️⚠️

```
where.exe bash  →
  C:\Users\Liserver\AppData\Local\Microsoft\WindowsApps\bash.exe   0 字节 reparse point
  C:\WINDOWS\System32\bash.exe                                     真·WSL 启动器 (126 976 B)
  C:\cygwin64\bin\bash.exe                                         真·Cygwin bash 3.5.4

Git Bash  →  C:\Program Files\Git\bin\bash.exe       （存在，但【不在 PATH 上】）
             C:\Program Files\Git\usr\bin\bash.exe
PATH 上的 Git 目录只有 C:\Program Files\Git\cmd（仅 git.exe）
```

三个致命推论：

1. **`dsh-bash-local` 的裸 `"bash"` 在本机会解析到 `C:\WINDOWS\System32\bash.exe` = WSL 启动器**
   → `bash -c 'echo x'` 会静默走 WSL。这是**真实存在的上游缺陷**（pwsh 有 `pwshPath`，bash 没有）。
2. `WindowsApps\bash.exe` 是 **0 字节 reparse point，Target 指向另一个用户**
   （`C:\Users\杨绍璞\...`）。DSH 的 `executableCandidateExists` 判 `size === 0 → false` 会跳过它
   （`dsh-subprocess-local/lib/runner-launch-*.js:1465-1501`），所以当前"侥幸"没被选中
   —— 但这是**跨用户执行隐患**，任何解析顺序变化都可能引爆。
3. 另外 `resolveWindowsExecutable` **只追加 `.com`/`.exe`**，所以 PATH 上解析 `bash` 必须是 `bash.exe`。

**插件解析策略（必须）**：

```
显式配置 gitBashPath
  ↓ 否则
C:\Program Files\Git\bin\bash.exe
%LOCALAPPDATA%\Programs\Git\bin\bash.exe
C:\Program Files (x86)\Git\bin\bash.exe
注册表 HKLM\SOFTWARE\GitForWindows\InstallPath
`where git` 反推上级目录
  ↓ 每次都要
身份校验：优先 bin\bash.exe（能起交互 shell），并用
  bash --version 含 "x86_64-pc-msys" 或 bash -c 'echo $MSYSTEM' 做确认
  ↓ 显式排除
C:\WINDOWS\System32\bash.exe（WSL 启动器）
*\WindowsApps\bash.exe（App Execution Alias，可能是 0 字节跨用户链接）
  ↓ 探测失败
抛明确错误，【绝不】回退到裸 "bash"
```

### 6.2 argv 传递保真度：实测全绿 ✅

用 Node 复刻 DSH 的 spawn 方式（`spawn(gitBash, ['-c', script], { stdio:['ignore','pipe','pipe'] })`）：

| 用例 | 结果 |
|---|---|
| `echo hello` | ✅ 159 ms |
| **多行脚本**（`for` + `printf`） | ✅ 三行 + `done` |
| 单双引号混合 `"it's"` | ✅ |
| `$X` / 字面 `\$X` | ✅ |
| 反斜杠字面量 `'C:\Program Files\Git'` | ✅ 保留 |
| stderr 分离 | ✅ |
| `exit 7` | ✅ `exit=7 signal=null` |
| heredoc 写文件再执行 | ✅ |
| `cwd: F:\TidyProjects\...` | ✅ `pwd` = `/f/TidyProjects/dsh-powershell-getaway` |
| 后台 `bash -c "..." & wait` | ✅ `child-done` / `parent-done` |
| 进程残留 | ✅ 无 |

**根因（已确认到代码）**：
- node → Job-runner：`spawn(command, [...prefix, "--", ...spec.argv], { windowsHide: true })`，
  全树 **`windowsVerbatimArguments` 出现 0 次**。
- runner → target：`quoteArg()`（`dsh-win32-process/lib/index.js:352-376`）对匹配 `/[\s"]/u` 的参数加引号
  （换行必然触发），并**逐字复制**非反斜杠/非引号字符（含换行）。
  `CommandLineToArgvW` 只按空格/TAB 切分 ⇒ **一个元素**。
  `lpApplicationName` 单独传，argv[0] 不会从命令行重新推导。
- **全程不经过 `cmd.exe`**；沙箱路径（`CreateProcessAsUserW`）用的是同一个 quoter。

→ **结论：不需要任何引号/转义层**。这正是"少为长难句买单"的核心红利。
残余风险：MSYS2 自己的 `dcrt0.cc` 对**紧邻 `\"` 的反斜杠**的解析（建议含 `\"` 的脚本走 stdin/临时文件）。

### 6.3 路径反斜杠：⚠️ 我最初的结论**是错的**，这里给出更正后的真相

**先纠正一个我早期的误判。** 我最初用一个测试得出"反斜杠被 MSYS2 剥离"，那个测试**设计有缺陷**。
用 7 组对照重测后（`.research/backslash.txt`），真相是：

| 形态 | 脚本 | 结果 |
|---|---|---|
| 双引号内 printf | `printf "%s\n" "C:\Users\Liserver"` | ⚠️ `C:UsersLiserver` |
| 单引号 printf | `printf '%s\n' 'C:\Users\Liserver'` | ✅ 保留 |
| **未加引号 echo** | `echo C:\Users\Liserver` | ❌ `C:UsersLiserver` |
| 单引号 echo | `echo 'C:\Users\Liserver'` | ✅ 保留 |
| 双引号 echo | `echo "C:\Users\Liserver"` | ✅ 保留 |
| 变量赋值再展开 | `P='C:\...'; echo "$P"` | ✅ 保留 |
| **作为独立 argv 元素传入** | `bash -c 'printf "%s\n" "$1"' sh 'C:\Users\Liserver'` | ✅ **完整存活** |

**更正后的结论**：

1. **宿主边界（Windows → bash）完全干净** —— 反斜杠在 argv 里逐字存活。
   之前看起来的"剥离"其实有两层原因，**都不是宿主边界**：
   - **bash 自身的转义规则**：未加引号的 `\U` → `U`（反斜杠是转义前缀，这是 POSIX 语义）；
   - **`printf` 的格式串转义**：`printf "%s\n" "C:\Users"` 里 `\U`/`\L` 是 printf 自己的转义序列，
     会**静默吞掉未知转义**。
2. **文件系统层面 Windows 路径在 Git Bash 里是合法的**：
   `ls -d 'F:\TidyProjects\dsh-powershell-getaway'` 成功返回该路径。
3. **真正会失败的是消费该路径的程序**：
   `git -C 'C:\TidyProjects' …` → `fatal: cannot change to 'C:\TidyProjects': No such file or directory`；
   而 `git -C /f/TidyProjects/...` 和 `git -C F:/TidyProjects/...` 都能正确解析。
   → **不是 shell 吃掉了反斜杠，是 git（以及大量 POSIX 工具）不接受 `\` 作为路径分隔符。**

**所以给模型的建议应该降级而不是禁令**：

| 原来的说法 | 更正后 |
|---|---|
| "命令体里**禁止** `C:\...`，反斜杠会被吃掉" | "**推荐**用 `/f/TidyProjects/...` 或 `F:/TidyProjects/...`（正斜杠），因为多数 POSIX 工具（`git -C`、`cd`、重定向目标）不接受 `\` 作为分隔符；反斜杠本身不会在 shell 层被剥离" |
| 需要 `pathStyle: 'windows'` 兼容模式做字符串替换 | **不再需要**。真正的坑是引号与 printf 转义，属于 bash 常识，写进教学段即可（"路径含反斜杠时用单引号"） |
| 失败启发式提示反斜杠 | 保留但改措辞：提示"改用正斜杠或 `/c/...` 形态" |

⚠️ 另一个仍然成立的真实风险（来自 `02-powershell-prompt-audit.md`）：
MSYS2 会**反向改写看起来像 POSIX 路径的参数**（`/Flag` → `C:\...`），
影响调用 Windows 原生程序（`robocopy /MIR`、`schtasks /Create`）。
官方 tool 文本没提这件事 → 仍应写进教学段，或对已知模式注入 `MSYS2_ARG_CONV_EXCL`。

**`workdir` 参数**：见 §6.4 —— 那里有一条**独立成立**的硬约束（`spec.cwd` 必须 Windows 形态），
与本节的反斜杠问题无关。

### 6.3b 🔴 MSYS2 静默改写原生程序参数 —— 必须处理（用户提示，已实测坐实）

**这是本项目最危险的一个坑，因为它完全静默。**

为了拿到 ground truth，我用 Git 自带的 MinGW `gcc` 编译了一个**真正的原生 Win32 argv 打印器**
（`.research/argdump.c`，用 `gcc -o argdump.exe argdump.c` 构建；
注意不能用 Git Bash 自带的 `env.exe` —— 那本身是 MSYS 程序，不是有效的 oracle）。

**默认行为（无任何环境变量覆盖）**：

| 传入的 argv | 原生程序实际收到 |
|---|---|
| `/data` | `C:/Program Files/Git/data` |
| `/data:/mnt/x` | `C:\Program Files\Git\data;C:\Program Files\Git\mnt\x` ⚠️ **`:` 被改成 `;`** |
| `--flag=/some/path` | `--flag=C:/Program Files/Git/some/path` |
| `/etc` | `C:/Program Files/Git/etc` |
| `/foo.exe` | `C:/Program Files/Git/foo.exe` |
| `//server/share` | `//server/share`（UNC，未被改） |
| `relative/path` | `relative/path`（相对路径，未被改） |
| `C:/Users` | `C:/Users`（已是 Windows 形态，未被改） |

**你的警告完全命中**：`docker run -v /data:/x` 会被改成
`-v C:\Program Files\Git\data;C:\Program Files\Git\x` —— **静默挂载一个错误目录**，
不报错、不警告，模型和用户都会以为挂载成功了。

**修复（两种都实测有效）**：

| 环境变量 | `/data` | `/data:/mnt/x` | `--flag=/some/path` | `/etc` |
|---|---|---|---|---|
| （默认） | ❌ 被改 | ❌ 被改且 `:`→`;` | ❌ 被改 | ❌ 被改 |
| **`MSYS_NO_PATHCONV=1`** | ✅ `/data` | ✅ `/data:/mnt/x` | ✅ | ✅ |
| **`MSYS2_ARG_CONV_EXCL=*`** | ✅ `/data` | ✅ `/data:/mnt/x` | ✅ | ✅ |

**零副作用的证据**：我用 12 个日常命令 × 2 种设置做了对照，**结果逐字节相同**：

```
pwd · ls · git status · git rev-parse · git log · cat /etc/hosts ·
grep -r · find · python -c · echo> /tmp · cygpath -u · tar
```

原因：`git.exe` / `grep` / `tar` / `find` / `python` 都是 **MSYS 程序**，
它们自己就用 POSIX 路径，**从来不经过这层转换**。
这层转换只作用于**原生 Windows 程序**（`docker.exe`、`robocopy.exe`、`schtasks.exe`、
PowerShell、以及任何 `.NET`/MSVC 编译的工具）—— 而那正是被扭曲的目标。

**所以设计决定（明确）**：

| 项 | 决定 |
|---|---|
| 默认值 | **`MSYS_NO_PATHCONV=1` 写进封装的 `ENV_OVERRIDES`**（与 `NO_COLOR`/`TERM`/`PAGER` 并列） |
| 理由 | 零实测副作用，却消除了一整类**静默**失败 |
| 逃生舱 | Config 暴露 `msysPathConv: 'off' \| 'default' \| 'exclude'`，默认 `off`；`'exclude'` 时改用 `MSYS2_ARG_CONV_EXCL` |
| 精细排除 | ⚠️ `MSYS2_ARG_CONV_EXCL` 是**子串匹配、分号分隔**，**不是 glob**。实测 `*` 是唯一有效的全局通配；`/data`、`/data;/etc`、空串**都无效**。所以要精细排除只能逐个子串列（如 `/data;/var`） |
| 残余风险 | 关掉转换后，**需要转换才能工作**的调用会失效。典型是 `git clone`/`ssh` 里形如 `host:/path` 的 scp 语法。若实测发现这类回归，可在教学段引导用户用 Config 切到 `'default'` |
| 教学段 | 告诉模型：Git Bash 下**原生 Windows 程序需要 Windows 形态路径**（`docker run -v C:/data:/x`），不要写 POSIX 形态指望被转换——我们**故意关掉了**转换 |

> 这条修正了我上一轮"MSYS2 会反向改写 `/Flag` 形态参数"的模糊说法，
> 把它从"写进文档提示一下"升级为"**必须在 `ENV_OVERRIDES` 里默认关闭**"。
> 注意它**只在 Git Bash / Cygwin 分支**适用；WSL 分支没有 MSYS 层，无需处理。

**🔴 附带的第二个受害者：`cmd.exe /c "..."` 会被静默变成交互式 cmd**

实测（`.research/verify4.txt`）：

| 环境 | `cmd.exe /c "echo from-cmd"` 的结果 |
|---|---|
| 默认 | `Microsoft Windows [Version 10.0.22631.6199]` + `(c) Microsoft Corporation` + **交互式提示符** —— `/c` 被 MSYS 转成 `C:/Program Files/Git/c`，cmd 收到一个它不认识的参数 |
| `MSYS_NO_PATHCONV=1` | `ECHO is on.` ✅（`/c` 原样传给 cmd） |

→ 这**不是边缘情况**：模型会经常需要"在 bash 里调一个 Windows 工具"。
默认关闭转换顺便修掉了它。

### 6.3c 🔴 Git Bash 的信号死亡报告与 DSH 契约不兼容（需在 `onProcessDone` 里修正）

实测（`.research/verify4.txt`，`bin` 与 `usr\bin` 两种 bash 完全一致）：

| 脚本 | Node `close` 事件 | 真实信号 |
|---|---|---|
| `kill -TERM $$` | `code=3840, signal=null` | SIGTERM (15) |
| `kill -KILL $$` | `code=2304, signal=null` | SIGKILL (9) |
| `kill -INT $$` | `code=512, signal=null` | SIGINT (2) |
| `kill -SEGV $$` | `code=35584, signal=null` | SIGSEGV (11) |
| `exit 9` | `code=9, signal=null` | 普通退出 |

**正确的解码公式是 `signo = status >> 8`**（把 status 当作 Win32 `ExitProcess((128+n)<<8)` 的原始值）：

```
3840 >> 8  = 15  = SIGTERM  ✅
2304 >> 8  =  9  = SIGKILL  ✅
 512 >> 8  =  2  = SIGINT   ✅
35584 >> 8 = 139 = 128+11 → SIGSEGV ✅
```

> ⚠️ 子代理给的公式 `(status>>8)-128` 是**错的**（会得出 −113）。
> 以本行为准。

**为什么这会破坏 DSH 契约**：`dsh-shell` 的 `ShellRunResult` 约定
`exitCode: number|null` + `signal: NodeJS.Signals|null`，渲染层据此产出
`[killed by signal: SIGTERM]`。但 MSYS2 把信号折进了退出码、`signal` 永远是 `null`，
于是渲染出来是 **`[exit code: 3840]`** —— 一个模型完全无法理解的数字。

**修复（在 `onProcessDone(proc, stderr, providerRejected)` 里做）**：

```
若 proc.exitCode !== null 且 proc.status === 'killed'（或 exitCode > 255）：
    signo = proc.exitCode >> 8
    若 1 <= signo <= 64：proc.signal = signals[signo]（如 'SIGTERM'）；proc.exitCode = null
```

注意时机：基类在 `proc.done` 里**先** stamp `exitCode`/`signal`/`status`，**再**调 `onProcessDone`
（`dsh-pwsh-local/lib/index.js:351-356`）→ 我们在这个钩子里改写是安全的。
本项列入 §11 P0（需实测确认改写后渲染层确实输出 `[killed by signal: …]`）。

### 6.3d ⚠️ Git Bash 的 stdout 管道行为：`cmd &` 会阻塞，`nohup` 会脱管

实测（`03-shell-environment.md`）：

| 场景 | 结果 |
|---|---|
| `sleep 5 &`（仅后台） | 调用**阻塞 6456 ms** —— 子进程持有 stdout 管道，Node 要等管道关闭 |
| `nohup sleep 20 &` | 调用 1358 ms 返回，但留下一个**无父进程的 `sleep.exe`** |
| `bash -c "…" & wait` | 正常（这是我们推荐的形态） |

→ 这是 POSIX 管道的固有行为，不是 Git Bash 的 bug，但**必须在教学段写明**：
让模型用 `run_in_background` 参数而不是 shell 的 `&`；
若确实要 `&`，必须配 `> /dev/null 2>&1 &` 或 `& wait`。

### 6.4 `workdir` 与 cwd：实测反直觉 ⚠️

| 场景 | `cwd` 传入 | 结果 |
|---|---|---|
| Git Bash | `F:\TidyProjects` | ✅ `pwd` = `/f/TidyProjects` |
| Git Bash | `F:/TidyProjects` | ✅ |
| Git Bash | `\\?\F:\TidyProjects` | ✅ |
| Git Bash | **`/f/TidyProjects`** | ❌ `spawn ... ENOENT`（**错误信息说找不到可执行文件，实际是 chdir 失败**） |
| **WSL2** | `F:\TidyProjects` | ✅ `pwd` = **`/mnt/f/TidyProjects`** |
| **WSL2** | `C:\Windows` | ✅ `/mnt/c/Windows` |
| **WSL2** | （不传，继承进程 cwd） | ✅ `/mnt/f/TidyProjects/dsh-powershell-getaway` |

→ **`spec.cwd` 必须是 Windows 形态**（对 Git Bash 和 WSL 都成立）。
Node/`CreateProcess` 的 cwd 走 Win32 语义，POSIX 路径让 spawn 直接失败，
而且错误文本会把锅甩给可执行文件，**极难排查**。

**★ 关键简化（实测发现）**：`wsl.exe` **会继承进程 cwd 并自动把它翻译成 `/mnt/...`**。
所以 **WSL 分支完全不需要 `--cd`**，也不需要任何路径换算 ——
`workdir` 归一化成绝对 Windows 路径后，两条分支都直接把它交给 `spawnSpec.cwd` 即可。

这推翻了"WSL 需要 `--cd` 做 cwd 桥接"的初始假设，也让"`resolve()` 必须做 shell 相关归一化"
的担忧大幅减轻（§13.1 的分析已按此更正）。

**`--cd` 的可用形态（供参考，我们不用）**：

| `--cd` 值 | 结果 |
|---|---|
| `F:\TidyProjects` | ✅ `/mnt/f/TidyProjects` |
| `F:/TidyProjects` | ✅ `/mnt/f/TidyProjects` |
| `~` | ✅ `/home/liserver` |
| `/mnt/f/TidyProjects`（Linux 风格） | ❌ `Wsl/E_INVALIDARG`，且错误是 **UTF-16LE** |

**设计要点**：
- `resolve()`：`workdir` **入参接受两种写法**（`F:\x` / `/f/x` / `/mnt/f/x`），
  统一用 `path.win32.resolve` 归一化成**绝对 Windows 路径**出参。
- 训练模型：`workdir` 用 Windows 路径，**命令体内部**用各自的 POSIX 形态。
- ⚠️ 上游 bug：`dsh-tool-bash` 的 `resolveWorkdir` 用裸 `${sep}` 拼接（`lib/index.js:293-299`），
  会拼出 `C:\ws/rel` 混合分隔符；`dsh-tool-pwsh` 用的是 `node:path.resolve`（正确）。
  → 我们自己的 `resolve()` 里用 `path.win32.resolve`，不要复制 `dsh-tool-bash` 那一段。

### 6.5 沙箱：Git Bash 与 WSL 都不该走 ACL 沙箱 ⚠️⚠️

**机制上是 argv-based 的**（`SandboxBashExecutor` 就是 `confine(['bash','-c',cmd])`），
所以理论上 Git Bash 能被令牌约束。但三条已文档化的边界会咬人：

1. **console isolation 不可用** —— 受限令牌下 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 子进程
   会 `STATUS_DLL_INIT_FAILED` 死掉（`dsh-sandbox-windows-acl/lib/types-*.js:1171-1173`）。
2. **两个受限模式都禁止打开 named pipe**（`dsh-pwsh-sandbox/README.md:141-143`），
   而 MSYS2 的 `fork()` 仿真、`$(...)`、`|` 到原生 Windows 程序都依赖它
   —— 对 Git Bash 比 PowerShell 更致命。
3. **`STATIC_ENFORCEMENT["windows-acl"] === "partial"`**，且 `ConstrainedLanguage`
   是 PowerShell 专属副作用 → bash 在 `read-only` 下**丢掉这层纵深防御**。
4. **WSL 更彻底**：受限令牌只约束 `wsl.exe` 本身；Linux payload 由 WSL 服务在 utility VM 内以 Linux uid 创建，
   `/mnt/c` 的 I/O 由宿主侧服务组件代理 —— **受限令牌/SID/低完整性标签完全不跨 Hyper-V 边界**。
   在那里报 `denied:false` 就是**说谎**。

**插件策略**：
- **默认 `sandboxMode === undefined`（不沙箱）**，先跑通。
- 检测到 `spec.sandboxPolicy.mode !== 'danger-full-access'` 时：
  - Git Bash → 显式拒绝（`SANDBOX_UNAVAILABLE` 式错误）或按配置回退 `pwsh`；
  - WSL → **必须 fail closed**（报错，不执行）。
- 不广告 `sandbox_permissions`（`ctx.shell.sandboxMode === undefined` 时 tool 层自动不广告），
  但 **execute 里仍要显式拒绝**该字段 —— 因为"未广告的 key 仍会到达 execute"
  （`dsh-tool-pwsh/lib/index.js:320-331` 的注释明确说明）。
- 代价：**失去 DSH 的提权审批通道**，必须在 README 里写明。

### 6.6 WSL2：比预想乐观得多 —— 基本没有结构性障碍 ⚠️→✅

完整实测见 `.research/wsl.txt`。本机：WSL 版本 **3.0.3.0**，kernel **6.18.54.1**，
已装 `Ubuntu`(默认) / `docker-desktop` / `docker-desktop-data`（实测时均为 Stopped）。

**① 输出编码：问题只存在于元数据，不在执行路径**

```
# wsl.exe 自身的元数据 = UTF-16LE
$ wsl -l -q  → hex 5500620075006e00740075000d000a0064006f0063006b00...
                utf16le → "Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\n"

# 命令输出 = 干净的 UTF-8
$ wsl -e bash -c "printf '%s\n' '你好 世界'"
  hex      = e4bda0e5a5bd20e4b896e7958c0a
  expected = e4bda0e5a5bd20e4b896e7958c0a   → match = true
```

⚠️ **但 "元数据" 不只是列表** —— 实测 `--cd` 传错形态时，
`wsl.exe` 的**错误信息也是 UTF-16LE**（`The parameter is incorrect. ... Wsl/E_INVALIDARG`，
每个字符后带 `\0`）。所以插件**所有** `wsl.exe` 的非执行型输出
（探测、列表、错误）都必须走 UTF-16 感知解码，否则报错文案会变成乱码。
→ 需要一个 `decodeWslOutput(buf)` 帮助函数：检测 BOM / `\0` 密度后选 UTF-16LE 或 UTF-8。

**② cwd：完全不需要处理 ✅（本次最重要的简化）**

| 做法 | 结果 |
|---|---|
| `spawn(wsl, [...], { cwd: 'F:\\TidyProjects' })` | ✅ `pwd` = **`/mnt/f/TidyProjects`** |
| `spawn(wsl, [...], { cwd: 'C:\\Windows' })` | ✅ `/mnt/c/Windows` |
| 不传 cwd（继承进程 cwd） | ✅ `/mnt/f/TidyProjects/dsh-powershell-getaway` |

→ **`wsl.exe` 会继承进程 cwd 并自动翻译成 `/mnt/...`**。
所以 WSL 分支**既不需要 `--cd`，也不需要任何路径换算**，
直接把归一化后的绝对 Windows 路径交给 `spawnSpec.cwd` 即可，与 Git Bash 完全同构。

**③ argv 形态：四种写法全部等价**

| argv | exit | stdout | stderr |
|---|---|---|---|
| `-e bash -c` | 3 ✅ | `OK\n` | `ERR\n` |
| `-- bash -c` | 3 ✅ | `OK\n` | `ERR\n` |
| `-e bash -lc` | 3 ✅ | `OK\n` | `ERR\n` |
| `-e sh -c` | 3 ✅ | `OK\n` | `ERR\n` |

→ 无 banner、无交错、stdout/stderr 分得干净、退出码正确。
**选 `-e bash -c`**（显式、不经过默认发行版 shell 解析）。
（`--` 也可以，但 `-e` 的语义更明确。）

**④ 启动开销：约 270 ms，不是秒级 ✅**

```
runs(ms): 279, 274, 247, 283   （-e bash -c true，4 连跑）
```

→ 首个并不明显更慢（本机 WSL 的 utility VM 保持常驻，发行版 Stopped 但 VM 未销毁）。
270 ms vs Git Bash 134 ms，差距**很小**，所以"WSL 冷启动太慢"**不是**把它降级的理由 ——
你的"WSL2 一等公民"决策在性能上也站得住。

**⑤ 环境变量：默认不跨界，必须走 `WSLENV` ⚠️ 这是 WSL 唯一的真实额外工作**

```
without WSLENV: "DSH_PROBE_X=\n"        ← 空的！Windows env 不会自动进 WSL
with    WSLENV: "DSH_PROBE_X=crossed\n" ← 正确
```

→ DSH 注入的所有 `DSH_*`（`DSH_HOME`/`DSH_PROFILE`/`DSH_SESSION_ID`/`DSH_WEB_URL`…）
**默认在 WSL 里全部不可见**。
→ 我们的 `ctx.shellEnv.register()` 新增变量（`DSH_SHELL_KIND` / `DSH_HOME_POSIX` / `DSH_WORKSPACE_POSIX`）
**必须同时登记进 `WSLENV`**，否则 WSL 分支下模型根本读不到，而 prompt 却在教它读 —— 那是自相矛盾的。
`WSLENV` 是一个冒号分隔的名单，可在 `spawnSpec` 的 `env` 里注入。

**⑥ 其余**

- 无 TTY 可跑：纯管道 stdio 下 exit=0 ✅（与 DSH 的 `stdio:['pipe','pipe','pipe']` 兼容）
- **默认发行版不可假设**：本机默认 `Ubuntu`，但别人机器上可能默认是 `docker-desktop`
  → `wslDistro` 必填校验 + 列表解码 + 选中结果要在结果里注明
- ⚠️ 若走 `dsh-terminal-bash` 的 `shellPath` 指向 `wsl.exe`，**必须加 `--` 分隔符**，
  否则 `wsl.exe` 会把 `--noprofile` 当成自己的选项吃掉
- ⚠️ `where wsl` 有 **3 个**候选（`WindowsApps`、`System32`、`Program Files\WSL`）
  → 绝对路径优先 `C:\Program Files\WSL\wsl.exe` + `wsl --version` 校验
- ⚠️ §6.5：WSL **拿不到任何 Windows 写约束**（结构性）→ 沙箱下必须 fail closed

### 6.6b argv 长度上限 ≈ 32720 字符 ⚠️（实测）

```
script len= 32700 -> exit=0
script len= 32720 -> exit=1        ← 天花板
script len= 60000 -> spawn ENAMETOOLONG
```

- 根因是 Windows `CreateProcess` 命令行 **32767 字符**上限。DSH 最后也走 `spawn`，
  因此**与 shell 无关**，PowerShell 同样受限。
- **绕过方案（已验证）**：`bash -s` + stdin。
  `spawn(gitBash, ['-s'], { stdio:['pipe','pipe','pipe'] })` 写入 50k 脚本 → **exit=0，输出 50003 字节完整**。
  DSH 的 seam 已支持 `spec.stdin`（一次性写入后关闭）。
- **建议**：命令长度 > ~30000 时自动改用 `['-s']` + stdin，并在结果里注明。
  注意 `bash -s` 把 stdin 当脚本，**不能再给脚本喂 stdin 数据**（明确取舍）。

### 6.7 环境变量：官方扩展点存在且干净 ✅

`ctx.shellEnv` 的契约（实测源码）：

```js
ctx.shellEnv.register(contributor)   // 返回 disposer
// contributor = { name: string, variables: { DSH_X: { description } }, resolve(execution) }
//   - key 必须匹配 DSH_[A-Z][A-Z0-9_]*（BASH_ENV_KEY_SUFFIX）
//   - 保留键：DSH_HOME / DSH_SHELL / DSH_SESSION_ID / DSH_PROFILE / DSH_PROFILE_DIR
//   - 同层重名 contributor 会抛错
//   - resolve 返回未声明的 key 会抛错
//   - collect() 返回冻结的 key-排序 overlay，通过 spec.dshEnv 下发，最后合入（优先级最高）
ctx.shellEnv.variables()             // 枚举已贡献变量，不执行 resolver
```

- ⚠️ **`DSH_SHELL=1` 只是"由 DSH shell 调用派生"的中性哨兵**，**不是**方言描述符，
  且没有任何 model-visible 的地方读它。
- ⚠️ **不存在 `DSH_WORKSPACE`**。workspace root 就是 `session.header.cwd`（已做绝对路径校验），
  镜像到 `sandboxPolicy.resolve().workspaceRoot`。
- ⚠️ **Git Bash 继承到的 `DSH_*` 值是 Windows 形态**（`DSH_HOME=C:\Users\Liserver\.dsh`），
  模型在 bash 里用 `${DSH_HOME}` 会拿到反斜杠路径 → 撞 §6.3 的坑。
  （不过 `cygpath -u "$DSH_HOME"` 实测能正确转换。）

**建议注册**：

| 变量 | 值 | 用途 |
|---|---|---|
| `DSH_SHELL_KIND` | `gitbash` / `wsl` / `pwsh` / `cygwin` | 让模型和脚本知道当前方言 |
| `DSH_WORKSPACE_POSIX` | `/f/TidyProjects/...` | 让模型能直接拼 POSIX 路径 |
| `DSH_HOME_POSIX` | `/c/Users/Liserver/.dsh` | 同上 |

**不要**替换 `dsh-shell-env` 本身（它是 host 平面服务，`DSH_WEB_URL`/`DSH_WEB_MODE` 由它下发），只做追加。

### 6.7b 编码：实测字节级正确 ✅

```
$ gitbash -c 'echo "你好 世界 café Ω"'
  hex      = e4bda0e5a5bd20e4b896e7958c20636166c3a920cea90a
  expected = e4bda0e5a5bd20e4b896e7958c20636166c3a920cea90a   → match = true
```

DSH 的 collect 路径是 `Buffer.toString("utf8")`（`dsh-subprocess-local/lib/output.js:193,232`），
**没有任何 StringDecoder/TextDecoder**。既然 Git Bash 输出是精确 UTF-8，
**可以直接接进现成管线，零解码层** —— 比 PowerShell 5.1（需要 `[Console]::OutputEncoding` 前导码）干净得多。

- **删掉** `ENCODING_PREAMBLE`（PowerShell 专属）。
- ⚠️ **必须显式注入 `LANG`/`LC_ALL`** —— 实测（`.research/backslash.txt`）：
  | 调用形态 | `LANG` | `PATH` 头 |
  |---|---|---|
  | `-lc`（登录 shell） | `en_US.UTF-8` | `/c/Users/Liserver/bin` |
  | `--noprofile --norc -c` | **`unset`** | `/mingw64/bin` |
  | `-c` | （同上，不走 profile） | `/mingw64/bin` |
  不走 profile 时 `LANG` 是 unset，部分工具（Python）会按 ASCII 处理 → `UnicodeEncodeError`。
  所以**必须**在 `ENV_OVERRIDES` 里补 `LANG` / `LC_ALL`。
- **启动开销实测**（5 次均值，`.research/backslash.txt`）：
  | 形态 | min | avg | max |
  |---|---|---|---|
  | `-lc` | 1300 ms | **1350 ms** | 1417 ms |
  | `-c` | 124 ms | **134 ms** | 159 ms |
  | `--noprofile --norc -c` | 128 ms | 175 ms | 212 ms |
  → **`-lc` 每次多花约 1.22 秒**（因为它 source `/etc/profile`，Git for Windows 上格外慢）。
  DSH 每次调用都起新进程，50 次调用就是白扔 1 分钟。
  → **选 `--noprofile --norc -c`（或裸 `-c`）**，并自己注入 `LANG` / `PATH`，
  拿到快的启动 + 确定的 locale。这也正是 `dsh-bash-local` 的做法（裸 `["bash","-c",cmd]` + `ENV_OVERRIDES`）。
- 保留 `dsh-bash-local` 的 `ENV_OVERRIDES`（**已导出**，可直接 import）：
  `NO_COLOR=1`、`TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`（`dsh-bash-local/lib/index.js:22-27,332`），
  再追加：
  | 追加项 | 值 | 原因 |
  |---|---|---|
  | `LANG` / `LC_ALL` | `C.UTF-8`（或 `en_US.UTF-8`） | 不走 profile 时实测为 unset（§6.7b） |
  | **`MSYS_NO_PATHCONV`** | `1` | **消除原生程序的静默路径扭曲**（§6.3b，最重要的一项） |
  | `WSLENV`（仅 WSL 分支） | 我们的 `DSH_*` 变量名列表 | 否则 WSL 里读不到（§6.6 ⑤） |
- 可选再加 `LESS=FRX`、`MSYS=winsymlinks:nativestrict`。

### 6.8 后台任务、超时、输出（几乎零成本）

**jobs 对角色的要求极低**（已确证）：executor 只需提供
非消费式 `observed.stdout/stderr` offset readers + `kill()` + `onExpiry:'none'` 时不武装 deadline。
注册逻辑（`registry.start({kind,label,owner,output,run})`）**完全在 tool 层**
（`dsh-tool-pwsh/lib/index.js:361-391`）。
→ 继承 `PwshLocalExecutor` ⇒ `run_in_background` / `job_output` / `job_kill` /
"超时自动升级为后台 job" **全部继续工作**。

**超时机制（要逐字复现）**：`dsh-timeout`
- `clampTimeout(requested, def, max, name)` → `min(requested ?? def, max)`
- `deadline(signal, timeoutMs, code)`：`timeoutMs <= 0` 时不武装任何 deadline
- 归因：`timeoutOf(sig, code) !== undefined` → `timedOut`，否则 `sig.aborted`
- **每一条 settle 分支**都要 `d[Symbol.dispose]()`
- `MAX_TIMER_DELAY_MS = 2147483647`

**超大输出**：只要通过 `ctx.subprocess` 用 `{maxBytes, spill:{maxBytes}}` collect 布局 spawn，
spill 自动继承。tool-token retainer（`spill-policy` + `ctx.spillStore`）是挂在 tool 名上的
`tools/post-execute` 钩子，也**无需改动**。

⚠️ **MSYS2 fork 与 Job 区间的疑问**：实测 `bash -c "bash -c '...' & wait"` 正常，
但"bash 被 kill 后 fork 出的孤儿子进程是否留在同一 Win32 Job 里"**未验证**（§11 P1）。

### 6.9 其他

| 场景 | 处理 |
|---|---|
| Git Bash 未安装 | 探测失败 → 插件启动时抛明确错误（不是运行期才炸）；或按 `shell:'auto'` 回退 WSL → 再回退 pwsh + log 警告 |
| WSL 未安装 / 无发行版 | `wsl.exe` 返回非 0 + 空输出；需在探测期判定（`03-shell-environment.md` §5 列为 NOT MEASURED，需补测） |
| Cygwin | 实测存在可用（3.5.4），但语义不同（`/cygdrive/c` 而非 `/c`，bash 标识 `x86_64-pc-cygwin`）→ 需独立 `pathStyle` 与身份校验 |
| **`where.exe bash` 的假阳性** | ⚠️ `System32\bash.exe` 与 `WindowsApps\bash.exe` 都能通过 `bash --version` 报出 **`5.3.9(1)-release (x86_64-pc-linux-gnu)`** —— 能力探测会误判成"我们有 Linux bash"，实际是 WSL 转发。**必须用 `x86_64-pc-msys` / `x86_64-pc-cygwin` 做身份校验**，不能只看"能跑" |
| **`F:\...\usr\bin\bash.exe` vs `bin\bash.exe`** | `bin\bash.exe` 会**再 spawn 一个 `usr\bin\bash.exe` 子进程**（node → bin → usrbin → 目标），多一层进程树、多一层 kill 复杂度；且强制 `MSYSTEM=MINGW64`。→ **默认用 `usr\bin\bash.exe`** |
| **`C:\Users\Liserver` 是 junction** | 实测它指向 `C:\Users\杨绍璞` → `--cd C:\Users\Liserver` 在 WSL 里落到 `/mnt/c/Users/杨绍璞`。路径身份不可假设字面相等 |
| 命令含 NUL | `dsh-subprocess-local` 会抛 `ERR_INVALID_ARG_VALUE`，无需额外处理 |
| 命令超长 | 见 §6.6b（`bash -s` + stdin） |
| `run_in_background` + `stdin` | `stdio.stdin = { data }` 一次性写入后关闭；交互式命令仍不支持（官方 seam 限制） |
| 与 `tool-pwsh-persistent` 混用 | 若同时挂了 pwsh 持久 shell，模型会两个方言都写 → 建议一并 `deny` |
| subagent / 各 preset | 插件在 host 平面全局注册；但 preset 在**自己的 realm** 重新声明了 `tool-bash`/`tool-pwsh`，需验证 restrict 能否穿透（§11 P0） |
| CRLF（**仅 WSL**） | ⚠️ Git Bash **会**静默剥离 `\r`；**WSL 不会** —— `bash script.sh` 里 `$1` 会带上 `\r`。→ WSL 分支需要**把脚本里的 `\r\n` 归一化为 `\n`**（实测见 `.research/verify4.txt`） |
| `chmod` 在工作区是空操作 | `chmod 755 /mnt/f/...` → `stat -c '%a'` 仍报 **777**（Windows ACL 继承）。任何依赖 Unix 权限位的操作在 `/mnt/*` 上不可信 |
| 升级 DSH | `argv()` seam 可能变；`peerDependencies` 精确锁版本 |
| ⚠️ 本机 DSH 宿主是 **Windows PowerShell 5.1** | 不是 pwsh 7。PS 5.1 的 `>` / `*>` 会按 `[Console]::OutputEncoding` **重新解码原生程序输出**（我用它抓 `wsl -l -q` 得到 198 字节的垃圾而不是真实 90 字节），且内联脚本里的 `"` 会被截断。→ **与本插件无关，但写探测脚本时踩了两次**，后续实现者注意：探测一律写文件 + 用 Node 读原始字节 |

---

## 7. 实施计划

### 阶段 0：可行性验证（半天，强烈建议先做）
1. 用方案 B 的 patch 直接启用 `bash-sandbox`/`tool-bash`，临时把 PATH 指到 Git Bash 的 `usr\bin`
   （**必须**，否则会走 WSL 启动器）。
2. 跑 3 个真实任务（多行脚本、中文输出、`git` 操作），对比模型表现。
3. 产出"换 shell 到底省了多少 token / 少了几轮失败"的**基线数据**，作为后续验收依据。

### 阶段 1：MVP
- 新建包 `dsh-shell-getaway`，只支持 `shell: 'gitbash' | 'pwsh'`。
- 继承 `PwshLocalExecutor`，覆写 `argv()` / `resolve()`。
- 挂官方 `@deepseek-ai/dsh-tool-bash`。
- `ctx.tools.restrict({ deny: ['pwsh'] })`。
- 绝对路径探测 Git Bash + 身份校验 + 显式排除 WSL 启动器/WindowsApps alias。
- 补 prompt section（Windows 强杀语义 + POSIX 路径/变量/`workdir` 教学）。
- `workdir` 双向归一化。
- **验收**：本会话里 `pwsh` 消失、`bash` 出现，3 个真实任务全过。

### 阶段 2：稳健化
- `shell: 'auto'` 探测链 + 明确失败信息。
- 长命令自动走 `bash -s` + stdin。
- `pathStyle: 'windows'` 兼容模式（默认关）。
- `LANG`/`LC_ALL` + `ctx.shellEnv.register()` 注入 POSIX 化变量。
- 沙箱策略检查与显式拒绝（Git Bash 拒绝 / WSL fail closed）。
- 与 Web "Shell 设置页"对齐（占用 `bash-sandbox` entry id）。
- 单元测试：argv 生成、路径转换、探测优先级、Config 校验。

### 阶段 3：可选扩展
- WSL2 支持（`wslDistro` + `--cd` + 元数据的 UTF-16LE 探测解码）。
- Cygwin 支持（`/cygdrive` 路径风格）。
- 持久 shell：`dsh-tool-bash-persistent` + `dsh-terminal-bash(shellPath=Git Bash, shellDialect=bash)`
  —— 注意 WSL 需要 `--` 分隔符（§6.6 陷阱 6）。
- 向上游提 issue：给 `dsh-bash-local` 加 `bashPath`、把 `argv()` seam 提到共同基类。

---

## 8. 测试计划

| 层 | 用例 |
|---|---|
| 单元 | `argv()` 对 4 种 shell 的输出；`toWindowsPath`/`toPosixPath`；Config 默认值与校验；探测链优先级（注入假文件系统，覆盖 0 字节 reparse point 与 `System32\bash.exe`） |
| 集成 | 与 `dsh-subprocess-local` 联调：多行脚本、exit code、timeout 归因、spill、后台 job 提升 |
| 回归 | `run_in_background` + `job_output`；超时→job；kill；输出截断；`[exit code: N]` marker；`parseExitStatus` 兼容（**必须复用**，否则 Web 的 exit pill 会坏） |
| 模型面 | 断言 `pwsh` 不在 `tools.schemas()`；断言 prompt 里没有 `$env:`/`C:\`；断言 Windows 强杀语义**存在** |
| 平台 | Git Bash 缺失 / 只有 Cygwin / WSL 无发行版 / WSL 多发行版且默认是 docker-desktop |
| 边界 | 32720 字符上下；含 `\"` 的脚本；CRLF；非 ASCII；`$'...'` |
| 安全 | 反斜杠路径；`;`/`&&` 注入；NUL；跨用户 alias 不被选中 |

---

## 9. 风险登记册

| 风险 | 等级 | 缓解 |
|---|---|---|
| **覆盖 `preset-standard` 时漏行** → 静默丢掉 `agent-instructions`/`tool-fs`/`planning`/`compaction`/`delegation` 等能力 | **高** | patch 整体替换 config 不深合并；从 shipped 文件逐字抄录并加断言测试（§4.3b） |
| `tool-pwsh` 仍被激活 → 模型方言混乱 | **高** | 阶段 0 第一件事就是验证 preset 覆盖真的让它消失 |
| **WSL2 在受限模式下"看起来在沙箱里、实际零约束"** | **高** | 结构性事实，**永远 fail closed**，且不提供配置绕过（§13.2） |
| Git Bash 在受限令牌下静默失去子进程 | **高** | 显式报错 + 可执行提示；`allowConfined` 逃生舱默认关（§13.2） |
| 丢掉"Windows 强杀 = exit 1"这条事实 → 模型误修不存在的问题 | **高** | 补 prompt section（§5.2）+ 断言测试 |
| `auto` 静默降级到非预期 shell（如落到 `docker-desktop` 发行版） | **高** | 每次探测结果都注明实际选中者；`wslDistro` 必填校验；解码 UTF-16LE 列表 |
| `spec.cwd` 传 POSIX 路径 → spawn ENOENT 且错误信息误导 | 中 | `resolve()` 统一归一化为绝对 Windows 路径（§6.4）；加单测 |
| 反斜杠路径导致模型反复失败 | 中→**低** | 已更正为"建议正斜杠 + 含反斜杠要用单引号"（§6.3），不再是禁令 |
| **MSYS2 静默改写传给原生程序的 POSIX 参数**（`-v /data:/x` → 挂到 `C:\Program Files\Git\...`，`: `→`;`，**不报错**） | **高** | `MSYS_NO_PATHCONV=1` 默认写进 `ENV_OVERRIDES`；实测零副作用（§6.3b） |
| MSYS2 反向改写 `/Flag` 形态参数（影响调用 Windows 原生程序） | 中 | 同上，一并被 `MSYS_NO_PATHCONV` 消除 |
| 关掉转换后，需要转换的调用（`git clone host:/path`）失效 | 低 | Config `msysPathConv` 逃生舱 + 教学段说明 |
| 裸 `bash` 解析到 WSL/Cygwin/跨用户 alias | 中 | 绝对路径 + 身份校验 + 绝不回退裸名（§6.1） |
| `wsl.exe` 有 3 个候选，可能选到旧版 | 中 | 绝对路径优先 `C:\Program Files\WSL\wsl.exe` + `wsl --version` 校验 |
| MSYS2 fork 子进程逃出 Job 区间，kill 不干净 | 中 | 阶段 1 实测；必要时外层再包进程组管理 |
| 在 `apply` 里启动脱管异步 → 未处理 rejection 直接让 app 退出 | 中 | 所有注册走 `ctx.effect`/`ctx.on` 并返回 cleanup（官方硬规定） |
| WSL 冷启动秒级 + DSH 超时默认 120 s → 落到后台 job | 中 | 探测期预热（后台 `wsl -e true`）；文档说明；不设过小超时 |
| 上游 `argv()` seam 变更 | 中 | 精确锁 `peerDependencies`；把设计提上游 |
| 复用 `dsh-tool-bash` 导致 workdir 混合分隔符 bug | 中 | 我们自己的 `resolve()` 用 `path.win32.resolve` 归一化 |
| 长命令撞 32767 上限 | 低 | 自动切 `bash -s` + stdin（§6.6b） |
| 用户不装 Git Bash 也没 WSL | 低 | `auto` 报错 + 明确安装指引；显式 `shell: 'pwsh'` 可回退 |

---

## 10. 交付物

| 路径 | 内容 |
|---|---|
| `dsh-shell-getaway-research.md` | 本文档（核心调研 + 实施方案） |
| `.research/findings/01-plugin-contract.md` | **官方插件契约**（2067 行）：bundle manifest、`install_bundle` 流程、`!!js` 全量清单、patch 方言 |
| `.research/findings/02-powershell-prompt-audit.md` | **PowerShell 提示词足迹全量审计**（1497 行，27 项风险登记，14 项 MUST-FIX） |
| `.research/findings/03-shell-environment.md` | Git Bash / WSL2 环境实测 —— **未产出**：该子代理被我中止，因为它要测的项目我在 §6 里已全部独立复现（来源见 `.research/probe-*.mjs` 与 `*.txt`）。环境实测的权威结果以本文 §6 为准 |
| `.research/findings/04-seam-contracts.md` | **`ctx.shell`/`ctx.subprocess`/jobs/sandbox 契约**（2939 行，逐条 `path:line` 引用） |
| `.research/dsh-src/` | 从 `app.asar` 解包的 DSH 全部源码（11 470 文件）—— 含上面提到的官方 skill 原文 |
| `.research/probe-*.mjs` | 本文档所有实测数据的**可复现脚本**（argv 保真度、编码、长度上限、WSL） |
| `.research/shell-contract.txt`、`encoding.txt`、`argv-limit.txt` | 原始实测输出 |

> **给下一轮实现者的第一条建议**：先 `skill` 加载 `cordis-plugin-development` 与
> `editing-cordis-compositions`（这两个 skill 随 DSH 发布，是官方权威规范），
> 再复制 `templates/mcp/` 作为 bundle 起点，然后照本文 §4 的修正版流程走。

---

## 11. 待验证清单（写代码前必须坐实）

- [ ] **P0** `ctx.tools.restrict()` 已确认**不能全局调用**（§4.3）；
      确认"覆盖 `preset-standard` 声明"这条官方路径能真正阻止 `pwsh` tool 激活
      （注意 preset 内的行 id 与 host 平面行 id 是否在同一命名空间）
- [ ] **P0** 覆盖 `preset-standard` 时**逐字复述** shipped 列表的正确性
      （patch 整体替换 config，绝不深合并 —— 漏一行就静默丢功能）
- [ ] **P0** preset 内的 `tool-bash` 行能否看到 host 平面的 `ctx.shell`
      （官方说"preset plugin 提供 service 必须把 provider 和 consumer 放在同一 realm"，
      而 `ctx.shell` 是 host 平面的 —— 反过来 consumer 在 preset 里读 host service 是否成立？）
- [ ] **P0** 从插件的 `apply(ctx, config)` 里 `ctx.plugin()` 挂官方 `@deepseek-ai/dsh-tool-bash`
      的确切写法与加载时序（它是函数式插件，`inject: ['tools','shell','systemPrompt','shellEnv']`）
- [ ] **P0** `systemPrompt.section` 的裸数字 `order` 是否被接受（还是必须走 `getSectionOrder`）；
      以及是否会与 preset 内注册的 section 冲突
- [ ] **P0** Git Bash 在 `danger-full-access` 之外是否真的起不来（实测一次）
- [ ] **P1** MSYS2 fork 的子进程是否留在同一 Win32 Job 区间内（kill 干净度）
- [ ] **P1** `bash -s` + stdin 走 DSH 的 `spec.stdin` 通道是否真能工作（我们只用原生 spawn 验证过）
- [ ] **P1** Web 设置页：`configForms.get('bash-sandbox')` 是否严格按 entry id 匹配
      （决定 MVP 要不要自带 UI 插件）
- [ ] **P1** `install_bundle` 能否接受"工作区目录 + 覆盖 shipped preset"这种 patch 形态
- [ ] **P2** Config 被 Web 设置页运行期改写后是否需要重启
- [ ] **P2** `dsh-tmux-context` 在 WSL 下会不会误触发

---

## 12. 需要你拍板的决策点

1. **默认 shell 选哪个？**
   - **Git Bash（推荐）**：零网络依赖、已安装、150 ms 冷启动、完整 GNU 工具链、UTF-8 干净。
   - WSL2：工具链更强，但多发行版歧义（实测默认含 `docker-desktop`）、秒级冷启动、
     沙箱完全无效、需要 `wslDistro` 配置。
   - 两者都做 + `auto` 探测（工作量 +40%）。

2. ~~沙箱收紧时怎么办？~~ → **已拍板：显式报错**（见 §13.1），本节保留供追溯。

3. **插件归属与命名**（待拍板）
   - 自建 scope（如 `@tidy/dsh-shell-getaway`）还是本地不入 npm 的 `file:` 包？
     官方 `install_bundle` 接受**绝对本地目录**，所以 MVP 可以先本地、不发 npm。
   - tool 名固定 `bash`（与官方一致，UI/模型都自然）—— 除非你希望叫 `sh` 以示区别。

4. **是否顺带接上持久 shell？**（待拍板）
   `dsh-tool-bash-persistent` + `dsh-terminal-bash(shellPath=Git Bash)`。
   持久 shell 对某些任务价值很大，但 PTY + MSYS2 有额外风险（WSL 还需 `--` 分隔符）。
   建议放阶段 3。

5. **WSL2 的"一等公民"边界到哪？**（待拍板，见 §13.2）
   - WSL2 是否也进 `auto` 的探测链（即 Git Bash 缺失时静默启用 WSL2）？
   - WSL2 下 `workdir` 与命令体的路径风格差异（`/mnt/c/...`）要不要做**自动转换**？
   - 是否要为 WSL2 同步提供持久 shell（需 `--` 分隔符 + PTY over WSL 的额外风险）？

---

## 13. 拍板分析（2026-01 决策）

### 13.1 决策一：默认 Git Bash，但 WSL2 是**一等公民**

#### 这个决策是合理的，而且成本比想象中低

三条独立理由支持你的判断：

1. **Git Bash 做默认有实测依据**：启动 128–175 ms（WSL 冷启动是秒级）、
   输出**字节级精确 UTF-8**、工具链齐全（`sed/awk/grep/find/xargs/git/curl/make/python/node/tar/unzip/cygpath`，
   仅 `jq` 缺失，而 `jq.exe` 在 Windows PATH 上可被直接调用）、零网络依赖、无发行版歧义。
2. **WSL2 做一等公民是对的，因为"能跑"和"该跑"是两件事**：本次实测确认
   WSL 的**命令输出就是 UTF-8**（不只是元数据），`--cd` 桥接可用，无 TTY 也能跑。
   也就是说 WSL2 的执行路径**不需要任何解码层或 hack** —— 它已经具备一等公民的技术条件。
   把它降级为"顺手支持"会浪费这个事实。
3. **"一等公民"的真正成本在文档与错误处理，不在代码**：执行器多一个分支是 ~15 行；
   真正的工作量是 distro 选择、路径风格教学、沙箱策略、测试矩阵 —— 这些**反正都要做**，
   因为一旦支持就必须做对。

#### ⚠️ 但它引入一个**架构级的副作用**，这是本节最需要你注意的地方

`argv(spec)` 是**同步**函数，而 WSL 的 cwd 只能通过 `--cd` 传
（`spec.cwd` 是给 `CreateProcess` 的 Windows 路径，WSL 里的 bash 看不懂 `/mnt/...` 之外的语义）。
于是：

| shell | `spec.cwd`（给 CreateProcess） | bash 看到的 cwd |
|---|---|---|
| Git Bash | 必须 Windows 形态（§6.4 硬约束） | Git Bash 自动转成 `/f/...` ✅ |
| WSL2 | 无所谓（wsl.exe 会忽略/继承） | **必须靠 `--cd <windows-path>` 显式指定** |
| pwsh | 必须 Windows 形态 | PowerShell 原生 ✅ |

→ **`resolve()` 必须做一次同步的、与具体 shell 无关的归一化**：
把 `workdir` 统一解析成**绝对 Windows 路径**（用 `path.win32.resolve`），
然后由 `argv()`/`spawnSpec()` 各自转换（Git Bash 直接用；WSL 转成 `--cd` 参数）。
`cygpath`/`wslpath` 都是**子进程调用**，同步 `argv()` 里用不了 —— 必须用纯 JS 字符串转换。

→ 这也意味着我们需要覆写**三个**点（`resolve` / `argv` / `spawnSpec`），而不是原计划的"只覆写 `argv`"。
工作量增加约 40 行，且必须避免 §6.4 那个"`spec.cwd` 传 POSIX 就 ENOENT"的坑。

#### 其他影响面（按重要性）

| # | 影响 | 说明 |
|---|---|---|
| 1 | **`auto` 探测链语义** | `auto` = Git Bash → WSL2 → pwsh，**每一步都在结果里注明实际选了谁**（不能静默降级）。三者都没有 → 显式报错并给安装指引 |
| 2 | **`LANG` 必须显式注入** | 实测 `--noprofile --norc` 下 `LANG` 是 unset；`-lc` 有 `en_US.UTF-8` 但慢 1.22 s。选快的路径就必须自己补 `LANG`/`LC_ALL`（§6.7b） |
| 3 | **distro 选择** | 本机默认是 `Ubuntu`，但 PATH 上还挂着 `docker-desktop` 系列。必须提供 `wslDistro` 且在探测时**解码 UTF-16LE**的 `wsl -l -q`；绝不能落到 `docker-desktop` |
| 4 | **两套路径约定** | Git Bash `/c/...` vs WSL `/mnt/c/...`。prompt 一次性客观描述两者，靠 `DSH_SHELL_KIND` 让模型自判（不要动态改写 prompt，会破坏 KV cache 前缀稳定性） |
| 5 | **`wsl.exe` 自身也有解析陷阱** | `where wsl` 有 **3 个**结果（`WindowsApps`、`System32`、`Program Files\WSL`）。必须绝对路径优先 `C:\Program Files\WSL\wsl.exe`，并校验 `wsl --version` 可解析 |
| 6 | **测试矩阵翻倍** | 每个 shell 分支都要跑：冷/热启动、exit code、timeout 归因、后台 job、spill、长命令、非 ASCII、cwd 桥接 |
| 7 | **文档面** | README 要分别写两套"路径怎么写 + 怎么排错"；错误信息要带 shell 名（"Git Bash 下请用 `/c/...`" vs "WSL 下请用 `/mnt/c/...`"） |

### 13.2 决策二：沙箱有问题**必须显式报错**

#### 这个决策我完全赞成，而且它有官方依据

你的理由——"静默的未知比报错更可怕"——与 DSH 自己的设计哲学一致：
`dsh-pwsh-sandbox` 在没有任何 runner 能强制执行受限模式时
**"fails closed with a structured `SANDBOX_UNAVAILABLE` error rather than running unconfined"**。
我们照抄这个语义即可，而且可以直接复用同一个错误类型（`SandboxUnavailableError`）。

**技术上也是必须的**，因为两条"静默失效"路径真实存在：

| 场景 | 如果不报错会发生什么 |
|---|---|
| Git Bash 在受限令牌下 | MSYS2 的 `fork()` / named pipe 失败 → 命令**可能启动失败，也可能跑起来但子进程无声死亡**，输出为空、退出码正常。模型会以为命令成功了 |
| **WSL2 在受限令牌下** | 受限令牌只约束 `wsl.exe` 本身，**Linux payload 完全不继承 SID/低完整性标签**，`/mnt/c` 的 I/O 由宿主侧服务代理 → **看起来在沙箱里，实际零约束**。这是最危险的静默失效 |
| 沙箱模式探测本身失败 | 我们不知道当前是哪个模式 → 任何"默认放行"都是猜测 |

#### 落地方案：一个统一的门禁，`fail closed`，错误信息可执行

```
判定时机：每次执行（用 executeArgv 的 async prepare 函数，官方支持）
判定输入：spec.sandboxPolicy?.mode（tool 层每次调用都会传；直连调用可能缺省 → 用 deployment 默认）

规则表：
  mode = 'danger-full-access'（或缺省）        → 放行
  mode = 'workspace-write' / 'read-only'
      + shell = gitbash  → 报错（除非 allowConfined: true 显式开启）
      + shell = cygwin   → 同上
      + shell = wsl      → 【永远报错】，且明确禁止用配置绕过
      + shell = pwsh     → 放行（走原来的 pwsh + ACL 路径）
  模式无法判定        → 报错
```

错误信息模板（必须可执行 —— 给模型"下一步"而不是"失败"）：

```
Error: bash (Git Bash) cannot run under sandbox mode "workspace-write".
Reason: the Windows ACL restricted token blocks the named pipes MSYS2 needs for
process creation, so a command may start and then silently lose its children.

To proceed, do one of:
  1. Ask the user to switch this session's file policy to danger-full-access
     (then re-run the exact command).
  2. Set the "shell" config to "pwsh" for this profile, which is sandbox-compatible
     (but you must then write PowerShell).
  3. If you have already verified that Git Bash works in this mode on this machine,
     set "allowConfined: true" in the shell-getaway config (NOT available for WSL).
```

> 注意：**`allowConfined` 逃生舱对 WSL 不开放**。WSL 的"没有约束"是结构性事实，
> 不是"这台机器上恰好能用"，给配置开关等于把谎言做成选项。

#### 副作用与取舍（需要你知情）

1. **会失去 DSH 的提权审批通道**：因为 `ctx.shell.sandboxMode` 返回 `undefined`（我们不沙箱），
   tool 层就**不会广告** `sandbox_permissions` 字段。模型无法"申请提权"，
   只能靠报错信息引导用户改策略。这是我们能给的最诚实的形态。
2. **受限模式下工具直接不可用**：如果用户长期跑 `workspace-write`，
   这个插件在 Git Bash/WSL 下就是"永远报错"。必须让用户**知道这是刻意的**，
   所以阶段 1 的验收里要包含"受限模式下报错文案是否清晰可执行"。
3. **不会静默回退 pwsh**：按你的决策，Git Bash/WSL 失败就是失败，
   不自动切回 pwsh（避免"方言来回切"这种更隐蔽的混乱）。
   若用户想要回退，那是**配置行为**（改 `shell: 'pwsh'`），不是运行时行为。

#### 唯一还需要你后续确认的边界

`auto` 探测链在受限模式下该怎么走？两种设计：

| 设计 | 行为 | 取舍 |
|---|---|---|
| **A（推荐）** | 受限模式下 `auto` **直接报错**，提示"受限模式下只能显式选 pwsh" | 最诚实，符合你的决策精神；但用户从 full-access 切到受限后会突然全挂 |
| B | 受限模式下 `auto` 自动解析为 `pwsh`，并在首条结果里**明确告知**"已回退到 pwsh" | 更平滑，但引入了一次隐式切换（虽然告知了） |

我倾向 A，因为它和"必须显式报错"是同一个原则；B 是"告知式降级"，边界模糊。
**这一条留给你在最终 plan 里定。**

---

## 附录 A：关键源码坐标

| 事实 | 文件:行 |
|---|---|
| **★ 官方插件开发 skill** | `dsh-agent-preset/skills/cordis-plugin-development/` |
| └ Host 插件导出形式 / bundle manifest / 安装语义 | `…/references/host-plugin.md:3,18,47-54,56-60` |
| └ 扩展点选择准则（"用最弱的机制"） | `…/references/practices.md:10,17,22` |
| └ 官方 preset 创建/修改/校验 | `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:54-66,76-80` |
| `ctx.tools.restrict()` **必须 scoped**、未知名字报错 | `dsh-tools/lib/index.js:2895-2909` |
| `ctx.settings` 不是设置存储（是 `SettingsForms`） | `dsh-settings/lib/index.js:302-308` |
| `ctx.shell` 单 Provider、`super(ctx,'shell')` | `dsh-shell/lib/index.js:83-93` |
| `dsh-shell` 实际导出（**无** `SHELL_SETTINGS_NAMESPACE`） | `dsh-shell/lib/index.js:95` |
| `PwshLocalExecutor` 的 `argv()` seam | `dsh-pwsh-local/lib/index.js:197-206` |
| `PwshLocalExecutor.Config`（默认值） | `dsh-pwsh-local/lib/index.js:140-148` |
| `pwshPath` + `resolvePwshPath` + `candidatePwshPaths` | `dsh-pwsh-local/lib/index.js:23-65,149-161` |
| `ENCODING_PREAMBLE`（PowerShell 专属） | `dsh-pwsh-local/lib/index.js:100` |
| `LocalBashExecutor` 裸 `"bash"` argv | `dsh-bash-local/lib/index.js:141-145` |
| `ENV_OVERRIDES`（已导出，可 import） | `dsh-bash-local/lib/index.js:22-27,332` |
| `executeArgv` 支持 **async prepare 函数** | `dsh-pwsh-local/lib/index.js:280-302` |
| `dsh-tool-bash` 的 inject / section | `dsh-tool-bash/lib/index.js:222-233,377-381` |
| `dsh-tool-bash` workdir 裸 `${sep}` 拼接（bug） | `dsh-tool-bash/lib/index.js:293-299` |
| `dsh-tool-pwsh` 的 section（含 Windows 强杀语义） | `dsh-tool-pwsh/lib/index.js:348-352` |
| `dsh-tool-pwsh` workdir 用 `path.resolve`（正确） | `dsh-tool-pwsh/lib/index.js:263-268` |
| `SECTION_ORDERS.TOOL_BASH=1000 / TOOL_PWSH=1010` | `dsh-system-prompt/lib/index.js:17-18` |
| 平台分支（执行器 + tool） | `dsh-base/cordis.patch.yml:235-273` |
| preset 里的平台分支 | `dsh-web-app/presets/standard.patch.yml:20-25` |
| Win32 argv 转义 `quoteArg`/`buildCommandLine` | `dsh-win32-process/lib/index.js:352-376` |
| Windows 可执行解析（只认 `.com`/`.exe`） | `dsh-subprocess-local/lib/runner-launch-*.js:1465-1501` |
| 输出解码固定 UTF-8 | `dsh-subprocess-local/lib/output.js:193,232` |
| Windows 沙箱链 = `["windows-acl"]`，探针 `cmd /c exit 0` | `dsh-sandbox-local/lib/index.js:137-139,176` |
| console isolation 不可用（受限令牌） | `dsh-sandbox-windows-acl/lib/types-*.js:1171-1173` |
| `shellEnv.register` 契约 | `dsh-shell-env/lib/index.js:58-78,84-105` |
| `DSH_SHELL=1` 是中性哨兵 | `dsh-shell-env/lib/index.js:19,87` |
| `dsh-timeout` 的 clamp/deadline/归因 | `dsh-timeout/lib/index.js`（`clampTimeout`/`deadline`/`timeoutOf`） |
| jobs 注册（全在 tool 层） | `dsh-tool-pwsh/lib/index.js:361-391` |
| Web 设置页绑定的 entry id | `dsh-client-ui-settings-shell/lib/client.js:115-117,176-188` |
| 设置命名空间默认值 | `dsh-settings/lib/index.js:307` |
| `ctx.tools` 方法契约（register/restrict/guard） | 实时 `cordis_inspect_list` → Service |
| `defineTool` 契约（`output.render` **必需**） | `dsh-tools/lib/index.js:838+` |
| 脱管异步 rejection → app 退出 | `dsh-app-boot/README.md:105` |
| `dsh-terminal-bash` 双方言 + shellPath/shellArgs | `dsh-terminal-bash/lib/index.js:9-41` |
