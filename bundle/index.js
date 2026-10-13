// dsh-shell-getaway — run bash instead of PowerShell on Windows.
//
// Host plugin, in the `export function apply(ctx, config)` form with `inject` and
// `Config`.
//
// WHAT IT DOES
//   1. Mounts a `ctx.shell` executor that runs a bash dialect — Git Bash by
//      default, WSL2 as a first-class alternative.
//   2. Mounts the SHIPPED `@deepseek-ai/dsh-tool-bash` when a bash dialect won, so
//      the model gets a `bash` tool whose description, schema, job wiring, and
//      rendering are the official ones. Reusing it instead of forking it is why
//      this plugin is small: `dsh-tool-pwsh` and `dsh-tool-bash` are line-for-line
//      twins differing only in the tool name, the description, and the prompt text.
//   3. Restores the one prompt fact the swap would otherwise lose, and adds the
//      dialect guidance the model needs.
//   4. Registers POSIX-form `DSH_*` variables.
//
// ══ THE RULE THAT MATTERS MOST: `apply` MUST NOT REJECT ══
// `@deepseek-ai/dsh-app-boot` installs a handler that turns an unhandled rejection
// or uncaught exception into `exit(1)` — in its own words, "at any point in the
// process lifetime". An earlier revision made `apply` async and let it throw on a
// shell-resolution failure; the result was not a degraded plugin but a dead
// application — the window opened to "Web RPC failed" with no host to talk to, and
// no host crash log, because the host had exited during startup.
//
// So `apply` here is SYNCHRONOUS and cannot throw. Anything that can fail is
// either resolved synchronously inside a `try`/`catch` that records a diagnostic,
// or deferred to first use, where a failure is an ordinary tool error the model can
// read. Detection is synchronous by design — `execFileSync` with a timeout —
// precisely so this can hold.
import { importShared, runtimeFacts } from './lib/resolve.js';
import { findGitBash, findCygwin, wslExeCandidates, wslVersion, wslDistros } from './lib/detect.js';
import { makeGetawayExecutor } from './lib/executor.js';
import { POSIX_GUIDANCE, WINDOWS_EXIT_FACT, SECTION_ORDER } from './lib/prompt.js';
import { Config } from './lib/config.js';

export const name = 'shell-getaway';

/** Hard dependencies: without these the plugin stays inactive instead of throwing. */
export const inject = ['tools', 'systemPrompt', 'shell', 'shellEnv'];

export { Config };

/**
 * Read one config field as a plain value.
 *
 * The loader hands `apply` the schema's validated result, and schemastery wraps
 * each field in a reactive Box: a non-volatile field arrives as a plain value while
 * a `.volatile()` one arrives as `{ get() }`. Reading `config.timeoutMs` directly
 * therefore yields an object, which is exactly how an earlier revision failed with
 * `timeoutMs must be a positive finite number, got {}`.
 *
 * @param config - the resolved config object.
 * @param key - field name.
 * @returns the underlying value, or undefined when absent.
 */
function readValue(config, key) {
  const field = config?.[key];
  if (field === undefined || field === null) return field;
  if (typeof field === 'object' && typeof field.get === 'function') return field.get();
  return field;
}

/** Project the reactive config into plain values for the executor. */
function plainConfig(config) {
  const KEYS = [
    'shell',
    'gitBashPath',
    'wslExePath',
    'wslDistro',
    'cygwinBashPath',
    'pwshPath',
    'msysPathConv',
    'msysArgConvExcl',
    'allowConfined',
    'normalizeCrlfForWsl',
    'useStdinForLongCommands',
    'cwd',
    'timeoutMs',
    'maxTimeoutMs',
    'maxOutputBytes',
    'maxSpillBytes',
    'graceMs',
  ];
  const out = {};
  for (const key of KEYS) {
    const value = readValue(config, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Reject a stored value that cannot be used, before it reaches the executor. */
function assertServiceable(config) {
  for (const key of ['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs']) {
    const value = readValue(config, key);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} must be a positive finite number, got ${JSON.stringify(value)}`);
    }
  }
  if (readValue(config, 'graceMs') > 2_147_483_647) {
    throw new Error('graceMs must be no greater than 2147483647');
  }
  const pathConv = readValue(config, 'msysPathConv');
  if (!['off', 'default', 'exclude'].includes(pathConv)) {
    throw new Error(`msysPathConv must be off, default, or exclude; got ${JSON.stringify(pathConv)}`);
  }
}

/** Never let diagnostic formatting itself throw (cordis objects are exotic). */
function safeMessage(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '<unprintable error>';
  }
}

/**
 * Resolve a bash dialect SYNCHRONOUSLY, or explain why none is usable.
 *
 * Git Bash and Cygwin are probed eagerly because detection is a bounded
 * `execFileSync`. WSL is NOT probed here beyond locating `wsl.exe`: enumerating
 * distributions can take seconds on a stopped instance, and blocking activation on
 * it would be wrong even though it could not crash.
 *
 * @param config - plain configuration.
 * @param log - diagnostic sink.
 * @returns `{ shell }` or `{ shell, reason }`; never throws.
 */
function selectShell(config, log) {
  const want = config.shell;
  const tried = [];
  const pwsh = { kind: 'pwsh', path: config.pwshPath || 'pwsh' };

  // ── explicit pwsh: no bash dialect at all ────────────────────────────────
  if (want === 'pwsh') return { shell: pwsh };

  // ── Git Bash: the default choice, and what `auto` prefers ────────────────
  if (want === 'auto' || want === 'gitbash') {
    const result = findGitBash(config.gitBashPath || undefined);
    for (const a of result.attempts) tried.push(`gitbash ${a.candidate}: ${a.ok ? 'ok' : a.reason}`);
    if (result.found !== undefined) {
      return { shell: { kind: 'gitbash', path: result.found.exe, version: result.found.version } };
    }
    if (want === 'gitbash') {
      const why =
        result.configuredFailure === undefined
          ? 'no Git Bash was found'
          : `the configured gitBashPath is unusable (${result.configuredFailure})`;
      return { shell: pwsh, reason: `${why}. Tried:\n  ${tried.join('\n  ')}` };
    }
  }

  // ── Cygwin: a distinct dialect, never a Git Bash fallback ────────────────
  if (want === 'cygwin') {
    const result = findCygwin(config.cygwinBashPath || undefined);
    for (const a of result.attempts) tried.push(`cygwin ${a.candidate}: ${a.ok ? 'ok' : a.reason}`);
    if (result.found !== undefined) {
      return { shell: { kind: 'cygwin', path: result.found.exe, version: result.found.version } };
    }
    return { shell: pwsh, reason: `shell=cygwin was requested but no Cygwin bash was found. Tried:\n  ${tried.join('\n  ')}` };
  }

  // ── WSL: validate the executable now, the distribution at first use ──────
  if (want === 'wsl') {
    const candidates = wslExeCandidates(config.wslExePath || undefined);
    const exe = candidates.find((candidate) => wslVersion(candidate) !== undefined);
    if (exe === undefined) {
      return {
        shell: pwsh,
        reason: `shell=wsl was requested but no runnable wsl.exe was found. Candidates:\n  ${candidates.slice(0, 8).join('\n  ')}`,
      };
    }
    // A configured distribution is validated against the real list when it can be
    // read cheaply, because "Ubuntu" here and "docker-desktop" on the next machine
    // is exactly the silent misdirection this plugin exists to prevent.
    if (config.wslDistro.length > 0) {
      const distros = wslDistros(exe);
      if (distros.length > 0 && !distros.includes(config.wslDistro)) {
        return {
          shell: pwsh,
          reason: `wslDistro ${JSON.stringify(config.wslDistro)} is not installed. Installed: ${distros.join(', ')}`,
        };
      }
    }
    return { shell: { kind: 'wsl', path: exe, distro: config.wslDistro } };
  }

  // ── auto with no Git Bash ────────────────────────────────────────────────
  // Keep the shipped PowerShell executor rather than hanging on a WSL probe or
  // guessing a distribution. The model keeps a working shell; the diagnostic
  // records exactly what was rejected and how to prefer WSL explicitly.
  return {
    shell: pwsh,
    reason:
      'no Git Bash found, so the shipped PowerShell executor stays active. ' +
      `Set shell: "wsl" to prefer WSL, or shell: "gitbash" to require Git Bash. Tried:\n  ${tried.join('\n  ')}`,
  };
}

/**
 * Settle a WSL descriptor whose distribution was left open. Runs on first use,
 * where raising is safe: it becomes an ordinary tool error.
 * @param shell - the resolved descriptor.
 * @param config - plain configuration.
 * @returns the descriptor with `distro` filled in.
 */
function settleWsl(shell, config) {
  if (shell.kind !== 'wsl' || (shell.distro ?? '').length > 0) return shell;
  const distros = wslDistros(shell.path);
  if (distros.length === 1) return { ...shell, distro: distros[0] };
  if (distros.length === 0) {
    throw new Error(
      `shell-getaway: WSL is selected but no distribution is installed (${shell.path}). ` +
        'Install one, or set "shell" to "gitbash" or "pwsh".',
    );
  }
  throw new Error(
    `shell-getaway: ${distros.length} WSL distributions exist (${distros.join(', ')}) and no wslDistro is ` +
      'configured, so there is no defensible default — running your commands inside docker-desktop would be a ' +
      'silent misdirection. Set "wslDistro" in the shell-getaway config.',
  );
}

/**
 * Register the environment variables the model uses to identify the dialect.
 *
 * DELIBERATELY MINIMAL. Two earlier variables were dropped after measuring them
 * against a live shell:
 *
 *   * `DSH_HOME_POSIX` came through UNSET even though the child had `DSH_HOME`,
 *     because a second contributor already owned that family of facts. Rather than
 *     fight over it, the guidance now points at `cygpath`/`wslpath`, which convert
 *     any Windows path on demand and cannot go stale.
 *   * `DSH_WORKSPACE_POSIX` was WRONG: it was computed from `process.cwd()`, which
 *     for the Host process is the PROFILE directory, not the session workspace.
 *     A shell can report its own real location with `$PWD`, which is both correct
 *     and free.
 *
 * What remains is exactly what a shell cannot tell you about itself: which dialect
 * the harness picked, and which executable it picked.
 *
 * @param ctx - plugin context.
 * @param shellRef - holder for the resolved shell descriptor.
 * @param log - diagnostic sink.
 */
function registerEnv(ctx, shellRef, log) {
  try {
    ctx.shellEnv.register({
      name: 'shell-getaway',
      variables: {
        DSH_SHELL_KIND: { description: 'Active shell dialect: gitbash | wsl | pwsh | cygwin.' },
        DSH_SHELL_PATH: { description: 'Absolute Windows path of the active shell executable.' },
      },
      resolve: () => {
        const shell = shellRef.current;
        return {
          DSH_SHELL_KIND: shell?.kind ?? 'pwsh',
          DSH_SHELL_PATH: shell?.path ?? '',
        };
      },
    });
    log('registered DSH_SHELL_KIND and DSH_SHELL_PATH');
  } catch (error) {
    // A conflicting contributor is possible; the plugin still works without them.
    log(`could not register shell environment variables: ${safeMessage(error)}`);
  }
}

/**
 * Plugin entry. Synchronous and non-throwing by contract — see the header note.
 * @param ctx - plugin context.
 * @param rawConfig - the row's config, already validated by `Config`.
 */
export function apply(ctx, rawConfig = {}) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[shell-getaway] ${message}`);
    } catch {
      /* logging must never be fatal */
    }
  };

  // A synchronous throw here is a configuration error the loader reports as a
  // labelled diagnostic. `assertServiceable` only reads numbers and strings, so it
  // cannot produce a promise, and therefore cannot become an unhandled rejection.
  //
  // `rawConfig` arrives already validated and defaulted by the loader, which runs
  // `Config` through `resolveConfig` before calling `apply`. Its volatile fields are
  // reactive Boxes, so everything downstream reads the plain projection.
  const config = plainConfig(rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {});
  assertServiceable(config);

  const facts = runtimeFacts();
  log(
    facts.located
      ? `runtime ${facts.version} via ${facts.manifestPath} (${facts.packageCount} shared packages)`
      : 'runtime manifest not found; will fall back to profile-anchored resolution',
  );

  // ── 1. choose a dialect synchronously ────────────────────────────────────
  const selection = selectShell(config, log);
  const shellRef = { current: selection.shell };
  const kind = selection.shell.kind;
  if (selection.reason !== undefined) log(`fell back to the shipped pwsh executor: ${selection.reason}`);

  // ── 2. import the shipped modules from the RUNNING installation ──────────
  // `importShared` is async, so it runs inside a self-contained async function
  // whose rejection is caught HERE. Starting it is safe precisely because the
  // rejection has a handler attached — it can never become unhandled.
  const ready = (async () => {
    const pwshLocal = await importShared('@deepseek-ai/dsh-pwsh-local');
    const toolBash = await importShared('@deepseek-ai/dsh-tool-bash');
    return { pwshLocal, toolBash };
  })();

  // ── 3. mount the executor, then the tool it powers ───────────────────────
  ready
    .then(({ pwshLocal, toolBash }) => {
      const GetawayExecutor = makeGetawayExecutor(
        pwshLocal.PwshLocalExecutor,
        async () => settleWsl(shellRef.current, config),
        () => config,
      );

      // ── WHY THESE TWO MOUNTS SHARE ONE ISOLATED SCOPE ────────────────────
      // Measured failure: mounting the executor on `ctx` and then the shipped bash
      // tool on `ctx` as well produced a `bash` tool that ran POWERSHELL. The tool
      // resolves `ctx.shell` when it activates and captures the service instance
      // into a closure, so it bound to the HOST's PowerShell executor, not ours.
      //
      // `ctx.isolate('shell', label)` returns a child context in which the `shell`
      // service resolves inside a shared scope — and passing the SAME label to more
      // than one `isolate()` call joins them into one scope. That is precisely the
      // shape needed: one scope holding our provider and the tool that consumes it.
      //
      // A second `ctx.shell` provider does not collide in any case: each executor
      // registers inside its own isolated scope (verified against the running Host),
      // which is why the host plane keeps its own `SandboxPwshExecutor` untouched.
      const realm = ctx.isolate('shell', 'shell-getaway');
      realm.plugin(GetawayExecutor, config);
      log(`mounted GetawayExecutor (dialect=${kind}, msysPathConv=${config.msysPathConv})`);

      // The shipped bash tool only makes sense when we actually run bash. On the
      // PowerShell fallback it would advertise a tool that cannot work, so the
      // shipped `pwsh` tool stays in place instead.
      if (kind === 'pwsh') {
        log('PowerShell dialect active, so the shipped pwsh tool is left in place');
        return;
      }
      // Mounted in the SAME scope, so the tool's `inject: ['shell', ...]` resolves
      // to the executor above rather than to the host plane's PowerShell one.
      realm.plugin(toolBash, {});
      log('mounted the shipped bash tool inside the shell-getaway scope');
    })
    .catch((error) => {
      // Handled, so this never reaches the fatal unhandled-rejection handler that
      // `dsh-app-boot` installs.
      log(`could not mount the shell executor: ${safeMessage(error)}`);
    });

  // ── 4. prompt sections ───────────────────────────────────────────────────
  // 1001/1002 sit in the gap between the shipped TOOL_BASH (1000) and TOOL_PWSH
  // (1010) orders. A bare numeric order is accepted; verified against the Host.
  try {
    ctx.systemPrompt.section({ name: 'shell:getaway:exit', order: SECTION_ORDER.exit, text: WINDOWS_EXIT_FACT });
    ctx.systemPrompt.section({ name: 'shell:getaway:dialect', order: SECTION_ORDER.dialect, text: POSIX_GUIDANCE });
    log(`registered prompt sections at orders ${SECTION_ORDER.exit} and ${SECTION_ORDER.dialect}`);
  } catch (error) {
    log(`could not register prompt sections: ${safeMessage(error)}`);
  }

  // ── 5. environment ───────────────────────────────────────────────────────
  registerEnv(ctx, shellRef, log);

  log(`active dialect: ${kind} (${shellRef.current.path})`);
}
