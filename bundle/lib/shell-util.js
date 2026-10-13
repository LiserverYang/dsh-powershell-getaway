// Pure helpers for the getaway executor. Kept free of DSH imports so they can be
// unit-tested with plain Node, outside the Host process.

/** POSIX signal numbers we can name, for MSYS exit-status decoding. */
const SIGNAL_NAMES = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
};

/**
 * Decode an MSYS2 exit status into a POSIX signal name.
 *
 * Git Bash reports signal deaths as a raw Win32 exit status, NOT as `128 + n`, and
 * Node reports `signal: null` for all of them — so DSH's shell layer would render a
 * nonsensical `[exit code: 3840]` instead of `[killed by signal: SIGTERM]`.
 *
 * MEASURED ENCODING IS NOT UNIFORM (`.research/signal-encoding.txt`):
 *
 *   kill -HUP  $$ -> 256   (1<<8)        kill -INT $$ -> 512   (2<<8)
 *   kill -KILL $$ -> 2304  (9<<8)        kill -TERM $$ -> 3840 (15<<8)
 *   kill -ILL  $$ -> 33792 ((128+4)<<8)  kill -SEGV $$ -> 35584 ((128+11)<<8)
 *   kill -ABRT $$ -> 34304 ((128+6)<<8)  kill -FPE  $$ -> 34816 ((128+8)<<8)
 *
 * So the high byte is EITHER the signal number OR `128 + number`, depending on how
 * the signal was raised. Both cases decode by masking:
 *
 *   hi = status >> 8
 *   signo = (hi & 0x80) !== 0 ? hi - 128 : hi
 *
 * An earlier research pass got this wrong twice — once as `(status >> 8) - 128`
 * (yields negatives) and once as a plain `status >> 8` (misses ILL/ABRT/FPE/SEGV).
 * The unit test beside this file pins all eleven measured values.
 *
 * `kill -QUIT $$` measured 0, which is the shell exiting cleanly on that signal;
 * it carries no signal fact, so it is left as an ordinary exit.
 *
 * @param status - a `close` event code, or null.
 * @returns `{ signal, exitCode }` with the signal removed from the exit code, or
 *   the unchanged pair when this is an ordinary exit.
 */
export function decodeMsysStatus(status) {
  if (typeof status !== 'number' || status <= 255) return { signal: undefined, exitCode: status };
  const hi = status >> 8;
  if (hi === 0) return { signal: undefined, exitCode: status };
  const signo = (hi & 0x80) !== 0 ? hi - 0x80 : hi;
  const signal = SIGNAL_NAMES[signo];
  if (signal === undefined) return { signal: undefined, exitCode: status };
  return { signal, exitCode: null };
}

/**
 * Normalize `wsl.exe`'s int32 overflow sentinel.
 *
 * Measured: a distribution that does not exist makes `wsl.exe` exit **4294967295**
 * (int32 -1), stably across runs. DSH expects an exit code or null, so a raw
 * passthrough would show the model a ten-digit number instead of the diagnostic.
 *
 * The diagnostic itself is worth knowing about, because it is not where you would
 * look: `wsl.exe` writes "There is no distribution with the supplied name." to
 * **stdout**, and encodes it as UTF-16LE unless `WSL_UTF8=1` is set (with the flag it
 * is plain UTF-8). stderr stays EMPTY. An earlier revision of this file guessed
 * stderr and built a detector on that guess; it could never have fired.
 *
 * No detector is needed as a result: `settleWsl` verifies the distribution against the
 * enumerated list before anything is spawned, and if a launch does fail the model sees
 * `wsl.exe`'s own clear message on stdout.
 *
 * @param code - the raw close code.
 * @returns -1 for the sentinel, otherwise the code unchanged.
 */
export function normalizeWslExitCode(code) {
  return code === 4294967295 || code === -1 ? -1 : code;
}

/**
 * Build `WSLENV`, the whitelist that lets Windows environment variables cross into a
 * WSL distribution.
 *
 * TWO MEASURED FACTS, both of which change the implementation:
 *
 * 1. NOTHING crosses by default. With no `WSLENV`, a variable set in the Windows
 *    process is simply absent on the Linux side. Every `DSH_*` name the prompt tells
 *    the model to read would silently not exist.
 * 2. A BARE NAME passes the value through UNCHANGED; it does not imply `/p`.
 *    Measured against `C:\Program Files\Git\usr\bin\bash.exe`:
 *
 *        bare name    -> C:\Program Files\Git\usr\bin\bash.exe
 *        /p           -> /mnt/c/Program Files/Git/usr/bin/bash.exe
 *        /l           -> /mnt/c/Program Files/Git/usr/bin/bash.exe
 *        /p/u (both)  -> ""                      <-- empty string
 *
 *    So no flag is emitted. A flag combination cannot be silently "upgraded" later
 *    without re-measuring, and `/p/u` returning an empty value means a wrong guess
 *    here loses the variable entirely rather than corrupting it visibly.
 *
 * Entries already present in an inherited `WSLENV` are preserved verbatim — the user
 * may have set their own with flags we have no business rewriting — and duplicated
 * names are skipped so our bare entry cannot override a deliberate one.
 *
 * @param inherited - the parent process's `WSLENV`, if any.
 * @param names - variable names to whitelist.
 * @returns the `WSLENV` value, or undefined when there is nothing to whitelist.
 */
export function buildWslenv(inherited, names) {
  const existing = String(inherited ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const claimed = new Set(
    existing.map((entry) => entry.split('/')[0].trim().toLowerCase()).filter((name) => name.length > 0),
  );
  const additions = [];
  for (const name of names ?? []) {
    if (typeof name !== 'string' || name.length === 0) continue;
    const key = name.split('/')[0].trim().toLowerCase();
    // `/u` in a name means "leave the value alone", which is already the default here.
    if (key.length === 0 || key === 'u' || claimed.has(key)) continue;
    claimed.add(key);
    additions.push(name);
  }
  const all = [...existing, ...additions];
  return all.length === 0 ? undefined : all.join(':');
}

/**
 * Rewrite a POSIX-style workspace path into the Windows absolute path a
 * `CreateProcess` working directory requires.
 *
 * WHY: `spec.cwd` is handed to Node/`CreateProcess`, which uses Win32 semantics.
 * Passing `/f/TidyProjects` makes the spawn fail with ENOENT — and the error text
 * blames the EXECUTABLE, not the directory, which is nearly undiagnosable.
 *
 * Accepts `F:\x`, `F:/x`, `/f/x`, `/mnt/f/x`, and `\\?\F:\x`.
 * @param input - the requested working directory.
 * @param windowsRoot - path used for a drive-less POSIX path (defaults to C:).
 * @returns an absolute Windows path, or the input unchanged when it is relative
 *   (the caller resolves relatives against the session workspace first).
 */
export function toWindowsPath(input, windowsRoot = 'C:\\') {
  if (typeof input !== 'string' || input.length === 0) return input;

  // Extended-length prefix: strip it, the subprocess layer does not need it.
  let value = input.replace(/^\\\\\?\\/, '');

  // /mnt/<drive>/... (WSL view of a Windows drive)
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(value);
  if (mnt !== null) {
    const rest = (mnt[2] ?? '').replace(/\//g, '\\');
    return `${mnt[1].toUpperCase()}:${rest.length === 0 ? '\\' : rest}`;
  }

  // /<drive>/... (Git Bash / MSYS view)
  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(value);
  if (msys !== null) {
    const rest = (msys[2] ?? '').replace(/\//g, '\\');
    return `${msys[1].toUpperCase()}:${rest.length === 0 ? '\\' : rest}`;
  }

  // A leading slash with no drive: MSYS mounts its own root. Anchor it to the
  // supplied root rather than inventing a mapping.
  if (value.startsWith('/')) {
    const rest = value.replace(/\//g, '\\');
    const base = windowsRoot.endsWith('\\') ? windowsRoot.slice(0, -1) : windowsRoot;
    return `${base}${rest}`;
  }

  // Already Windows form; normalize separators only when a drive is present.
  if (/^[a-zA-Z]:/.test(value)) return value.replace(/\//g, '\\');

  return value;
}

/**
 * Render an absolute Windows path in the POSIX form the active shell expects,
 * for the `DSH_*_POSIX` variables the model reads.
 * @param windowsPath - an absolute Windows path.
 * @param kind - the active shell dialect.
 * @returns the POSIX path, or undefined when the input is not absolute Windows.
 */
export function toPosixPath(windowsPath, kind) {
  if (typeof windowsPath !== 'string') return undefined;
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(windowsPath.replace(/^\\\\\?\\/, ''));
  if (match === null) return undefined;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  if (kind === 'cygwin') return `/cygdrive/${drive}/${rest}`;
  if (kind === 'wsl') return `/mnt/${drive}/${rest}`;
  return `/${drive}/${rest}`;
}

/**
 * Strip a UTF-8 BOM from a script.
 *
 * Scripts are handed to bash as a single `-c` argument. A leading BOM becomes
 * part of the first token and produces a bewildering "command not found" for a
 * command that visibly exists.
 * @param script - the command text.
 * @returns the text without a leading BOM.
 */
export function stripBom(script) {
  return typeof script === 'string' && script.charCodeAt(0) === 0xfeff ? script.slice(1) : script;
}

/**
 * Normalize line endings for the WSL branch.
 *
 * Measured difference: Git Bash silently strips a CR from a CRLF script, but WSL
 * does NOT — a script run under WSL sees `$1` as `ARGONE\r`, and the stray CR
 * breaks comparisons and paths. Only WSL needs this.
 * @param script - the command text.
 * @param enabled - whether to apply the rewrite.
 * @returns the text with CRLF collapsed to LF when enabled.
 */
export function normalizeCrlf(script, enabled) {
  return enabled ? String(script).replace(/\r\n/g, '\n') : script;
}

/**
 * Whether a script is too long to pass as a single `-c` argument.
 *
 * Windows caps the whole `CreateProcess` command line at 32767 UTF-16 code units.
 * Measured break point for `bash -c <script>` on this machine: 32700 works, 32720
 * fails with ENAMETOOLONG. The margin below the cap absorbs the executable path
 * and the surrounding argv.
 */
export const SCRIPT_ARGV_LIMIT = 30_000;

/**
 * @param script - the command text.
 * @param executable - the shell executable path that shares the command line.
 * @returns true when the script should go over stdin (`bash -s`) instead.
 */
export function exceedsArgvLimit(script, executable) {
  return String(script).length + String(executable).length > SCRIPT_ARGV_LIMIT;
}

/** Bundled environment overrides for every bash-dialect invocation. */
export const BASH_ENV_OVERRIDES = {
  // From dsh-bash-local's exported ENV_OVERRIDES: suppress colour, pagers, and
  // interactive-terminal features that would garble captured output.
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',

  // Measured: with --noprofile --norc, LANG is UNSET and only LC_CTYPE is set.
  // Without LANG, tools that consult the locale (Python's stdio in particular)
  // fall back to ASCII and raise UnicodeEncodeError on non-ASCII output.
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
};

/**
 * Why the MSYS argument-rewriting switch exists, kept beside the modes that select
 * it. The value is applied per dialect in the executor's `mergeEnv` — NOT baked
 * into BASH_ENV_OVERRIDES, because WSL has no MSYS layer and the `exclude` mode
 * must not contradict itself by setting both switches at once. (A unit test
 * caught exactly that leak.)
 *
 * MSYS2 rewrites any argument that looks like a POSIX path before handing it to a
 * NATIVE Windows program. Measured default behaviour, observed with a
 * purpose-built native argv dumper:
 *
 *     /data              -> C:/Program Files/Git/data
 *     /data:/mnt/x       -> C:\Program Files\Git\data;C:\Program Files\Git\mnt\x   (":" became ";")
 *     --flag=/some/path  -> --flag=C:/Program Files/Git/some/path
 *     cmd.exe /c "..."   -> "/c" became a path, so cmd started INTERACTIVELY
 *
 * Every one of those is silent. `docker run -v /data:/x` would mount the wrong
 * directory and report success. `off` suppresses the rewriting entirely; a
 * 12-command everyday-workload comparison showed ZERO difference, because MSYS
 * programs (git, grep, tar, find) never went through it anyway.
 */
export const MSYS_PATHCONV_MODES = ['off', 'default', 'exclude'];

/**
 * PATH SHADOWING — the rationale that used to live on a helper here.
 *
 * Git Bash inherits a `PATH` that, on a machine also carrying Cygwin, can put
 * `/c/cygwin64/bin` ahead of Git's own `/usr/bin`. Measured consequence:
 *
 *     command -v cygpath   ->  /c/cygwin64/bin/cygpath       (Cygwin 3.5.4)
 *     cygpath -u 'C:\Users\Liserver'  ->  /cygdrive/c/Users/Liserver
 *
 * Git's own `cygpath` answers `/c/Users/Liserver`. The Cygwin answer is a path the
 * Git Bash toolchain cannot use, so a documented instruction to "convert with
 * cygpath" produced garbage — silently. `sed`, `awk`, `make`, and `gcc` can be
 * shadowed the same way.
 *
 * The fix does NOT live here. A Windows-PATH rewrite was written and then removed,
 * because setting `PATH` on the spawn spec has NO effect: the subprocess layer hands
 * bash a POSIX `PATH` of its own construction. The working fix is a script prefix in
 * `lib/executor.js` (`pathPrefix`), written in bash's own vocabulary.
 */

/**
 * Build the `MSYS2_ARG_CONV_EXCL` value for the opt-in exclusion mode.
 * @param substrings - user-declared substrings; MSYS matches these as literal
 *   substrings separated by `;`, NOT as globs. Only `*` acts as a wildcard.
 * @returns the environment value, or undefined when nothing was declared.
 */
export function msysExclusionList(substrings) {
  const parts = String(substrings ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts.join(';');
}
