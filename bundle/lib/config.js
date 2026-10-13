// Plugin Config.
//
// ══ WHY THIS MUST BE A REAL SCHEMASTERY OBJECT ══
// An earlier revision hand-wrote a minimal Standard Schema (`~standard.validate`)
// because a workspace plugin cannot statically import a bare `@deepseek-ai/*`
// specifier. That was a mistake with a very indirect symptom.
//
// `@deepseek-ai/dsh-settings`'s `SettingsForms.describe()` INTROSPECTS the schema
// rather than merely validating with it, and calls schemastery accessors such as
// `.volatile()` on each field. A plain object has no such method, so `describe()`
// threw:
//
//     settings/describe -> result.ok=false
//     error: "Cannot read properties of undefined (reading 'volatile')"
//
// That single RPC is the desktop welcome window's first request
// (`settingsAndReference` in the shell's main.js), so the window failed with
// "Web RPC failed" and the whole app refused to start — repeatedly. The plugin's
// `apply` was never at fault, which is why host-mount tests kept passing.
//
// So the schema is built with the RUNNING installation's schemastery, obtained
// through the same runtime-manifest resolver the executor uses. Top-level await
// runs during the import phase, before the loader reads `Config`.
import { importShared } from './resolve.js';

const z = (await importShared('@deepseek-ai/schemastery')).default;

export const Config = z.object({
  // ── dialect selection ────────────────────────────────────────────────────
  shell: z
    .union(['auto', 'pwsh', 'gitbash', 'wsl', 'cygwin'])
    .default('auto')
    .description('Shell to run commands in. auto = Git Bash, then WSL2, then the shipped PowerShell executor.'),

  // ── executables (empty = discover; discovery never adopts a bare name) ────
  gitBashPath: z
    .string()
    .default('')
    .description('Absolute path to Git Bash. Prefer usr\\bin\\bash.exe, which does not spawn a second bash.'),
  wslExePath: z.string().default('').description('Absolute path to wsl.exe. Default: C:\\Program Files\\WSL\\wsl.exe.'),
  wslDistro: z
    .string()
    .default('')
    .description(
      "WSL distribution name. Required when several are installed, because guessing could run the model's commands inside docker-desktop.",
    ),
  cygwinBashPath: z.string().default('').description('Absolute path to Cygwin bash.exe.'),
  pwshPath: z.string().default('').description('Absolute path to pwsh.exe, used by the pwsh dialect.'),

  // ── MSYS argument rewriting ──────────────────────────────────────────────
  msysPathConv: z
    .union(['off', 'default', 'exclude'])
    .default('off')
    .description(
      'MSYS2 rewrites POSIX-looking arguments before native Windows programs see them, silently: /data became ' +
        'C:/Program Files/Git/data, and a colon inside /data:/mnt/x became a semicolon. off = MSYS_NO_PATHCONV=1 ' +
        '(the default, because a 12-command everyday comparison showed no downside). default = leave MSYS alone. ' +
        'exclude = MSYS2_ARG_CONV_EXCL=*.',
    ),
  msysArgConvExcl: z
    .string()
    .default('')
    .description(
      'Extra MSYS2_ARG_CONV_EXCL substrings, semicolon-separated. MSYS matches these literally, not as globs, ' +
        'so only "*" is a wildcard.',
    ),

  // ── sandbox policy ───────────────────────────────────────────────────────
  allowConfined: z
    .boolean()
    .default(false)
    .description(
      'Permit bash under a confined sandbox mode. Never applies to WSL, which cannot be confined on Windows. ' +
        'Leave false unless you have verified bash works under the restricted token on this machine.',
    ),

  // ── behaviour ────────────────────────────────────────────────────────────
  normalizeCrlfForWsl: z
    .boolean()
    .default(true)
    .description(
      'Collapse CRLF to LF in the script on the WSL dialect. WSL bash does not strip the CR, so a positioned ' +
        'argument would arrive with a trailing carriage return.',
    ),
  useStdinForLongCommands: z
    .boolean()
    .default(true)
    .description(
      'Route scripts longer than about 30000 characters over stdin via `bash -s`, staying under the ' +
        '32767-character CreateProcess ceiling (measured: 32700 works, 32720 fails).',
    ),

  // ── execution budgets, matching dsh-pwsh-local so behaviour is unchanged ──
  // `.volatile()` is not decoration: `SettingsForms.describe()` calls it, which is
  // precisely what the hand-written schema above failed to provide.
  cwd: z.string().default('').volatile(),
  timeoutMs: z.number().default(120_000).volatile(),
  maxTimeoutMs: z.number().default(600_000).volatile(),
  maxOutputBytes: z.number().default(64_000).volatile(),
  maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
  graceMs: z.number().default(3_000).volatile(),
});
