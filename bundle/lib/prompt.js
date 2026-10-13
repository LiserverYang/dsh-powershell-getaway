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
 *     `${DSH_SHELL_KIND}` distinguishes them at runtime.
 *   * prefer forward slashes — measured: `git -C 'C:\Users\x'` fails with "cannot
 *     change to ... No such file or directory" while `/f/x` and `F:/x` both work.
 *     Paths DO survive the shell layer intact, so this is a compatibility
 *     preference, not a quoting rule.
 *   * single-quote a backslash path — measured: unquoted `echo C:\Users\x` prints
 *     `C:Usersx`, because bash consumes `\U` as an escape. Quoting fixes it, so the
 *     advice is about quoting rather than avoidance.
 *   * no POSIX-path conversion for native Windows programs — the executor sets
 *     MSYS_NO_PATHCONV=1 because the default rewriting is silent and wrong
 *     (`/data` became `C:/Program Files/Git/data`; `/data:/mnt/x` even had its
 *     colon turned into a semicolon, and `cmd.exe /c` turned interactive).
 *   * `run_in_background` rather than `&` — measured: a bare `sleep 5 &` blocks the
 *     call for the child's lifetime because the child holds the stdout pipe.
 */
export const POSIX_GUIDANCE = [
  'Commands run in bash, so use POSIX shell syntax: `$VAR` or `${VAR}` for variables, not `$env:VAR`.',
  'Paths inside a command use the POSIX form your shell mounts drives at: `/c/Users/...` under Git Bash,',
  '`/mnt/c/Users/...` under WSL. Read `${DSH_SHELL_KIND}` to see which dialect is active, and convert any',
  'Windows path on demand with `cygpath -u` (Git Bash) or `wslpath -u` (WSL).',
  'Prefer forward slashes (`F:/TidyProjects/x`) for paths you pass to commands: most POSIX tools, including',
  '`git -C`, reject `\\` as a separator. A path containing backslashes must be single-quoted, because bash',
  'otherwise consumes `\\U` as an escape (`echo C:\\Users\\x` prints `C:Usersx`).',
  'Native Windows programs receive your arguments unchanged: this shell does NOT convert POSIX-looking paths.',
  'Pass a Windows path to `docker`, `robocopy`, or `cmd` yourself (`docker run -v C:/data:/x`), and do not',
  'expect `/data` to be translated.',
  'Use the tool\'s `run_in_background` argument for long-running work instead of a shell `&`, which keeps the',
  'call blocked until the child exits.',
  'The `workdir` argument takes a Windows path (`F:\\x` or `F:/x`), unlike paths inside the command itself.',
].join(' ');
