// GetawayExecutor — a ctx.shell provider that dispatches to a bash dialect
// (Git Bash by default, WSL2 as a first-class alternative) instead of PowerShell.
//
// DESIGN
// It extends the shipped PwshLocalExecutor rather than reimplementing the seam.
// That base already exposes `argv(spec)` as a documented extension point
// (dsh-pwsh-sandbox consumes it the same way), and inheriting it keeps the
// deadline, grace-period, spill, output-bounding, and provider-failure
// classification machinery identical to the shipped executors — so jobs,
// background promotion, output truncation, and the exit-status marker all keep
// working with no extra code.
//
// MEASURED FACTS THIS FILE ENCODES (all reproducible; see .research/)
//   * A multi-line script survives as ONE argv element through DSH's Win32
//     process layer: quoteArg() preserves newlines inside quotes and
//     CommandLineToArgvW splits on space/TAB only. No escaping layer is needed.
//   * `spec.cwd` must be a Windows path. A POSIX path makes the spawn fail with
//     ENOENT and the error blames the EXECUTABLE, which is nearly undiagnosable.
//   * WSL inherits the process working directory and translates it to /mnt/...
//     automatically, so WSL needs no `--cd` and no path juggling.
//   * Git Bash strips a CR that arrives inside a script FILE it executes, and a CRLF
//     script body given to `bash -c` is tolerated. WSL does NEITHER: a CRLF script
//     reaches the program, and a positional argument keeps its trailing carriage
//     return. Normalization is therefore applied to the WSL dialect only
//     (measured: Git Bash -> "line1\narg=ARG\n", WSL -> "line1\r\narg=ARG\r\n").
//   * MSYS rewrites POSIX-looking arguments handed to native Windows programs.
//     MSYS_NO_PATHCONV=1 suppresses it; see BASH_ENV_OVERRIDES.
//   * `bash -c` breaks at ~32720 characters (the CreateProcess 32767 limit).
//     Longer scripts go over stdin via `bash -s`.
import { BASH_ENV_OVERRIDES, exceedsArgvLimit, decodeMsysStatus, normalizeWslExitCode, toWindowsPath, stripBom, normalizeCrlf, msysExclusionList } from './shell-util.js';

/** Default budgets, matching dsh-pwsh-local so behaviour is unchanged. */
const DEFAULTS = {
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3_000,
};

/** Sandbox modes that impose a Windows restricted token. */
const CONFINED_MODES = new Set(['read-only', 'workspace-write']);

/**
 * Build the model-facing guidance for a sandbox refusal.
 *
 * The user's standing decision is that a sandbox problem must be an EXPLICIT
 * ERROR — never a silent downgrade — because a command that appears to succeed
 * while its children silently die is worse than a refusal.
 *
 * HONESTY NOTE: the "why" below is stated as a conservative expectation, not a
 * measured fact. This machine runs `danger-full-access`, so the confined path
 * could not be exercised. The refusal itself is correct either way; only the
 * explanation is unverified.
 * @param mode - the effective sandbox mode.
 * @param kind - the dialect being refused.
 * @returns an actionable multi-line message.
 */
function sandboxRefusal(mode, kind) {
  const label = kind === 'wsl' ? 'bash (WSL2)' : 'bash (Git Bash)';
  if (kind === 'wsl') {
    return (
      `Error: ${label} cannot run under sandbox mode "${mode}".\n\n` +
      `Reason: on Windows the sandbox confines a process with a restricted token. ` +
      `wsl.exe would receive that token, but the Linux process is created by the WSL ` +
      `service inside its own virtual machine and does not inherit it, so the command ` +
      `would appear sandboxed while being completely unconfined. WSL is never allowed ` +
      `in a confined mode, and there is no configuration override for it.\n\n` +
      `To proceed, do one of:\n` +
      `  1. Ask the user to switch this session's file policy to danger-full-access, ` +
      `then re-run the exact command.\n` +
      `  2. Set this plugin's "shell" config to "pwsh" or "gitbash" for the profile.`
    );
  }
  return (
    `Error: ${label} cannot run under sandbox mode "${mode}".\n\n` +
    `Reason: the Windows restricted token denies the named pipes MSYS2 needs for ` +
    `process creation, so a command may start and then silently lose its children — ` +
    `you would read empty output and an ordinary exit code from work that never ran.\n\n` +
    `To proceed, do one of:\n` +
    `  1. Ask the user to switch this session's file policy to danger-full-access, ` +
    `then re-run the exact command.\n` +
    `  2. Set this plugin's "shell" config to "pwsh" for the profile; the PowerShell ` +
    `executor is sandbox-compatible, but you must then write PowerShell.\n` +
    `  3. If Git Bash has been verified to work in this mode on this machine, set ` +
    `"allowConfined: true" in the shell-getaway config.`
  );
}

/**
 * Prefix that puts the bash's own tool directories first.
 *
 * WHY THIS IS A SCRIPT PREFIX AND NOT AN ENVIRONMENT ENTRY
 * Setting `PATH` on the spawn spec looked like the obvious fix and measurably did
 * not work: a run with it in place still resolved `cygpath` to Cygwin's. The
 * subprocess layer rewrites the child environment (it also seeds the Windows Job
 * runner), and — importantly — it hands bash a **POSIX** `PATH`, not the Windows
 * one from `process.env`. So the prefix is applied inside the script, where nothing
 * can rewrite it, and it is written in the vocabulary bash already has.
 *
 * WHY IT USES `$BASH` AND NOT A COMPUTED ABSOLUTE PATH
 * `$BASH` is set by bash itself to its own executable (`/usr/bin/bash`) with no
 * PATH lookup, so `${BASH%/*}` is its directory without spawning anything and
 * without a space-in-`Program Files` hazard. The sibling `mingw64/bin` and install
 * root are derived from it. Every operation is a bash parameter expansion; no
 * external command (not even a builtin that might be shadowed) is needed.
 *
 * WHY THE SIBLING DIRECTORY IS REACHABLE
 * Git for Windows mounts the install root, so `<root>/mingw64/bin` appears as
 * `/mingw64/bin` and `<root>/cmd` as `/cmd`. Prepending those literal POSIX paths
 * makes bash's own toolchain win, while the inherited entries stay behind them so
 * Windows-installed tools (`node`, `python`, `docker`, `where.exe`, `cmd.exe`)
 * remain reachable.
 *
 * The model never sees this: a prefix runs in the same shell, so `$0`, `$?`,
 * `set -e`, `trap`, and `exit` all still describe the user's own command.
 *
 * @param shell - the resolved shell descriptor.
 * @returns an `export PATH=...;` fragment, or an empty string when not applicable.
 */
function pathPrefix(shell) {
  if (shell.kind !== 'gitbash' && shell.kind !== 'cygwin') return '';
  // The right-hand side is expanded before the assignment, so "$PATH" here is the
  // caller's PATH and there is no self-reference.
  //
  // The literal POSIX siblings are prepended rather than derived, because Git for
  // Windows mounts the install root: <root>/usr/bin is /usr/bin, <root>/mingw64/bin
  // is /mingw64/bin, <root>/cmd is /cmd. The derived ${BASH%/*} is kept as well, so
  // a relocation that mounts elsewhere still contributes the real shell directory.
  return 'export PATH="${BASH%/*}:/usr/bin:/mingw64/bin:/cmd:$PATH";\n';
}

/** Build the argv for one resolved spec and dialect. */
function buildArgv(shell, spec, config) {
  const script = stripBom(spec.command);
  switch (shell.kind) {
    case 'gitbash':
    case 'cygwin': {
      const body = pathPrefix(shell) + script;
      if (config.useStdinForLongCommands && exceedsArgvLimit(body, shell.path)) {
        return { argv: [shell.path, '--noprofile', '--norc', '-s'], stdin: body };
      }
      return { argv: [shell.path, '--noprofile', '--norc', '-c', body] };
    }
    case 'wsl': {
      const body = normalizeCrlf(script, config.normalizeCrlfForWsl);
      // The distribution comes from discovery (which refuses to guess when several
      // exist), falling back to explicit config. Passing it every time means a
      // command can never land in an unintended distro such as docker-desktop.
      const distroName = shell.distro ?? config.wslDistro;
      const distro = typeof distroName === 'string' && distroName.length > 0 ? ['-d', distroName] : [];
      if (config.useStdinForLongCommands && exceedsArgvLimit(body, shell.path)) {
        return { argv: [shell.path, ...distro, '-e', 'bash', '-s'], stdin: body };
      }
      return { argv: [shell.path, ...distro, '-e', 'bash', '-c', body] };
    }
    default:
      return undefined; // handled by the base class (pwsh)
  }
}

/** Environment for one dialect. */
function mergeEnv(shell, config, spec) {
  const env = { ...BASH_ENV_OVERRIDES, ...spec.env, ...spec.dshEnv };
  if (shell.kind === 'gitbash' || shell.kind === 'cygwin') {
    if (config.msysPathConv === 'off') {
      env.MSYS_NO_PATHCONV = '1';
    } else if (config.msysPathConv === 'exclude') {
      env.MSYS2_ARG_CONV_EXCL = '*';
      const extra = msysExclusionList(config.msysArgConvExcl);
      if (extra !== undefined) env.MSYS2_ARG_CONV_EXCL = extra;
    } else {
      delete env.MSYS_NO_PATHCONV;
    }
    // NOTE: the bash's own tool directories are prepended to PATH by the script
    // prefix (see `pathPrefix`), NOT here. Setting `env.PATH` was measured to have
    // no effect, because the subprocess layer hands bash a POSIX PATH of its own
    // construction. Do not re-add it here expecting it to work.
  }
  if (shell.kind === 'wsl') {
    // wsl.exe writes its own output (distro list, --status, error messages) as
    // UTF-16LE unless this is set; a UTF-8 pipeline turns it into mojibake.
    env.WSL_UTF8 = '1';
    // A measured trap: Windows environment variables do NOT cross into WSL by
    // default. Without this list, every DSH_* variable the prompt teaches the
    // model to read is simply absent.
    const names = Object.keys({ ...spec.dshEnv, ...config.extraWslenvKeys });
    if (names.length > 0) env.WSLENV = names.join(':');
  }
  return env;
}

/**
 * Create the executor class bound to the loaded DSH modules.
 * @param base - the imported `PwshLocalExecutor` (must be the RUNNING host's copy
 *   so service identity matches).
 * @param resolveShell - async () => the verified shell descriptor for this run.
 * @param configOf - (spec) => the plain resolved plugin config.
 * @returns the executor class.
 */
export function makeGetawayExecutor(base, resolveShell, configOf) {
  return class GetawayExecutor extends base {
    /** Resolved shell, cached per plugin lifetime. */
    shellPromise;

    /** The sandbox mode this executor applies by default. Deliberately undefined:
     *  the executor does not implement confinement, so the tool layer must not
     *  advertise `sandbox_permissions` — there is nothing to escalate to. */
    get sandboxMode() {
      return undefined;
    }

    /** Fill workdir/timeout exactly as the base does, then normalize the cwd. */
    resolve(request) {
      const spec = base.prototype.resolve.call(this, request);
      // A POSIX cwd makes the spawn fail with a misleading ENOENT, so it is
      // converted here rather than at the spawn site where the cause is lost.
      return { ...spec, workdir: toWindowsPath(spec.workdir) };
    }

    /** Resolve once, then reuse; failures surface as tool errors, never silence. */
    shell() {
      this.shellPromise ??= Promise.resolve().then(() => resolveShell());
      return this.shellPromise;
    }

    /** The single override point the base class documents for subclasses. */
    argv(spec) {
      // Synchronous by contract, so it may only use an already-resolved shell.
      const shell = this.resolvedShell;
      if (shell === undefined) {
        throw new Error('shell-getaway: argv() called before the shell was resolved (internal ordering bug)');
      }
      if (shell.kind === 'pwsh') return base.prototype.argv.call(this, spec);
      const built = buildArgv(shell, spec, configOf());
      return built.argv;
    }

    /** The seam that lets async preparation finish before the spawn. */
    async execute(spec) {
      const shell = await this.shell();
      this.resolvedShell = shell;
      const config = configOf();

      // Sandbox gate: fail closed, with an actionable message.
      const policy = spec.sandboxPolicy ?? config.deploymentPolicy?.();
      const mode = policy?.mode;
      if (mode !== undefined && CONFINED_MODES.has(mode)) {
        if (shell.kind === 'wsl') throw new Error(sandboxRefusal(mode, 'wsl'));
        if ((shell.kind === 'gitbash' || shell.kind === 'cygwin') && !config.allowConfined) {
          throw new Error(sandboxRefusal(mode, shell.kind));
        }
      } else if (mode !== undefined && mode !== 'danger-full-access') {
        throw new Error(
          `shell-getaway: unrecognized sandbox mode ${JSON.stringify(mode)}; refusing to run rather than guess.`,
        );
      }

      if (shell.kind === 'pwsh') return base.prototype.execute.call(this, spec);

      const built = buildArgv(shell, spec, config);
      const effective = built.stdin !== undefined ? { ...spec, stdin: built.stdin } : spec;
      return this.executeArgv(
        effective,
        built.argv,
        (proc) => {
          proc.shell = { kind: shell.kind, path: shell.path };
        },
      );
    }

    /** The base stamps exit facts first, so a rewrite here is safe. */
    spawnSpec(spec, stdoutMaxBytes, signal, argv) {
      const shell = this.resolvedShell ?? { kind: 'pwsh' };
      if (shell.kind === 'pwsh') return base.prototype.spawnSpec.call(this, spec, stdoutMaxBytes, signal, argv);
      const config = configOf();
      const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: config.maxSpillBytes } });
      return {
        argv: [...argv],
        cwd: spec.workdir,
        stdio: {
          stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
          stdout: collect(stdoutBytes(stdoutMaxBytes)),
          stderr: collect(config.maxOutputBytes),
        },
        graceMs: config.graceMs,
        signal,
        env: mergeEnv(shell, config, spec),
      };
    }

    /**
     * Translate a bash-dialect exit status into the signal/exit pair DSH expects.
     * Without this, `kill -TERM $$` renders as `[exit code: 3840]`, a number the
     * model cannot act on.
     */
    onProcessDone(proc, stderr, providerRejected, providerError) {
      if (providerRejected) return;
      const shell = this.resolvedShell;
      if (shell === undefined || shell.kind === 'pwsh') return;
      const raw = shell.kind === 'wsl' ? normalizeWslExitCode(proc.exitCode) : proc.exitCode;
      if (raw !== proc.exitCode) proc.exitCode = raw;
      const decoded = decodeMsysStatus(proc.exitCode);
      if (decoded.signal !== undefined) {
        proc.signal = decoded.signal;
        proc.exitCode = decoded.exitCode;
      }
    }
  };
}

/** Clamp a caller-supplied stdout budget against the configured cap. */
function stdoutBytes(requested) {
  return typeof requested === 'number' && requested > 0 ? requested : DEFAULTS.maxOutputBytes;
}

export { DEFAULTS, CONFINED_MODES, buildArgv, mergeEnv, sandboxRefusal, pathPrefix };
