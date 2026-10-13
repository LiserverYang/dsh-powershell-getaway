# dsh-shell-getaway

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
  name: '@local/dsh-shell-getaway'
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

### Why signals are decoded by hand

Git Bash reports signal deaths as a raw Win32 status with `signal: null`, and the encoding is **not uniform**:

| raised by | status | encoding |
|---|---|---|
| `kill -HUP/INT/KILL/TERM/PIPE/ALRM $$` | 256 / 512 / 2304 / 3840 / 3328 / 3584 | `n << 8` |
| `kill -ILL/ABRT/FPE/SEGV $$` | 33792 / 34304 / 34816 / 35584 | `(128 + n) << 8` |

So the decode is `hi = status >> 8; signo = (hi & 0x80) ? hi - 0x80 : hi`. Without it, `kill -TERM $$` renders as `[exit code: 3840]` — a number the model cannot act on.

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

* **WSL is implemented but not yet verified on real hardware.** The dialect, `WSLENV` handling, CRLF normalisation, and the `wsl.exe` exit-code sentinel are written; the live WSL path has not been exercised.
* **The confined-sandbox refusal is conservative.** This machine runs `danger-full-access`, so the confined path could not be measured. The refusal is correct either way; only the explanation is unverified.
* The executor implements no confinement of its own.
* Toolchain PATH is derived from the bash executable's location, so a non-standard Git layout may need an explicit prefix.

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
  extract-asar.mjs           unpack app.asar when you only have the packaged app
  test-shell-util.mjs        49 unit tests
  test-executor.mjs          46 unit tests
docs/
  PLAN.md                    design and implementation plan
  RESEARCH.md                the research behind the measurements
```

Run the tests with any Node 20+:

```sh
node tools/test-shell-util.mjs   # 49 passed
node tools/test-executor.mjs     # 46 passed
```

## A note on editing these files on Windows

Use an editor, not PowerShell's `Set-Content -Encoding utf8`. On Windows PowerShell
5.1 that re-encodes the file and turns non-ASCII characters into mojibake — it
corrupted the box-drawing characters in this repository's own comments twice. The
same hazard applies to reading a file with `>` and writing it back.

## License

MIT
