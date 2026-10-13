// Model-facing prompt text for the getaway shell.
//
// Two sections are registered, both in the measured gap between the shipped
// TOOL_BASH order (1000) and TOOL_PWSH order (1010):
//
//   shell:getaway:exit    (1001) restores one Windows fact the swap would LOSE
//   shell:getaway:dialect (1002) teaches the POSIX dialect and the two path forms
//
// WHY 1001 IS NOT OPTIONAL
// The shipped `tool:pwsh` section is the ONLY place the model is told that a killed
// process on Windows settles as `[exit code: 1]` with no signal marker. Mounting
// `tool-bash` instead (order 1000) drops that sentence, and the model then reads an
// interrupted command as a command failure — and goes off to fix a bug that does
// not exist. Measured by reading both descriptions: the bash section carries only
// "Check the [exit code: N] marker...".
//
// WHY THE DIALECT TEXT IS NOT DYNAMIC
// Prompt text is registered once for the scope. Rewriting it per detected shell
// would churn the request prefix and defeat KV-cache reuse, and the authoring
// contract says to add prompt text through `systemPrompt.section()` rather than by
// listening to `system-prompt/assemble`. So the text describes both path forms
// objectively and points the model at `${DSH_SHELL_KIND}` to decide which applies.

/** Prompt section orders, chosen to sit between the shipped tool sections. */
export const SECTION_ORDER = {
  /** After the shipped tool:bash section (1000). */
  exit: 1001,
  /** After our exit fact, still before the shipped tool:pwsh section (1010). */
  dialect: 1002,
};

/** The Windows termination fact that only the pwsh prompt section carried. */
export const WINDOWS_EXIT_FACT =
  'On Windows a force-killed command settles as `[exit code: 1]` without a signal marker. ' +
  'Treat a bare exit 1 after an interruption as a termination, not a command failure.';

/**
 * Dialect guidance.
 *
 * Every claim here is one the implementation actually enforces or one measured on
 * this machine:
 *   * `$VAR` not `$env:VAR` — the executor runs bash, so PowerShell syntax is simply
 *     wrong and worth saying plainly.
 *   * two path forms — Git Bash mounts drives at `/c/...`, WSL at `/mnt/c/...`;
 *     `${DSH_SHELL_KIND}` distinguishes them at runtime. Stated as a lookup keyed on
 *     that variable rather than as one instruction, because the two disagreement
 *     cases (drive root vs `/mnt`, and Windows `.exe` binaries reachable or not) are
 *     the likeliest things to get wrong after a dialect switch.
 *   * prefer forward slashes — measured: `git -C 'C:\Users\x'` fails with "cannot
 *     change to ... No such file or directory" while `/f/x` and `F:/x` both work.
 *     Paths DO survive the shell layer intact, so this is a compatibility
 *     preference, not a quoting rule.
 *   * single-quote a backslash path — measured: unquoted `echo C:\Users\x` prints
 *     `C:Usersx`, because bash consumes `\U` as an escape. Quoting fixes it, so the
 *     advice is about quoting rather than avoidance.
 *   * no POSIX-path conversion for native Windows programs — under Git Bash the
 *     executor sets MSYS_NO_PATHCONV=1 because the default rewriting is silent and
 *     wrong (`/data` became `C:/Program Files/Git/data`; `/data:/mnt/x` even had its
 *     colon turned into a semicolon, and `cmd.exe /c` turned interactive). Scoped to
 *     Git Bash in the text, because WSL has no MSYS layer to set it for.
 *   * signal ambiguity — measured on BOTH dialects: `kill -TERM $$` reports status 15
 *     on WSL and 3840 on MSYS. On WSL that is indistinguishable from a clean
 *     `exit 15`, so the guidance tells the model to read 128+N as "killed" rather
 *     than to attempt a recovery that is not possible.
 *   * `run_in_background` rather than `&` — measured: a bare `sleep 5 &` blocks the
 *     call for the child's lifetime because the child holds the stdout pipe.
 */
export const POSIX_GUIDANCE = [
  'Commands run in bash. Read `${DSH_SHELL_KIND}` first: `gitbash` is MSYS on Windows, `wsl` is a real Linux',
  'distribution, and they differ in the two ways below. Use POSIX shell syntax either way: `$VAR` or',
  '`${VAR}` for variables, not `$env:VAR`.',
  // The path form is the single most likely thing to get wrong, so it is stated as a
  // lookup keyed on the variable the executor actually sets, not as a guess.
  'Paths inside a command use the POSIX form your shell mounts drives at: Git Bash has drives at the root',
  '(`/c/Users/...`, `/f/...`) while WSL mounts them under `/mnt` (`/mnt/c/Users/...`). Convert a Windows path',
  'on demand with `cygpath -u` under Git Bash or `wslpath -u` under WSL — do not guess, the two disagree.',
  // WSL specifics that do not hold for Git Bash.
  'Under WSL the filesystem is Linux, so `C:` paths are not valid there and Windows executables need their',
  '`.exe` suffix (`cmd.exe`, `where.exe`, `powershell.exe`). The reverse holds under Git Bash, which is still',
  'Windows: its binaries are the Windows ones.',
  'Prefer forward slashes (`F:/TidyProjects/x`) for paths you pass to commands: most POSIX tools, including',
  '`git -C`, reject `\\` as a separator. A path containing backslashes must be single-quoted, because bash',
  'otherwise consumes `\\U` as an escape (`echo C:\\Users\\x` prints `C:Usersx`).',
  'Under Git Bash, native Windows programs receive your arguments unchanged: that shell does NOT convert',
  'POSIX-looking paths. Pass a Windows path to `docker`, `robocopy`, or `cmd` yourself',
  '(`docker run -v C:/data:/x`), and do not expect `/data` to be translated.',
  'Use the tool\'s `run_in_background` argument for long-running work instead of a shell `&`, which keeps the',
  'call blocked until the child exits.',
  'The `workdir` argument takes a Windows path (`F:\\x` or `F:/x`), unlike paths inside the command itself.',
  // Measured and worth stating: both dialects report a signal death as an ambiguous
  // status, so the model should not try to infer a signal that cannot be recovered.
  'A signal death may be reported as a plain exit code (bash uses 128+N, e.g. 143 for SIGTERM) rather than a',
  'named signal: WSL and Git Bash both return the raw status and the two cases cannot be told apart, so treat',
  '128+N as "the command was killed" rather than as a normal failure.',
].join(' ');
