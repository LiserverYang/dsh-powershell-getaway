// Shell discovery with IDENTITY VERIFICATION.
//
// WHY VERIFICATION IS MANDATORY (measured on this machine):
//   `where.exe bash` returns, in order:
//     1. %LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe  — a 0-byte reparse point
//        whose target is ANOTHER USER's profile. DSH's own resolver skips it only
//        because it rejects zero-byte files. Do not rely on that.
//     2. C:\Windows\System32\bash.exe                   — the WSL shim.
//     3. C:\cygwin64\bin\bash.exe                       — Cygwin.
//   Git for Windows is NOT on PATH at all. Worse, the WSL shim and the alias both
//   answer `bash --version` with "5.3.9(1)-release (x86_64-pc-linux-gnu)", so an
//   "it runs" probe concludes "we have Linux bash" while the plugin believes it
//   has Git Bash. Identity must be asserted, not inferred from executability.
//
// A dark corner worth knowing: `C:\Users\Liserver` is a JUNCTION to
// `C:\Users\杨绍璞`, so byte-comparing user paths can fail unexpectedly.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** Executables that must never be adopted, whatever they answer. */
const DENY_SUFFIXES = [
  '\\windows\\system32\\bash.exe',
  '\\microsoft\\windowsapps\\bash.exe',
];

/** Version-string markers that identify each dialect positively. */
const IDENTITY = {
  gitbash: 'pc-msys',
  cygwin: 'pc-cygwin',
};

/**
 * Whether a path is a candidate we refuse outright.
 * @param candidate - absolute path.
 * @returns true when the path is on the deny list.
 */
export function isDenied(candidate) {
  const lowered = candidate.toLowerCase().replace(/\//g, '\\');
  return DENY_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

/** A file (or symlink to one) we could spawn, and nothing else. */
function isSpawnable(candidate) {
  try {
    const stat = lstatSync(candidate);
    // Zero-byte files are App Execution Alias stubs, not programs. `lstat`
    // (not `stat`) so a reparse point is seen as itself rather than followed.
    if (stat.size === 0) return false;
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Read a bash's `--version` banner.
 * @param exe - absolute path to a bash executable.
 * @returns the first line, or undefined when it could not be run.
 */
export function bashVersion(exe) {
  try {
    const out = execFileSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Verify a bash is the dialect we think it is.
 * @param exe - absolute path.
 * @param kind - `'gitbash'` or `'cygwin'`.
 * @returns an object describing the decision, never throwing.
 */
export function verifyBash(exe, kind) {
  if (!existsSync(exe)) return { ok: false, reason: 'does not exist' };
  if (isDenied(exe)) return { ok: false, reason: 'on the deny list (WSL shim or App Execution Alias)' };
  if (!isSpawnable(exe)) return { ok: false, reason: 'not a spawnable file (directory or zero-byte alias)' };
  const version = bashVersion(exe);
  if (version === undefined) return { ok: false, reason: 'did not answer --version' };
  const marker = IDENTITY[kind];
  if (marker !== undefined && !version.includes(marker)) {
    return {
      ok: false,
      reason: `identity mismatch: expected a version containing "${marker}", got ${JSON.stringify(version)}`,
      version,
    };
  }
  return { ok: true, version, exe, kind };
}

/**
 * Ordered Git Bash candidates.
 *
 * `usr\bin\bash.exe` is preferred over `bin\bash.exe` because the latter spawns a
 * SECOND bash (node -> bin\bash.exe -> usr\bin\bash.exe -> target), which adds a
 * process-tree layer that complicates termination and gains nothing.
 *
 * @param configured - explicit `gitBashPath` from plugin config.
 * @param env - environment to read install roots from.
 * @returns absolute candidate paths, best first.
 */
export function gitBashCandidates(configured, env = process.env) {
  const out = [];
  const add = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p);
  };
  add(configured);

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA;

  for (const root of [
    programFiles === undefined ? undefined : join(programFiles, 'Git'),
    localAppData === undefined ? undefined : join(localAppData, 'Programs', 'Git'),
    programFilesX86 === undefined ? undefined : join(programFilesX86, 'Git'),
  ]) {
    if (root === undefined) continue;
    add(join(root, 'usr', 'bin', 'bash.exe'));
    add(join(root, 'bin', 'bash.exe'));
  }

  // Registry: the installer records its root here.
  try {
    const out2 = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = /InstallPath\s+REG_SZ\s+(.+)/.exec(String(out2));
    const installRoot = match?.[1]?.trim();
    if (installRoot !== undefined && installRoot.length > 0) {
      add(join(installRoot, 'usr', 'bin', 'bash.exe'));
      add(join(installRoot, 'bin', 'bash.exe'));
    }
  } catch {
    /* no registry entry */
  }

  // Last resort: derive from `where git` (Git for Windows ships git.exe under
  // <root>\cmd). Never a bare name.
  try {
    const out3 = execFileSync('where.exe', ['git.exe'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of String(out3).split(/\r?\n/)) {
      const gitExe = line.trim();
      if (gitExe.length === 0) continue;
      const root = dirname(dirname(gitExe));
      add(join(root, 'usr', 'bin', 'bash.exe'));
      add(join(root, 'bin', 'bash.exe'));
    }
  } catch {
    /* git not on PATH */
  }

  return out;
}

/**
 * Find the first Git Bash that passes identity verification.
 * @param configured - explicit `gitBashPath`.
 * @param env - environment for install roots.
 * @returns the verified shell, or a report of every rejection.
 */
export function findGitBash(configured, env = process.env) {
  const attempts = [];
  for (const candidate of gitBashCandidates(configured, env)) {
    const verdict = verifyBash(candidate, 'gitbash');
    attempts.push({ candidate, ...verdict });
    if (verdict.ok) return { found: verdict, attempts };
  }
  if (configured !== undefined && configured.length > 0) {
    // An explicit path that fails is a configuration error, not a discovery miss.
    const only = attempts.find((a) => a.candidate === configured);
    return {
      found: undefined,
      attempts,
      configuredFailure: only === undefined ? 'was not checked' : only.reason,
    };
  }
  return { found: undefined, attempts };
}

/**
 * Ordered Cygwin candidates. Cygwin uses `/cygdrive/c/...` rather than `/c/...`,
 * so it is a separate dialect, never a fallback for Git Bash.
 * @param configured - explicit `cygwinBashPath`.
 * @param env - environment.
 * @returns absolute candidate paths.
 */
export function findCygwin(configured, env = process.env) {
  const attempts = [];
  const roots = [];
  if (configured !== undefined && configured.length > 0) roots.push(configured);
  const systemDrive = env.SystemDrive ?? 'C:';
  roots.push(join(`${systemDrive}\\`, 'cygwin64', 'bin', 'bash.exe'));
  roots.push(join(`${systemDrive}\\`, 'cygwin', 'bin', 'bash.exe'));
  for (const candidate of roots) {
    const verdict = verifyBash(candidate, 'cygwin');
    attempts.push({ candidate, ...verdict });
    if (verdict.ok) return { found: verdict, attempts };
  }
  return { found: undefined, attempts };
}

/** Ordered `wsl.exe` candidates; the Program Files copy is the modern one. */
export function wslExeCandidates(configured, env = process.env) {
  const out = [];
  const add = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p);
  };
  add(configured);
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const systemRoot = env.SystemRoot ?? 'C:\\Windows';
  add(join(programFiles, 'WSL', 'wsl.exe'));
  add(join(systemRoot, 'System32', 'wsl.exe'));
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    add(join(trimmed, 'wsl.exe'));
  }
  return out;
}

/**
 * Read the WSL version banner for one `wsl.exe`.
 *
 * `WSL_UTF8=1` matters: without it `wsl.exe` writes UTF-16LE for its own output
 * (the distro list, `--status`, AND error messages), which decodes to mojibake
 * through a UTF-8 pipeline.
 *
 * @param exe - absolute path to `wsl.exe`.
 * @returns the version line, or undefined.
 */
export function wslVersion(exe) {
  if (!existsSync(exe)) return undefined;
  try {
    const out = execFileSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Enumerate installed WSL distributions.
 * @param exe - absolute path to `wsl.exe`.
 * @returns distribution names, possibly empty.
 */
export function wslDistros(exe) {
  try {
    const out = execFileSync(exe, ['-l', '-q'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out)
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Read one KEY=VALUE from a `reg.exe` query, or undefined. */
function regValue(key, name) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', name], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = new RegExp(`${name}\\s+REG_SZ\\s+(.+)`).exec(String(out));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export { regValue, readFileSync };
