# dsh-shell-getaway —最终实施方案（v2 · 已冻结 · 待开工）

> **目标**：在 Windows 上让 agent 用 bash（Git Bash 默认，WSL2 一等公民）替代 PowerShell，
> 不再为 PowerShell 的转义、引号、`$env:`、`-Command` 长难句买单。
>
> **本文件是决策完备的实施方案**，可直接照着写代码，无需再做大设计决策。
> 调研过程与全部实测原始数据见 [`dsh-shell-getaway-research.md`](dsh-shell-getaway-research.md)。
>
> 目标环境：DSH `0.2.0-rc.2` · desktop profile · Windows 11 22631 · Node `24.21.0`
> 已确认可用：Git Bash 5.2.21(msys) · WSL2 3.0.3.0（Ubuntu 26.04，kernel 6.18.54.1）· Cygwin 3.5.4
>
> **用户已拍板（全部）**：
> 1. **默认 Git Bash；WSL2 必须是一等公民**（完整支持，不是"顺手能跑"）。
> 2. **沙箱有问题必须显式报错**，宁可中断也不静默降级（"静默的未知比报错更可怕"）。
> 3. 子决策 A–F 全部确定，见 §9（bash 用 `--noprofile --norc -c`；`auto` 受限时报错；
>    用 `usr\bin\bash.exe`；MVP 不自带设置页；包名 `@local/dsh-shell-getaway` /
>    内部 id `shell-getaway`；`MSYS_NO_PATHCONV=1` 默认开）。
>
> **状态**：方案已冻结，等待开工批准。

---

## 0. 决策记录与合理性评估

### 0.1 决策一：默认 Git Bash + WSL2 一等公民 —— **合理，且实测支持**

| 维度 | Git Bash | WSL2 |
|---|---|---|
| 启动 | **98–175 ms** | 冷 **3385–5147 ms** / 热 **212–299 ms** |
| 输出编码 | UTF-8 无 BOM ✅ | 命令输出 UTF-8（与 Git Bash 字节相同）✅ |
| 环境变量跨界 | 全量继承（仅 7 个变量名被大写化） | **默认一个都不通**，需 `WSLENV` 白名单 |
| 路径 | `/c/...`，MSYS 层有参数改写陷阱 | `/mnt/c/...`，cwd 自动翻译、无环境陷阱 |
| 工具链 | 齐全（`sed/awk/grep/find/git/curl/make/python/node/tar`，缺 `jq`/`wget`） | 齐全（`python3`/`git`/`curl`/`wslpath`，**缺 `node`**） |
| 沙箱可用性 | 结构性不兼容（named pipe / console isolation） | **结构性完全无效**（受限令牌不跨 Hyper-V） |

**结论**：默认 Git Bash 的三条实测依据成立（快、UTF-8 干净、工具齐全、无发行版歧义）；
而 WSL2 具备一等公民的技术条件（命令输出 UTF-8、cwd 自动桥接、无 TTY 可跑、热启动仅 ~250 ms）。
"WSL 冷启动慢所以只能降级"是个**错误的前提** —— VM 通常常驻，只有 `--terminate` 或重启才付冷启动成本。

**成本评估**：执行器多一个分支 ≈ 15 行；真正的增量在
① 发行版枚举与选择 ② 两套路径教学 ③ `WSLENV` 白名单 ④ 测试矩阵翻倍。这些**一旦支持就必须做**。

### 0.2 决策二：沙箱问题必须显式报错 —— **合理，且有官方先例**

你的理由（"静默的未知比报错更可怕"）与 DSH 自身设计一致：
`dsh-pwsh-sandbox` 在没有任何 runner 能强制执行受限模式时
**"fails closed with a structured `SANDBOX_UNAVAILABLE` error rather than running unconfined"**。
我们复用同一语义即可。

**三条"静默失效"路径真实存在**，这是必须报错的技术理由：

| 场景 | 不报错会发生什么 |
|---|---|
| Git Bash 在受限令牌下 | MSYS2 的 `fork()`/named pipe 失败 → 命令可能启动失败，**也可能跑起来而子进程无声死亡**，输出为空、退出码正常。模型以为成功了 |
| **WSL2 在受限令牌下** | 受限令牌只约束 `wsl.exe`；Linux payload 以 Linux uid 创建，`/mnt/c` I/O 由宿主侧服务代理 → **看起来在沙箱里，实际零约束**。最危险的静默失效 |
| 模式探测本身失败 | 不知道当前模式 → 任何"默认放行"都是猜测 |

### 0.3 两项决策对原规划的**影响面**

| # | 影响 | 说明 |
|---|---|---|
| 1 | **cwd 处理反而大幅简化** ✅ | 实测 `wsl.exe` **继承进程 cwd 并自动翻译成 `/mnt/...`** → WSL 分支**不需要 `--cd`、不需要路径换算**，与 Git Bash 完全同构。原本担心的"`resolve()` 必须做 shell 相关归一化"降级为"统一成绝对 Windows 路径" |
| 2 | **新增必须项：`WSLENV` 白名单** | 实测 Windows env **默认一个都不过界**。DSH 的 `DSH_*` + 我们注入的 POSIX 变量必须在 `WSLENV` 里登记，否则 prompt 教模型读的变量在 WSL 下**根本不存在**（自相矛盾） |
| 3 | **新增必须项：`WSL_UTF8=1`** | 实测它把 `wsl.exe` 的**全部**输出（列表、状态、甚至错误信息）变成 UTF-8 → 省掉 UTF-16 解码器这一整块复杂度 |
| 4 | **沙箱门禁成为唯一的 gate** | 统一在 `executeArgv` 的 async prepare 里判定；Git Bash 有 `allowConfined` 逃生舱，**WSL 永远没有** |
| 5 | **不再有"自动回退 pwsh"** | 按你的决策，失败即失败。回退是**配置行为**（改 `shell: 'pwsh'`），不是运行时行为 |
| 6 | **失去 DSH 提权审批通道** | `ctx.shell.sandboxMode === undefined` → tool 层不广告 `sandbox_permissions`。代价必须在 README 写明 |
| 7 | **prompt 要同时描述两套路径** | Git Bash `/c/...` vs WSL `/mnt/c/...`；不能动态改写 prompt（破坏 KV cache 前缀稳定性，且官方要求用 `systemPrompt.section()` 而非监听 assemble） |
| 8 | **`auto` 探测链语义** | `gitbash → wsl → pwsh`，**每步都在结果里注明实际选中者**；三者皆无则显式报错 + 安装指引 |
| 9 | **测试矩阵翻倍** | 每个 shell 分支都要覆盖：冷/热启动、exit code、信号、超时、后台 job、spill、长命令、非 ASCII、cwd、CRLF |
| 10 | **新增 P0：信号报告修复** | Git Bash 把信号折进退出码（`3840`/`2304`/`512`），`signal` 恒为 `null` → DSH 会渲染出 `[exit code: 3840]`。必须在 `onProcessDone` 里改写 |

---

## 1. 范围

### 1.1 做
- 一个 **Host-only bundle**：`@local/dsh-shell-getaway`，安装进 desktop profile。
- 一个 `ctx.shell` 执行器：`pwsh` / `gitbash` / `wsl` / `cygwin` 四分支派发（WSL 与 Git Bash 为一等公民）。
- 复用官方 `@deepseek-ai/dsh-tool-bash` 作为模型可见的 `bash` tool。
- 通过覆盖 `preset-standard` 声明来停用 `tool-pwsh`。
- 两个 prompt section：找回 Windows 强杀语义 + POSIX/方言教学。
- `ctx.shellEnv.register()` 注入 POSIX 化变量 + `WSLENV` 白名单。
- 沙箱 fail-closed 门禁。
- 单元 + 集成测试。

### 1.2 不做（本轮）
- 持久 shell（`dsh-terminal-bash` / `dsh-tool-bash-persistent`）→ 阶段 3。
- 自定义 tool（自己写 `defineTool` 定义）→ 仅在复用 `dsh-tool-bash` 失败时回退。
- 自带 Web 设置页 → 见 §9 决策点 D。
- 向上游提交 PR。

---

## 2. 交付物与文件布局

全部在**工作区**内创作（官方规定：不要手写 profile 的 `package.json` / `cordis.patch.yml`，不要跑 pnpm）：

```
F:\TidyProjects\dsh-powershell-getaway\
└── bundle\
    ├── package.json          # bundle manifest
    ├── cordis.patch.yml      # loader patch
    ├── locale\
    │   ├── en.json           # 显示标题/描述
    │   └── zh.json
    ├── icon.svg
    ├── index.js              # 插件入口：export { name, inject, Config, apply }
    └── lib\
        ├── executor.js       # GetawayExecutor extends PwshLocalExecutor
        ├── detect.js         # 四个 shell 的探测 + 身份校验
        ├── paths.js          # 路径归一化 / POSIX 转换
        ├── wsl.js            # wsl.exe 调用、发行版枚举、WSLENV、WSL_UTF8
        ├── sandbox.js        # fail-closed 门禁 + 错误文案
        ├── signals.js        # MSYS 信号状态码 → NodeJS.Signals
        ├── prompt.js         # 两个 prompt section 的文本
        └── test\
            ├── detect.test.js
            ├── paths.test.js
            ├── signals.test.js
            └── argv.test.js
```

`package.json`：

```json
{
  "name": "@local/dsh-shell-getaway",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "meta": {
    "title": "Shell Getaway",
    "description": "Run bash (Git Bash or WSL2) instead of PowerShell on Windows."
  },
  "icon": "./icon.svg",
  "files": ["index.js", "lib", "locale", "icon.svg", "cordis.patch.yml"]
}
```

- ⚠️ 不加 `dependencies`：官方规定"**Packages shipped with dsh resolve from the dsh installation,
  so the bundle declares no dependencies on them**"。
- ⚠️ 无 build script、无 install script（Host-only bundle 不需要）。
- ⚠️ **不存在 `dsh.plugin` 字段**，不要加。

`cordis.patch.yml`（**三块，缺一不可**）：

```yaml
# ── 1. 停用 host 平面的 pwsh 执行器（否则两个 ctx.shell 提供者会冲突/抢占） ──
- id: pwsh-sandbox
  disabled: true

# ── 2. 插入我们的执行器（host 平面：所有 preset 的 tool 都要读它） ──
- insert:
    - id: shell-getaway
      name: '@local/dsh-shell-getaway'
      config:
        shell: auto
        msysPathConv: off

# ── 3. 覆盖 preset-standard 声明：把 tool-pwsh 停掉 ──
#     ⚠️ patch 是【整体替换 config、绝不深合并】：必须逐字复述 shipped 列表的每一行。
#     shipped 原文：.research/dsh-src/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # ---- 以下逐条抄自 shipped 文件，仅 tool-pwsh 一处改为 disabled ----
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          suffix: Your working directory is {{cwd}}.
          prefix: You are a coding agent powered by the {{model}} model.
      # ... (中间每一条都照抄) ...
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
      - id: tool-pwsh
        name: '@deepseek-ai/dsh-tool-pwsh'
        disabled: true                      # ← 唯一的改动
      # ... (其余全部照抄，直到 tool-plugin-manager) ...
```

> **实现时的硬性要求**：用脚本从 shipped 文件**生成**这段 YAML，不要手抄，
> 并在测试里断言"生成的 `plugins` 数组长度与 shipped 相同、且逐条 diff 只有 `tool-pwsh` 一处不同"。

---

## 3. Config schema

```js
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  // ── shell 选择 ──
  shell: z.union(['auto', 'pwsh', 'gitbash', 'wsl', 'cygwin']).default('auto')
    .description('Which shell to run. auto = gitbash, then wsl, then pwsh.'),

  // ── 可执行文件（留空 = 自动探测；探测结果绝不回退到裸名） ──
  gitBashPath: z.string().description('Absolute path to Git Bash (usr\\bin\\bash.exe).'),
  wslExePath:  z.string().description('Absolute path to wsl.exe. Default: C:\\Program Files\\WSL\\wsl.exe.'),
  wslDistro:   z.string().description('WSL distribution name. Empty = the default distribution.'),
  cygwinBashPath: z.string().description('Absolute path to Cygwin bash.exe.'),
  pwshPath:    z.string().description('Absolute path to pwsh.exe (used by the pwsh branch).'),

  // ── MSYS 参数改写（见调研 §6.3b） ──
  msysPathConv: z.union(['off', 'default', 'exclude']).default('off')
    .description('MSYS rewrites "/"-leading arguments for native programs. off = MSYS_NO_PATHCONV=1 (recommended, zero measured side effects). default = leave MSYS behaviour. exclude = MSYS2_ARG_CONV_EXCL=*.'),
  msysArgConvExcl: z.string().description('Extra MSYS2_ARG_CONV_EXCL substrings (semicolon separated) when msysPathConv=exclude.'),

  // ── 沙箱门禁（见 §5） ──
  allowConfined: z.boolean().default(false)
    .description('Allow bash under a confined sandbox mode. Never applies to WSL, which cannot be confined on Windows.'),

  // ── 与 PwshLocalExecutor 对齐的执行预算（.volatile() 才能在 Web 表单编辑） ──
  cwd: z.string().volatile(),
  timeoutMs: z.number().default(120000).volatile(),
  maxTimeoutMs: z.number().default(600000).volatile(),
  maxOutputBytes: z.number().default(64000).volatile(),
  maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
  graceMs: z.number().default(3000).volatile(),

  // ── 行为开关 ──
  normalizeCrlfForWsl: z.boolean().default(true)
    .description('Strip CR from the script on the WSL branch (WSL bash does not strip it; Git Bash does).'),
  useStdinForLongCommands: z.boolean().default(true)
    .description('Route scripts longer than ~30000 characters through `bash -s` + stdin.'),
});
```

**校验规则**（在 `apply` 里，激活期就把配置错误暴露出来）：
- `graceMs <= 2147483647`（`MAX_TIMER_DELAY_MS`），所有数值字段 > 0 且有限（照抄 `assertServiceablePwshConfig`）。
- `shell` 是具体值（非 `auto`）时，对应可执行文件**必须**探测成功，否则激活期抛错。
- `shell: 'wsl'` 时若 `wslDistro` 为空且**存在多个发行版**，激活期抛错（要求显式指定，避免落到 `docker-desktop`）。
- `shell: 'pwsh'` 时本插件退化为纯 pwsh 透传（`allowConfined` 无意义，不报错）。

---

## 4. 执行器设计

```js
class GetawayExecutor extends PwshLocalExecutor {
  // 继承：spill 布局、deadline/graceMs、executeArgv 的 provider-failure 归类、onProcessDone 钩子
}
```

### 4.1 `resolve(request)` —— 归一化

```js
resolve(request) {
  assertServiceableConfig(this.config);              // 照抄基类的断言，换名字
  const spec = super.resolve(request);               // 数值钳制 + timeout 默认/cap
  return { ...spec, workdir: normalizeWorkdir(spec.workdir) };
}
```

`normalizeWorkdir(input)`：
- 输入可为 `/f/TidyProjects/x`、`/mnt/f/TidyProjects/x`、`F:\x`、`F:/x`、相对路径。
- 先做形态识别 → 统一成**绝对 Windows 路径**（`path.win32.resolve`）。
- **不传 POSIX 形态给 `spawnSpec.cwd`** —— 实测 POSIX cwd 会让 spawn 报 `ENOENT`
  且错误信息把锅甩给可执行文件（调研 §6.4）。
- 相对路径按 session workspace（`resolve` 收到的已是 tool 层解析过的绝对路径）解析。
- ⚠️ 不要复制 `dsh-tool-bash` 的裸 `${sep}` 拼接（那是上游 bug）。

### 4.2 `argv(spec)` / `executeArgv` —— 派发

`argv()` 是同步的，但**沙箱判定与 WSL 发行版解析需要 I/O** →
用 `executeArgv(spec, async (signal) => argv, onStarted)` 这个**接受 prepare 函数**的重载
（`dsh-pwsh-local/lib/index.js:280-302` 明确支持，且自带取消语义）。

```js
async execute(spec) {
  return this.executeArgv(spec, async (signal) => {
    await this.assertSandboxAllowed(spec);           // §5：fail closed，抛错即拒绝
    const shell = await this.resolveShell(signal);    // 探测/缓存，失败即抛错
    return this.buildArgv(spec, shell);
  }, (proc) => this.attachShellFact(proc, shell));
}
```

`buildArgv(spec, shell)` —— 四个分支：

| shell | argv | 备注 |
|---|---|---|
| `pwsh` | `super.argv(spec)` | 完全交回基类（含 `ENCODING_PREAMBLE`） |
| `gitbash` | `[exe, '--noprofile', '--norc', '-c', script]` | 见 §4.3 为何不用 `-lc` |
| `cygwin` | `[exe, '--noprofile', '--norc', '-c', script]` | 路径风格 `/cygdrive/c` |
| `wsl` | `[wslExe, ...(distro ? ['-d', distro] : []), '-e', 'bash', '-c', script]` | **不带 `--cd`**（cwd 自动翻译） |

**长命令保护**：`script.length > 30000` 时改走 `[exe, '-s']` + `spec.stdin = script`。
⚠️ 此路径下 `spec.stdin` 被脚本占用，**不能再给脚本喂 stdin 数据**（明确取舍，写进 README）。
⚠️ WSL 分支的 `-s` 形式为 `[wslExe, ..., '-e', 'bash', '-s']`。

### 4.3 脚本预处理（每个分支不同）

```
gitbash : script 原样（Git Bash 自己会剥 \r）
cygwin  : script 原样
wsl     : normalizeCrlfForWsl ? script.replace(/\r\n/g, '\n') : script
          ⚠️ 实测 WSL 不剥 \r，`$1` 会带上 \r（调研 §6.9）
pwsh    : super.argv 已处理
BOM     : 三个 bash 分支都先剥掉开头的 U+FEFF（若有）
```

### 4.4 `spawnSpec` —— 环境注入

覆写以合并我们的 `ENV_OVERRIDES`（**不修改**基类行为，只扩展）：

```js
const ENV_OVERRIDES = {
  // 从 dsh-bash-local 原样 import（已导出）
  ...BashLocalEnvOverrides,        // NO_COLOR=1, TERM=dumb, PAGER=cat, GIT_PAGER=cat
  LANG: 'C.UTF-8',                 // 实测 --noprofile 下 LANG 是 unset
  LC_ALL: 'C.UTF-8',               // 实测影响 wc -m 等字符计数
};
// Git Bash / Cygwin 分支追加：
if (kind === 'gitbash' || kind === 'cygwin') {
  if (config.msysPathConv === 'off')     env.MSYS_NO_PATHCONV = '1';
  if (config.msysPathConv === 'exclude') env.MSYS2_ARG_CONV_EXCL = '*';
  if (config.msysArgConvExcl)            env.MSYS2_ARG_CONV_EXCL = config.msysArgConvExcl;
}
// WSL 分支追加：
if (kind === 'wsl') {
  env.WSL_UTF8 = '1';              // 让 wsl.exe 的全部输出变 UTF-8（省掉 UTF-16 解码器）
  env.WSLENV   = buildWslenvKeys(spec.dshEnv, POSIX_VARS);
}
```

`buildWslenvKeys(dshEnv, posixVars)`：把 `Object.keys(dshEnv)` 与我们的 POSIX 变量名
用 `:` 连接。⚠️ 实测不加 `WSLENV` 时 Windows env **一个都不过界**。

### 4.5 `onProcessDone` —— MSYS 信号修复（P0）

```js
onProcessDone(proc, stderr, providerRejected, providerError) {
  if (providerRejected) return;
  const code = proc.exitCode;
  if (code === null || code <= 255) return;
  const signo = code >> 8;                    // 3840>>8=15 SIGTERM；2304>>8=9 SIGKILL
  const name = signalsByNumber(signo);        // 1..64
  if (name !== undefined) { proc.signal = name; proc.exitCode = null; }
}
```
- 时机正确：基类在 `proc.done` 里先 stamp 再调钩子（`dsh-pwsh-local/lib/index.js:351-356`）。
- ⚠️ **公式是 `>> 8`，不是 `(>>8)-128`**（子代理给错了一版，实测 3840>>8=15 ✅）。
- ⚠️ WSL 分支不加这个映射？→ 也要加：`wsl.exe` 返回 `4294967295`（int32 −1）时
  应归一化为 `−1` 或按基础设施失败处理，不能把 4294967295 当退出码喂给渲染层。

### 4.6 探测（detect.js）

**共享的可执行文件校验**（每一个候选都要过）：

```
1. path.isAbsolute(candidate) && existsSync(candidate) && !isDirectory
2. 用 `-c 'printf "%s" …'` 或 `--version` 读版本串
3. 身份断言（关键！）：
     gitbash → 版本串含 `x86_64-pc-msys`
     cygwin  → 版本串含 `x86_64-pc-cygwin`
     wsl     → 用 `--version` 而非 bash
   ⚠️ 实测 System32\bash.exe 与 WindowsApps\bash.exe 都能报出
      `5.3.9(1)-release (x86_64-pc-linux-gnu)` —— 那是 WSL 转发，
      "能跑"不等于"是我们想要的"。仅凭可执行性判断会误判。
4. 显式黑名单（永不采用）：
     C:\Windows\System32\bash.exe
     *\AppData\Local\Microsoft\WindowsApps\bash.exe   （实测 0 字节、reparse point、
                                                        目标指向【另一个用户】C:\Users\杨绍璞\）
```

**Git Bash 探测顺序**（命中即校验，校验失败继续下一个）：
```
config.gitBashPath
%ProgramFiles%\Git\usr\bin\bash.exe            ← 首选（无二次 spawn）
%ProgramFiles%\Git\bin\bash.exe                ← 次选（会多 spawn 一层 usr\bin\bash.exe）
%LOCALAPPDATA%\Programs\Git\usr\bin\bash.exe
%ProgramFiles(x86)%\Git\usr\bin\bash.exe
注册表 HKLM\SOFTWARE\GitForWindows\InstallPath + \usr\bin\bash.exe
`where git` → 取 dirname(dirname(git.exe)) + \usr\bin\bash.exe
→ 全部失败：不采用裸名 `bash`，报错
```
> ⚠️ 实测 `bin\bash.exe` 的进程树是 `node → bin\bash.exe → usr\bin\bash.exe → 目标`，
> 多一层；且它强制 `MSYSTEM=MINGW64`。`usr\bin\bash.exe` 无二次 spawn，故选它。

**WSL 探测**：
```
config.wslExePath ?? C:\Program Files\WSL\wsl.exe     ← 绝对路径优先
  （实测 `where wsl` 有 3 个候选：WindowsApps / System32 / Program Files\WSL）
校验：`wsl.exe --version` 可解析（WSL_UTF8=1）
发行版：`wsl.exe -l -q` + WSL_UTF8=1 → 按行分割、去空
  · wslDistro 显式指定 → 用它（并校验存在于列表）
  · 否则若列表长度 == 1 → 用它
  · 否则 → 【报错】，列出候选，要求显式配置
     ⚠️ 实测本机默认是 Ubuntu，但别人机器可能默认 docker-desktop
```

**pwsh 探测**：直接复用 `resolvePwshPath`（`dsh-pwsh-local` 已导出）。

### 4.7 `auto` 决策与"绝不静默"

```
auto ⇒ 依次尝试 gitbash → wsl → pwsh
       第一个成功的成为本会话的 shell
       ⚠️ 选择结果必须【出现在第一条命令的结果里】
          （形如 `[shell: gitbash (/c/Program Files/Git/usr/bin/bash.exe)]`）
       三者全失败 ⇒ 抛错，错误信息列出每个候选与失败原因 + 安装指引
```
- 明确**不做**：静默落到某个非预期 shell。
- ⚠️ 与决策二的一致性：`auto` **不**在受限模式下降级到 pwsh，而是**报错**（见 §5，决策点 B）。

### 4.8 tool 定义的复用

`apply()` 内 `ctx.plugin(ToolBash, {})` 挂官方 `@deepseek-ai/dsh-tool-bash`。
- 它自带：`bash` tool 名、正确的 bash 描述、`tool:bash` prompt section（order 1000）、
  参数 schema、job 注册、渲染、`presentCall` 卡片。
- ⚠️ 它的 `inject` 是 `['tools','shell','systemPrompt','shellEnv']`；
  需确认挂载时序：**先**注册我们的 `ctx.shell`，**再**挂 tool（§11 P0）。
- 回退方案：若复用导致不可控问题，改为自己 `defineTool` 逐字复制它的定义
  （`output.render` 是**必需**字段，不能省）。

---

## 5. 沙箱门禁（决策二落地）

单一函数，在每次执行的 prepare 阶段调用：

```js
async assertSandboxAllowed(spec) {
  const mode = spec.sandboxPolicy?.mode ?? this.deploymentDefaultMode;   // 见下
  const kind = this.resolvedKind;

  if (mode === undefined || mode === 'danger-full-access') return;       // 放行

  if (mode !== 'workspace-write' && mode !== 'read-only') throw new SandboxUnavailableError(...);  // 未知模式 → 报错

  if (kind === 'wsl') {
    throw new SandboxUnavailableError(
      `bash (WSL2) cannot run under sandbox mode "${mode}". ` +
      `The Windows ACL restricted token does not cross the Hyper-V boundary, so the Linux ` +
      `process would be completely unconfined while appearing sandboxed. ` +
      `WSL is never allowed in a confined mode, and there is no configuration override.`
    );
  }
  if (kind === 'gitbash' || kind === 'cygwin') {
    if (this.config.allowConfined.get()) return;                          // 显式逃生舱
    throw new SandboxUnavailableError(SANDBOX_DENIED_TEXT(mode, kind));
  }
  return;   // pwsh 分支放行（走它自己的 ACL 路径）
}
```

**错误文案必须可执行**（给模型"下一步"而不是"失败"）：

```
Error: bash (Git Bash) cannot run under sandbox mode "workspace-write".

Reason: the Windows ACL restricted token blocks the named pipes MSYS2 needs for
process creation, so a command may start and then silently lose its children —
you would read empty output and a normal exit code from a command that never ran.

To proceed, do one of:
  1. Ask the user to switch this session's file policy to danger-full-access, then
     re-run the exact command.
  2. Set this plugin's "shell" config to "pwsh" for the profile; the pwsh branch is
     sandbox-compatible, but you must then write PowerShell.
  3. If Git Bash has been verified to work in this mode on this machine, set
     "allowConfined: true" in the shell-getaway config. (Not available for WSL.)
```

**附加硬性要求**：
- `get sandboxMode()` **必须保持 `undefined`** → tool 层不广告 `sandbox_permissions`。
- 但 execute 里**仍要显式拒绝**该字段（"未广告的 key 仍会到达 execute"，
  `dsh-tool-pwsh/lib/index.js:320-331` 明确说明）。
- **部署默认模式的取法**：`spec.sandboxPolicy` 由 tool 层每次调用传入；
  直连 `ctx.shell.execute()` 可能不带。此时从 `ctx.get('sandboxPolicy')` 的
  `resolve({})` 取部署默认（与 `dsh-tool-pwsh` 的 `resolveSandboxPolicy` 同构）。
  ⚠️ 若两处都拿不到模式，**报错**而不是放行。

---

## 6. prompt section

用 `ctx.systemPrompt.section()` 注册两段（**不监听 `system-prompt/assemble`**，官方明确禁止那样增删文本）。

### 6.1 `shell:getaway:exit`（找回被丢掉的 Windows 事实）

```
order: 1001
```

**为什么是 1001 —— 已核实的空档**（`dsh-system-prompt/lib/index.js:10-43`）：

```
FILE_REFERENCE 900 | TOOL_BASH 1000 | TOOL_PWSH 1010 | TOOL_READ 1100 | …
```

`1000` 与 `1010` 之间有 **1001–1009 九个空档**，所以 `1001` 是干净的插入点：
它让我们的 section 紧跟在官方 `tool:bash`（1000）之后、仍早于 `tool:pwsh`（1010，届时已被停用）。
⚠️ 仍需实测确认 `section()` 接受裸数字 order（而不是必须走 `getSectionOrder()`）—— 这是 P0-3。

内容：

```
On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a
bare exit 1 after an interruption as a termination, not a command failure.
```

> **为什么必须有**：这句原本只在 `tool:pwsh` 的 section 里（order 1010）；
> 换成 `tool:bash`（order 1000）后**会静默消失**，模型会把"被中断"误判成"命令失败"。

### 6.2 `shell:getaway:dialect`（方言与路径教学）

内容要点（英文，与官方 tool 描述同语言）：

1. **变量**：`$VAR` / `${VAR}`，**不是** `$env:VAR`。DSH 元数据形如 `${DSH_HOME}`。
   我们注入的 POSIX 化变量带约定后缀（见 §7）。
2. **路径——两套，都要说清**：
   - 命令体内部用 **POSIX 形态**：Git Bash 是 `/c/Users/...`；WSL 是 `/mnt/c/Users/...`。
   - **优选正斜杠**（`F:/TidyProjects/x`），因为 `git -C`、`cd`、重定向目标等
     多数工具不接受 `\` 作为分隔符。
   - 含反斜杠的路径**要用单引号**：未加引号时 `\U` 会被 bash 当转义
     （`echo C:\Users\x` → `C:Usersx`）。这是 bash 常识，不是 Windows 特有问题。
   - `workdir` 参数**用 Windows 形态**（`F:\x` 或 `F:/x`）—— 与命令体内部**刻意不一致**。
   - Git Bash 可用 `cygpath -u 'C:\x'`；WSL 可用 `wslpath -u 'C:\x'`。
3. **不要写 `docker run -v /data:/x`** —— 原生 Windows 程序需要 Windows 形态路径
   （`-v C:/data:/x`）。我们已关闭 MSYS 参数转换，所以**不会**替你转换。
4. **后台任务**：用 tool 的 `run_in_background` 参数，不要用 shell 的 `&`
   （`cmd &` 会因为子进程持有 stdout 管道而**阻塞到命令结束**）。
5. **如何判断当前是哪个 shell**：读 `${DSH_SHELL_KIND}`（`gitbash` / `wsl` / `pwsh` / `cygwin`），
   以及 `${DSH_SHELL_PATH}`。

> ⚠️ **不动态改写这段文本**。它一次性客观描述两种约定，由模型读 `DSH_SHELL_KIND` 自判。
> 原因是 KV cache 前缀稳定性（官方 `practices.md` 也要求 prompt 只能通过 `section()` 添加）。

---

## 7. 环境变量（`ctx.shellEnv.register`）

```js
ctx.shellEnv.register({
  name: 'shell-getaway',
  variables: {
    DSH_SHELL_KIND:     { description: 'The shell dialect in use: gitbash | wsl | pwsh | cygwin.' },
    DSH_SHELL_PATH:     { description: 'Absolute Windows path of the shell executable.' },
    DSH_WORKSPACE_POSIX:{ description: 'The session workspace in POSIX form for the active shell.' },
    DSH_HOME_POSIX:     { description: 'DSH_HOME in POSIX form for the active shell.' },
  },
  resolve: (execution) => ({ /* 由当前解析出的 shell 计算 */ }),
});
```

- ⚠️ 保留键不可占用：`DSH_HOME` / `DSH_SHELL` / `DSH_SESSION_ID` / `DSH_PROFILE` / `DSH_PROFILE_DIR`。
- ⚠️ key 必须匹配 `DSH_[A-Z][A-Z0-9_]*`。
- ⚠️ **`DSH_SHELL=1` 是中性哨兵，不是方言描述符** —— 所以需要我们的 `DSH_SHELL_KIND`。
- ⚠️ 探测器必须遵守 `resolve()` 是**按执行调用**的：若某次执行的 shell 尚未解析，
  返回一次性探测值（缓存），不要抛错。
- ⚠️ 这些变量必须同时进 `WSLENV`（§4.4），否则 WSL 分支下模型读不到。

---

## 8. 实施步骤

### 阶段 0 — 地基验证（**先做，任何代码之前**，约 1 小时）
在**一次性探针插件**里验证四个 P0 未决项，全部成功才继续：

1. 覆盖 `preset-standard` 声明后，`Tool.listTools` 里 **`pwsh` 消失、`bash` 出现**。
2. `ctx.plugin(ToolBash, {})` 在 executor 之后挂载，tool 能正常注册（inject 时序）。
3. `ctx.systemPrompt.section()` 的 order 取值不与 `tool:bash`(1000)/`tool:pwsh`(1010) 冲突。
4. 自建 executor 的 `argv()`/`executeArgv()` 真的被调用，且
   **DSH 的 `dsh-subprocess-local` Windows Job runner 路径下 argv 仍然完整**
   （我此前只用原生 `spawn` 验过，Job runner 是另一条路）。

> 若第 1 项失败 → 整个方案的地基不成立，改为"自带 tool + `ctx.tools.guard()` 拒绝 pwsh"
> （但那样 pwsh 仍在 schema 里，需重新评估）。

### 阶段 1 — MVP（Git Bash + pwsh 两分支）
1. bundle 骨架 + `cordis.patch.yml`（用脚本生成 preset 段）。
2. `detect.js`：Git Bash 探测 + 身份校验 + 黑名单；`pwsh` 复用官方。
3. `executor.js`：`resolve` / `executeArgv` / `argv` / `spawnSpec` / `onProcessDone`。
4. `sandbox.js`：fail-closed 门禁 + 错误文案。
5. `prompt.js`：两个 section。
6. 挂官方 `dsh-tool-bash`。
7. `ENV_OVERRIDES`（含 `MSYS_NO_PATHCONV=1`、`LANG`、`LC_ALL`）。
8. `ctx.shellEnv.register()`。

**验收**：新会话里 `pwsh` 不可见；3 个真实任务全过（多行脚本 + 中文输出 + `git` 操作）；
`[exit code: N]` / `[killed by signal: …]` 渲染正确；后台 job 可用。

### 阶段 2 — WSL2 一等公民 + 稳健化
1. `wsl.js`：`wsl.exe` 探测、`WSL_UTF8=1`、发行版枚举与选择、`WSLENV` 构造。
2. WSL 分支 argv + CRLF 归一化 + `4294967295` 归一化。
3. `auto` 探测链 + "选中者可见" + 全失败时的安装指引错误。
4. 长命令走 `bash -s` + stdin。
5. Cygwin 分支（`/cygdrive` 路径风格）。
6. 单元测试 + 集成测试（§10）。
7. README（含**失去提权审批通道**的说明、`bash -s` 与 stdin 的取舍）。

### 阶段 3 — 可选
- 持久 shell：`dsh-tool-bash-persistent` + `dsh-terminal-bash`
  （`shellDialect: bash` + `shellPath` 指 Git Bash；**WSL 需 `--` 分隔符**）。
- 自带 Web 设置页（见 §9 决策点 D）。
- 向上游提 issue：给 `dsh-bash-local` 加 `bashPath`、把 `argv()` seam 提到共同基类。

---

## 9. 子决策 —— **已全部拍板（2026-01）**

| ID | 决策点 | **决定** | 依据 |
|---|---|---|---|
| **A** | bash 调用形态 | ✅ **`--noprofile --norc -c`** | `-lc` 慢 1.22 s **且**会往 stdout 注入 ANSI clear 序列（`1b5b481b5b324a1b5b334a`，来自 `/etc/bash.bash_logout` 的 `/usr/bin/clear`）。我们自注入 `LANG`/`PATH`，不依赖 profile |
| **B** | 受限模式下 `auto` | ✅ **报错**（不静默降级 pwsh） | 与决策二同一原则；隐式降级边界模糊 |
| **C** | 用哪个 bash.exe | ✅ **`usr\bin\bash.exe`** | `bin\bash.exe` 会多 spawn 一层 `usr\bin\bash.exe`（node → bin → usrbin → 目标），kill 更复杂。代价：`MSYSTEM` 为空、`git` 解析到 `/cmd/git`（Windows shim，行为正常） |
| **D** | Web 设置页 | ✅ **MVP 不自带** | 干净、不抢 `bash-sandbox` id。Config 字段用 `.volatile()` 后可经 `<packageDir>` 编辑 |
| **E** | 包名 / tool 名 | ✅ 见下 | — |
| **F** | `msysPathConv` 默认值 | ✅ **`off`（`MSYS_NO_PATHCONV=1`）** | 实测 12 个日常命令零差异，却消除静默路径扭曲（含 `cmd.exe /c` 被破坏）。本轮最有价值的单个修正 |

### 9.1 E-1 tool 名 = `bash`（无选择余地，且是正确选择）

复用官方 `@deepseek-ai/dsh-tool-bash` 时，tool 名是 `defineTool` 里**硬编码的字符串**
（`dsh-tool-bash/lib/index.js:488`），没有配置项可改。改名只能自己写 `defineTool`
（多维护 ~700 行需跟上游同步的代码）。

**而且 `bash` 是正确的名字**：
1. DSH 架构本来就是"一个组合挂一个 shell"，模型不该按"我是 Git Bash / 我是 WSL"分支决策 ——
   具体路径风格应读 `${DSH_SHELL_KIND}`，而不是靠 tool 名猜。
2. `bash` 描述的是**方言**（你在写 POSIX），这正是模型唯一需要知道的事。
3. 叫 `shell` 会与 DSH 的 `ctx.shell` / `shell` 设置命名空间撞概念；叫 `sh` 会被误解成 POSIX `sh`。

### 9.2 E-2 包名与内部标识（已定）

```json
{ "name": "@local/dsh-shell-getaway", "private": true, ... }
```

- 沿用官方模板的 `@local/` 约定（`@local/demo-mcp`、`@local/my-decoration`）。
  ⚠️ `@local/` **不是 npm 上的真实组织** —— 它只是"工作区里待 `install_bundle` 的本地包"这个约定。
- 官方 `install_bundle` **接受绝对本地目录**，所以包**不需要发布到 npm** 也能装。
- 将来若要发布，只改 `name` 一次即可。
- **内部 id 全部用 `shell-getaway`**：
  | 标识 | 值 |
  |---|---|
  | bundle id | `shell-getaway` |
  | loader row id（`cordis.patch.yml` 里的 `- id:`） | `shell-getaway` |
  | 包名 | `@local/dsh-shell-getaway` |
  | 目录名 | `bundle/` |
  ⚠️ **不占用** `bash-sandbox` / `pwsh-sandbox` 这两个官方 entry id。
- ⚠️ 本工作区**不是 git 仓库**（`F:\TidyProjects` 及其上级都没有 `.git`，已核实），
  所以 manifest 里**不需要** `repository` / `files` 这类发布字段。

---

## 10. 测试计划

| 层 | 用例 |
|---|---|
| 单元 · detect | 探测顺序；**身份断言**（伪造一个能跑但报 `x86_64-pc-linux-gnu` 的 bash → 必须被拒）；黑名单（`System32\bash.exe`、0 字节 alias）；注册表缺失；全失败时的错误文案 |
| 单元 · paths | `/f/x` ↔ `F:\x` ↔ `/mnt/f/x` 三向；相对路径；UNC；junction（`C:\Users\Liserver` → `C:\Users\杨绍璞`） |
| 单元 · signals | `3840→SIGTERM`、`2304→SIGKILL`、`512→SIGINT`、`35584→SIGSEGV`、`9→普通退出`、`4294967295→归一化` |
| 单元 · argv | 四分支 argv 形状；长命令切 `-s`；WSL CRLF 归一化；BOM 剥离 |
| 单元 · sandbox | 三模式 × 四 shell 的 12 格矩阵；`allowConfined` 只影响 gitbash/cygwin；WSL 恒报错；模式未知时报错 |
| 集成 | 与 `dsh-subprocess-local` 联调：多行脚本、exit code、timeout 归因、spill、后台 job 提升、kill 干净度 |
| 集成 · MSYS | **用原生 argv oracle 断言** `MSYS_NO_PATHCONV=1` 生效（`/data` 不被改写）；`cmd.exe /c` 能跑 |
| 模型面 | `Tool.listTools` 无 `pwsh`；prompt 无 `$env:`/`C:\`；Windows 强杀语义**存在** |
| 平台 | Git Bash 缺失 / 只有 Cygwin / WSL 无发行版 / WSL 多发行版且默认 docker-desktop / WSL 完全未安装 |
| 边界 | 32720 字符上下；含 `\"` 的脚本；CRLF（两分支行为**不同**）；非 ASCII；`$'...'`；`&` 后台阻塞 |
| 安全 | 反斜杠；`;`/`&&` 注入；NUL；跨用户 alias 不被选中；`preset-standard` 覆盖不漏行 |

**`preset-standard` 覆盖的回归断言（必须有）**：
```
读 shipped presets/standard.patch.yml 的 plugins 列表
读我们 cordis.patch.yml 里 preset-standard 的 plugins 列表
断言：长度相同 ∧ 逐条 id/name/config 相同 ∧ 唯一差异是 tool-pwsh.disabled === true
```

---

## 11. 写代码前必须坐实的 P0 清单

- [ ] **P0-1** 覆盖 `preset-standard` 后 `pwsh` 真的从 `Tool.listTools` 消失（阶段 0 第 1 项）
- [ ] **P0-2** `ctx.plugin(ToolBash, {})` 在 executor 之后挂载的确切写法与时序
- [ ] **P0-3** `systemPrompt.section()` 接受裸数字 order 吗？与 1000/1010 如何错开
- [ ] **P0-4** DSH 的 **Windows Job runner** 路径下 argv 与 env 的保真度
      （我此前的验证只走了原生 `spawn`，**没有**走 Job runner）
- [ ] **P0-5** `onProcessDone` 里改写 `proc.signal`/`proc.exitCode` 之后，
      渲染层确实输出 `[killed by signal: SIGTERM]`
- [ ] **P0-6** Git Bash 在受限令牌下**实测**是否真的起不来（决定 §5 文案的准确性）
- [ ] **P0-7** preset 内的 `tool-bash` 行能否看到 **host 平面**的 `ctx.shell`
      （官方说"preset plugin 提供 service 必须把 provider 与 consumer 放同一 realm"，
      但反向"preset consumer 读 host service"是否成立？）
- [ ] **P0-8** `install_bundle` 能否接受"工作区目录 + 覆盖 shipped preset"这种 patch 形态

## 12. P1 清单

- [ ] MSYS2 fork 的子进程是否留在同一 Win32 Job 区间（kill 干净度）
- [ ] `bash -s` + stdin 走 DSH 的 `spec.stdin` 通道是否真能工作
- [ ] WSL 无发行版 / WSL 未安装的确切退出码与错误形态
- [ ] `\\wsl.localhost\` 作为 cwd 的 30 s 卡顿是否会影响我们的路径归一化（应不会，但我们只传 Windows 盘符路径）
- [ ] `dsh-tmux-context` 在 WSL 下是否误触发（它假设 `ctx.shell` 是 POSIX）
- [ ] Config 被 Web 设置页运行期改写后是否需要重启

---

## 13. 附：本轮全部勘误（避免实现者踩我踩过的坑）

| # | 我先前的说法 | 实测更正 | 出处 |
|---|---|---|---|
| 1 | "反斜杠被 MSYS2 剥离" | ❌ **错**。宿主边界逐字存活；`ls 'F:\...'` 成功。失败来自 ① bash 未加引号的 `\U` 转义 ② `printf` 格式串转义 ③ 工具（`git -C`）不接受 `\` 作分隔符 | §6.3 |
| 2 | "MSYS2 反向改写 `/Flag` 只是文档提示一下" | ❌ **严重低估**。它静默改写**所有** `/` 开头参数给原生程序，`: `→`;`，`cmd.exe /c` 被破坏。**必须默认 `MSYS_NO_PATHCONV=1`** | §6.3b |
| 3 | "WSL 需要 `--cd` 做 cwd 桥接" | ❌ **不需要**。`wsl.exe` 继承进程 cwd 并自动翻译成 `/mnt/...` | §6.4 / §6.6 |
| 4 | "WSL 冷启动秒级，是把它降级的理由" | ⚠️ 只有 `--terminate`/重启后才是（3.4–5.1 s）；热启动仅 212–299 ms | §6.6 |
| 5 | "WSL 元数据 UTF-16LE，需要自写解码器" | ✅ 对，但**有更简单的办法**：`WSL_UTF8=1` 让**全部**输出变 UTF-8 | §6.6 |
| 6 | "`-lc` 只是慢" | ⚠️ 还会**往 stdout 注入 ANSI clear 序列**（`1b5b481b5b324a1b5b334a`） | §6.7b |
| 7 | "裸 `bash` 解析到 WSL 启动器就够了" | ⚠️ `System32\bash.exe` 与 `WindowsApps\bash.exe` **都能报 bash 版本号**（`x86_64-pc-linux-gnu`），能力探测会误判 → 必须断言 `msys`/`cygwin` | §6.9 |
| 8 | "`ctx.tools.restrict` 可以全局隐藏 pwsh" | ❌ **错**。`restrict()` **只能在 `agent.ctx` 上调用**，全局调用直接抛错 | §4.3 |
| 9 | "手改 profile 的 `cordis.patch.yml`" | ❌ 官方**明令禁止**。必须用 `plugin_manager install_bundle` 装工作区 bundle | §4.5 |
| 10 | "Git Bash 信号会走 `128+n`" | ❌ 实际是 `(128+n)<<8`：TERM=3840 / KILL=2304 / INT=512。**正确公式 `signo = status >> 8`** | §6.3c |
| 11 | "`env.exe` 可以当 argv oracle" | ❌ 它是 MSYS 程序。必须用 MinGW `gcc` 编一个原生 exe | §6.3b |

---

## 14. 批准后我按此顺序动手

1. **阶段 0 的四个 P0 探针**（先验证地基；失败就回来改方案，而不是写一半发现地基不成立）
2. 阶段 1 的 bundle 骨架 + Git Bash/pwsh 分支 MVP
3. 用真实任务验收，把结果贴给你
4. 阶段 2 WSL2 一等公民

**方案已冻结。请回复"开工"即开始阶段 0。**
