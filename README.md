# dsh-powershell-getaway

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a **bash** shell on Windows instead of PowerShell.

PowerShell 5.1/7 quoting, `$env:NAME`, `C:\` escaping, and the `-Command` long-sentence problem all disappear: the agent writes POSIX, and it works.

```
before:  pwsh  →  Get-ChildItem -Path 'C:\x' | Where-Object { $_.Length -gt 0 }
after:   bash  →  ls -l /c/x | awk '$5 > 0'
```

## What it does

* Mounts a `ctx.shell` executor that runs **Git Bash** by default, with **WSL2** as a first-class alternative.
* Mounts the shipped `dsh-tool-bash`, so the model gets the official `bash` tool — its description, schema, job wiring, and rendering are unmodified.
* Restores one Windows fact the swap would otherwise lose, and teaches the dialect (see [Prompt sections](#prompt-sections)).
* Refuses to run rather than silently degrade when the sandbox mode cannot actually confine the shell.

## Names

Three names, kept deliberately distinct:

| Name | Value | Notes |
|---|---|---|
| repository | `dsh-powershell-getaway` | tracks the workspace directory |
| npm package | `@local/dsh-powershell-getaway` | `@local/` is the DSH convention for a workspace package awaiting `install_bundle`; it is not an npm org |
| plugin / row id | `shell-getaway` | loader row id, log prefix, and `shellEnv` contributor name |

The row id stays short and stays **stable**. It is what a profile's
`- id: shell-getaway` override targets and what the bundle patch declares, so renaming it
would silently detach an existing override rather than fail — the override would simply
stop applying. The repo and package names describe the product; the id describes the
seam it occupies.

## Requirements

* DeepSeek Harness desktop `0.2.0-rc.2`
* Git for Windows (default dialect), and/or WSL2

## Install

The plugin is a Host-only bundle; the official `plugin_manager` performs the install.

```text
plugin_manager { action: install_bundle, target: "<absolute path to the bundle/ directory>" }
```

Then restart the Harness so the new module generation loads. Verify with:

```text
cordis_inspect_query { platform: host, provider: Tool, method: listTools }
```

You should see a `bash` tool and no `pwsh` tool.

> Renaming the package means an existing profile still points at the old name. Install
> with the absolute path (as above) rather than by package name and let `plugin_manager`
> rewrite the profile, or update `dsh.profile.bundles` and the `link:` dependency in the
> profile's `package.json` by hand.

### Activating it in a profile

`bundle/cordis.patch.yml` is applied as a bundle patch. It carries three things:

1. `- id: tool-pwsh / disabled: true` — stops the host-plane PowerShell tool.
2. A **generated** override of the `preset-standard` declaration, disabling `tool-pwsh` there too.
3. An `insert` for the `shell-getaway` row itself.

> **The file is generated, never hand-written.** A loader patch replaces the whole
> `config` instead of deep-merging, so a dropped row silently removes a capability
> from every agent. Regenerate and prove it:
>
> ```sh
> # Materialize the shipped preset if you only have the packaged desktop app:
> node tools/extract-asar.mjs "<app>/resources/app.asar" /tmp/asar "dsh/desktop-runtime.json"
> #   ...then pull @deepseek-ai/dsh-web-app/presets/standard.patch.yml from it.
>
> node tools/build-bundle-patch.mjs <shipped-standard.patch.yml> bundle/cordis.patch.yml
> node tools/verify-bundle-patch.mjs <shipped-standard.patch.yml> bundle/cordis.patch.yml
> # -> PASS: all 33 plugin rows preserved; only tool-pwsh disabled.
> node tools/validate-bundle-patch.mjs          # parses it and checks the shape
> ```

## Configuration

Every field is optional; an empty `config:` row is valid.

| Field | Default | Meaning |
|---|---|---|
| `shell` | `auto` | `auto` \| `pwsh` \| `gitbash` \| `wsl` \| `cygwin`. `auto` prefers Git Bash, then falls back to the shipped PowerShell executor. |
| `gitBashPath` | *discover* | Absolute path to Git Bash. Prefer `usr\bin\bash.exe`. |
| `wslExePath` | `C:\Program Files\WSL\wsl.exe` | Absolute path to `wsl.exe`. |
| `wslDistro` | *required if several* | Distribution name. Refuses to guess, because guessing could run commands inside `docker-desktop`. |
| `cygwinBashPath` | *discover* | Absolute path to Cygwin `bash.exe`. |
| `msysPathConv` | `off` | `off` sets `MSYS_NO_PATHCONV=1`; `default` leaves MSYS alone; `exclude` sets `MSYS2_ARG_CONV_EXCL=*`. |
| `msysArgConvExcl` | — | Extra exclusion substrings (`;`-separated, matched literally, not as globs). |
| `allowConfined` | `false` | Permit Git Bash under a confined sandbox mode. **Never applies to WSL.** |
| `normalizeCrlfForWsl` | `true` | Collapse CRLF in the script on the WSL dialect. |
| `useStdinForLongCommands` | `true` | Route scripts over ~30 000 characters through `bash -s` + stdin. |
| `timeoutMs` / `maxTimeoutMs` | `120000` / `600000` | Execution deadline and its cap. |
| `maxOutputBytes` / `maxSpillBytes` | `64000` / `64 MiB` | In-memory cap per stream and the spill-file cap. |
| `graceMs` | `3000` | SIGTERM → SIGKILL grace. |

Example:

```yaml
- id: shell-getaway
  name: '@local/dsh-powershell-getaway'
  config:
    shell: wsl
    wslDistro: Ubuntu
```

## Design notes

Each of these is a measured fact, not a preference. Reproductions live in the commit history and in [`docs/RESEARCH.md`](docs/RESEARCH.md).

### Why `Config` must be real schemastery

`dsh-settings`'s `SettingsForms.describe()` **introspects** the schema and calls `.volatile()` per field. A hand-written Standard Schema validates fine and then makes `settings/describe` throw — and that RPC is the desktop welcome window's *first* request, so the whole application fails to start with the unhelpful message `Web RPC failed`. The schema is therefore built from the running installation's schemastery, reached through the runtime-manifest resolver below.

### Why the executor inherits `PwshLocalExecutor`

It is the class that already exposes `argv(spec)` as a documented extension point (the shipped `dsh-pwsh-sandbox` consumes it the same way). Inheriting it keeps the deadline, grace, spill, output-bounding, and provider-failure classification machinery identical to the shipped executors, so jobs, background promotion, and output truncation keep working with no extra code.

### Why `apply` is synchronous and cannot reject

`dsh-app-boot` turns an unhandled rejection or uncaught exception into `exit(1)` — in its own words, *"at any point in the process lifetime"*. A rejecting `apply` is therefore not a degraded plugin, it is a dead application. All discovery is synchronous (`execFileSync` with bounded timeouts) so activation never awaits anything.

### Why the shell is bound to the tool through an isolated scope

The shipped bash tool captures `ctx.shell` **when it activates**, so mounting it on the root context binds it to the *host plane's* executor — producing a `bash` tool that runs PowerShell. The executor and the tool are therefore mounted through `ctx.isolate('shell', 'shell-getaway')`, one shared scope, so the tool's `inject: ['shell']` resolves to this executor.

### Why the toolchain PATH is set inside the script

With Cygwin also installed, `/c/cygwin64/bin` can precede Git's `/usr/bin`, so `cygpath` resolves to Cygwin's and answers `/cygdrive/c/...` where Git's answers `/c/...` — a silently unusable path. Setting `PATH` on the spawn spec **has no effect** (the subprocess layer constructs the child environment and hands bash a POSIX `PATH`). The fix is a prefix that runs in the same shell:

```bash
export PATH="${BASH%/*}:/usr/bin:/mingw64/bin:/cmd:$PATH";
```

`${BASH%/*}` needs no PATH lookup, and the user's own script still owns `$0`, `$?`, `set -e`, and `exit`.

### How the WSL dialect differs (all measured)

WSL is a first-class dialect, not a fallback, but it is **not** Git Bash with a
different path prefix. Four things differ, and each one was measured rather than
assumed:

* **Nothing crosses into WSL by default.** A variable set in the Windows process is
  simply absent on the Linux side, so every `DSH_*` name the prompt tells the model to
  read would silently not exist. `WSLENV` is therefore derived from the same set the
  prompt advertises.

* **A bare `WSLENV` name passes the value through unchanged — it does not imply `/p`.**
  Measured against `C:\Program Files\Git\usr\bin\bash.exe`:

  | entry | value seen inside WSL |
  |---|---|
  | `NAME` (bare) | `C:\Program Files\Git\usr\bin\bash.exe` |
  | `NAME/p` | `/mnt/c/Program Files/Git/usr/bin/bash.exe` |
  | `NAME/l` | `/mnt/c/Program Files/Git/usr/bin/bash.exe` |
  | `NAME/p/u` | **empty string** |

  So no flag is emitted. A wrong guess here does not corrupt the value visibly — the
  `/p/u` row shows it can vanish entirely.

* **Exit statuses are not shifted, unlike MSYS.** Git Bash reports `kill -TERM $$` as
  `3840`; WSL reports `15`. WSL's `15` is also what a clean `exit 15` produces, and the
  two are indistinguishable — so the plugin deliberately does **not** run its MSYS
  decoder on a WSL status (that would read 15 as "signal 15 shifted by 8", i.e. junk),
  and the prompt tells the model to read `128+N` as "killed" rather than to attempt a
  recovery that is not possible.

* **`wsl.exe` puts its own diagnostics on stdout, encoded UTF-16LE.** A distribution
  that does not exist yields status `4294967295`, an explanatory sentence on **stdout**,
  and an *empty* stderr. `WSL_UTF8=1` turns that output into plain UTF-8. This is worth
  stating because the obvious guess — read stderr — finds nothing at all.

* **`wsl.exe` also prints a line of its own to stderr on EVERY invocation, and the plugin
  cannot remove it.**

  ```
  wsl: A localhost proxy configuration was detected but not mirrored into WSL. …
  ```

  It appears whether the command succeeds or fails — measured at 10/10 invocations — and
  it is informational: WSL is in NAT mode and cannot mirror a Windows localhost proxy.
  It does sit in the model's view of every command, which is why four ways to remove it
  were tried. **All four are dead**, and this is recorded so nobody repeats them:

  | route | why it fails |
  |---|---|
  | spawn environment | no variable suppresses it. Measured against proxy variables, `WSL_IGNORE_CFG`, `WSL_DISABLE_AUTO_PROXY`, `WSLENV` |
  | wrapping `proc.observed.stderr` | `result()` reports stderr through `finalOutput(collected.stderr)`, which reads the **collector** directly — the facade is never consulted, so replacing it changes nothing |
  | an in-script `exec 2>` redirect | `wsl.exe` writes the line **before bash starts**, so a redirect as the script's first statement is already too late |
  | overriding `result()` | it is an object property built inside `executeArgv`, not a prototype method, and its closure over the collector is unreachable from a subclass |

  **To silence it, change the machine, not the plugin.** Add to
  `%USERPROFILE%\.wslconfig`:

  ```ini
  [wsl2]
  networkingMode=mirrored
  ```

  then run `wsl.exe --shutdown` from Windows. Removing the Windows proxy also stops it.
  The line cannot be filtered safely anyway: it is indistinguishable from a real
  diagnostic, so swallowing it would risk hiding a genuine `wsl:` error.

* **`WSLENV` is a control variable and is excluded from the inherited environment.**
  Measured: once a `WSLENV` exists in the Host environment — which happens as soon as
  this plugin has run once — every variable in it crosses, whatever the current call
  intended. The executor therefore never merges an inherited `WSLENV` as a *value*; it
  reads the parent's entry list explicitly, preserves those entries verbatim (the user
  may have set their own with flags we have no business rewriting), and appends only the
  names that are missing.

Because of that last point the plugin does not try to interpret a failed launch. It
validates the configured distribution against the enumerated list *before* spawning, so
the failure becomes a message naming the distributions that do exist.

### Choosing a dialect: `auto` is first-match-wins

`auto` tries **Git Bash → WSL → PowerShell**, and each step is visible in the diagnostic
when it fails. WSL is probed only as a *fallback*, so a machine with Git Bash never pays
the distribution-enumeration cost.

Three rules keep the chain from silently doing the wrong thing:

* **Docker Desktop's distributions do not count.** `docker-desktop` and
  `docker-desktop-data` register as WSL distributions but have no login user, so they are
  excluded when deciding whether a *default* exists. Without that filter this machine
  looks like it has "3 distributions", `auto` refuses to choose, and it falls back to
  PowerShell even though `Ubuntu` is the only real answer. An explicitly configured
  `wslDistro` is honoured even if it names one of them.
* **A configured path is authoritative, not a hint.** `gitBashPath`, `cygwinBashPath` and
  `wslExePath` each pin an exact executable; if the pinned one is unusable the plugin
  reports *that* and does not quietly substitute a discovered one. This was a real bug:
  `findGitBash` recorded the failure and then returned a different `bash.exe` anyway, so
  pinning a path did nothing. Pinning is how you choose one installation over another.
* **Nothing available still leaves a working shell.** The shipped PowerShell executor
  stays mounted and the diagnostic says so explicitly — that the tool is still named
  `bash` but runs PowerShell — because an invisible fallback is indistinguishable from
  the plugin not loading at all.

### Why signals are decoded by hand

Git Bash reports signal deaths as a raw Win32 status with `signal: null`, and the
encoding is **not uniform**:

| raised by | status | encoding |
|---|---|---|
| `kill -HUP/INT/KILL/TERM/PIPE/ALRM $$` | 256 / 512 / 2304 / 3840 / 3328 / 3584 | `n << 8` |
| `kill -ILL/ABRT/FPE/SEGV $$` | 33792 / 34304 / 34816 / 35584 | `(128 + n) << 8` |

So the decode is `hi = status >> 8; signo = (hi & 0x80) ? hi - 0x80 : hi`. Without it, `kill -TERM $$` renders as `[exit code: 3840]` — a number the model cannot act on. This decoder is applied to Git Bash and Cygwin only; WSL needs none, as above.

### Sandbox behaviour

The executor advertises **no** `sandboxMode`, so the tool layer does not offer `sandbox_permissions`: there is nothing to escalate to. Under a confined mode the rule is *fail closed*:

* WSL — always refused, with no configuration override. The Windows restricted token confines `wsl.exe` but the Linux process never inherits it, so the command would *appear* sandboxed while being completely unconfined.
* Git Bash / Cygwin — refused unless `allowConfined: true`, because the restricted token denies the named pipes MSYS2 needs for process creation, so a command can start and then silently lose its children.

## Prompt sections

Two sections are registered in the gap between the shipped `TOOL_BASH` (1000) and `TOOL_PWSH` (1010) orders:

* `shell:getaway:exit` (1001) restores the sentence that lives **only** in the pwsh prompt section: a force-killed process on Windows settles as `[exit code: 1]` without a signal marker. Mounting `tool-bash` instead silently drops it, and the model then reads an interrupted command as a command failure.
* `shell:getaway:dialect` (1002) teaches POSIX syntax, the two path forms, `cygpath`/`wslpath`, that native Windows programs receive arguments **unchanged**, and that `run_in_background` is preferable to a shell `&`.

The text is registered once and is not rewritten per detected shell — that would churn the request prefix and defeat KV-cache reuse.

## Environment variables

| Variable | Meaning |
|---|---|
| `DSH_SHELL_KIND` | `gitbash` \| `wsl` \| `pwsh` \| `cygwin` |
| `DSH_SHELL_PATH` | Absolute Windows path of the active shell executable |

Deliberately minimal. Two variables that seemed useful were dropped after measurement: a POSIX `DSH_HOME` was shadowed by another contributor, and a workspace variable computed from `process.cwd()` reported the **profile** directory rather than the session workspace — a shell's own `$PWD` is both correct and free.

## Known limitations

* **The WSL dialect has not yet been the live default for a full session.** It is
  verified end-to-end through the plugin's own `buildArgv`/`mergeEnv` against real
  `wsl.exe` (`tools/test-wsl-e2e.mjs`), and the decision chain is covered by
  `tools/test-select-shell.mjs`. What remains unexercised is a complete session running
  with `shell: wsl`.
* **The confined-sandbox refusal is conservative.** This machine runs
  `danger-full-access`, so the confined path could not be measured. The refusal is
  correct either way; only the explanation is unverified.
* The executor implements no confinement of its own.
* Toolchain PATH is derived from the bash executable's location, so a non-standard Git
  layout may need an explicit prefix. WSL needs no such fix: its `PATH` is native Linux
  and cannot be shadowed by a Windows installation.
* A machine whose only WSL distributions are Docker Desktop's has no usable default, and
  `auto` will fall through to PowerShell with that stated plainly.

## Repository layout

```
bundle/                      the plugin
  index.js                   entry: name, inject, Config, apply
  cordis.patch.yml           host patch + generated preset override
  lib/
    config.js                schemastery schema (see design notes)
    resolve.js               runtime-manifest module resolver
    detect.js                shell discovery with identity verification
    executor.js              the ctx.shell executor
    shell-util.js            pure helpers (signals, paths, argv)
    prompt.js                model-facing text
tools/
  build-bundle-patch.mjs     regenerate bundle/cordis.patch.yml
  verify-bundle-patch.mjs    prove it preserved every shipped preset row
  validate-bundle-patch.mjs  parse it with the host's js-yaml and check its shape
  extract-asar.mjs           unpack app.asar when you only have the packaged app
  test-shell-util.mjs        49 unit tests
  test-executor.mjs          66 unit tests
  test-select-shell.mjs      51 tests for the dialect decision itself
  test-wsl-e2e.mjs           drive real wsl.exe through the plugin's own argv/env
docs/
  PLAN.md                    design and implementation plan
  RESEARCH.md                the research behind the measurements
```

Run the tests with any Node 20+:

Two suites need no Harness, two do:

```sh
node tools/test-shell-util.mjs   # 49 passed
node tools/test-executor.mjs     # 66 passed

# These import the plugin entry, which loads the RUNNING installation's schemastery.
# That is located relative to process.execPath, so they must run under the same binary
# the Host uses. Under a plain Node the resolver falls back to a GLOBAL DSH install
# whose schemastery has no `.volatile()`, and fails with an error that has nothing to do
# with the code under test.
ELECTRON_RUN_AS_NODE=1 "<app>/DeepSeek Harness.exe" tools/test-select-shell.mjs   # 51 passed
node tools/test-wsl-e2e.mjs      # requires WSL2 with an 'Ubuntu' distribution
```

## A note on editing these files on Windows

Use an editor, not PowerShell's `Set-Content -Encoding utf8`. On Windows PowerShell
5.1 that re-encodes the file and turns non-ASCII characters into mojibake — it
corrupted the box-drawing characters in this repository's own comments twice. The
same hazard applies to reading a file with `>` and writing it back.

## License

MIT
