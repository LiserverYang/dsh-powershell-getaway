// Self-test for the pure helpers. Zero dependencies so it runs under the bundled
// Node in this session, outside the DSH Host.
//
// Run: node tools/test-shell-util.mjs
import {
  decodeMsysStatus,
  normalizeWslExitCode,
  toWindowsPath,
  toPosixPath,
  stripBom,
  normalizeCrlf,
  exceedsArgvLimit,
  msysExclusionList,
  BASH_ENV_OVERRIDES,
  MSYS_PATHCONV_MODES,
  SCRIPT_ARGV_LIMIT,
} from '../bundle/lib/shell-util.js';

let pass = 0;
let fail = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
  }
}

/** Assert a condition, reporting the offending value when it fails. */
function ok(label, condition, detail) {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}\n    ${detail === undefined ? 'condition was false' : String(detail)}`);
  }
}

// ── decodeMsysStatus: ALL eleven measured values, not a guessed formula ─────
// Measured on Git Bash 5.2.21; the raw statuses are tabulated in docs/RESEARCH.md.
eq('HUP 256 (1<<8)', decodeMsysStatus(256), { signal: 'SIGHUP', exitCode: null });
eq('INT 512 (2<<8)', decodeMsysStatus(512), { signal: 'SIGINT', exitCode: null });
eq('QUIT 0 (clean exit)', decodeMsysStatus(0), { signal: undefined, exitCode: 0 });
eq('ILL 33792 ((128+4)<<8)', decodeMsysStatus(33792), { signal: 'SIGILL', exitCode: null });
eq('ABRT 34304 ((128+6)<<8)', decodeMsysStatus(34304), { signal: 'SIGABRT', exitCode: null });
eq('FPE 34816 ((128+8)<<8)', decodeMsysStatus(34816), { signal: 'SIGFPE', exitCode: null });
eq('KILL 2304 (9<<8)', decodeMsysStatus(2304), { signal: 'SIGKILL', exitCode: null });
eq('SEGV 35584 ((128+11)<<8)', decodeMsysStatus(35584), { signal: 'SIGSEGV', exitCode: null });
eq('PIPE 3328 (13<<8)', decodeMsysStatus(3328), { signal: 'SIGPIPE', exitCode: null });
eq('ALRM 3584 (14<<8)', decodeMsysStatus(3584), { signal: 'SIGALRM', exitCode: null });
eq('TERM 3840 (15<<8)', decodeMsysStatus(3840), { signal: 'SIGTERM', exitCode: null });
eq('plain exit 9', decodeMsysStatus(9), { signal: undefined, exitCode: 9 });
eq('plain exit 255', decodeMsysStatus(255), { signal: undefined, exitCode: 255 });
eq('exit 0', decodeMsysStatus(0), { signal: undefined, exitCode: 0 });
eq('null code', decodeMsysStatus(null), { signal: undefined, exitCode: null });
eq('unnamed signo stays put', decodeMsysStatus(63 << 8), { signal: undefined, exitCode: 16128 });

// ── normalizeWslExitCode ────────────────────────────────────────────────────
eq('wsl sentinel', normalizeWslExitCode(4294967295), -1);
eq('wsl normal', normalizeWslExitCode(42), 42);

// ── toWindowsPath ───────────────────────────────────────────────────────────
eq('drive backslash', toWindowsPath('F:\\TidyProjects'), 'F:\\TidyProjects');
eq('drive forward', toWindowsPath('F:/TidyProjects'), 'F:\\TidyProjects');
eq('msys root', toWindowsPath('/f/TidyProjects/dsh'), 'F:\\TidyProjects\\dsh');
eq('msys single', toWindowsPath('/c'), 'C:\\');
eq('wsl mount', toWindowsPath('/mnt/f/TidyProjects'), 'F:\\TidyProjects');
eq('wsl mount root', toWindowsPath('/mnt/c/'), 'C:\\');
eq('extended prefix', toWindowsPath('\\\\?\\F:\\TidyProjects'), 'F:\\TidyProjects');
eq('relative untouched', toWindowsPath('sub/dir'), 'sub/dir');
eq('bare posix rooted', toWindowsPath('/usr/share'), 'C:\\usr\\share');
eq('empty', toWindowsPath(''), '');
eq('non-string', toWindowsPath(null), null);

// ── toPosixPath ─────────────────────────────────────────────────────────────
eq('gitbash posix', toPosixPath('F:\\TidyProjects\\dsh', 'gitbash'), '/f/TidyProjects/dsh');
eq('wsl posix', toPosixPath('F:\\TidyProjects\\dsh', 'wsl'), '/mnt/f/TidyProjects/dsh');
eq('cygwin posix', toPosixPath('C:\\Users\\x', 'cygwin'), '/cygdrive/c/Users/x');
eq('posix non-absolute', toPosixPath('relative\\path', 'gitbash'), undefined);

// ── stripBom / normalizeCrlf ────────────────────────────────────────────────
eq('bom stripped', stripBom('\uFEFFecho hi'), 'echo hi');
eq('no bom', stripBom('echo hi'), 'echo hi');
eq('crlf kept for gitbash', normalizeCrlf('a\r\nb', false), 'a\r\nb');
eq('crlf normalized for wsl', normalizeCrlf('a\r\nb', true), 'a\nb');

// ── exceedsArgvLimit ────────────────────────────────────────────────────────
eq('short script', exceedsArgvLimit('echo hi', 'C:\\bash.exe'), false);
eq('at the measured break', exceedsArgvLimit('x'.repeat(32700), ''), true);
eq('below the limit', exceedsArgvLimit('x'.repeat(SCRIPT_ARGV_LIMIT - 10), ''), false);
eq('executable path counts', exceedsArgvLimit('x'.repeat(SCRIPT_ARGV_LIMIT - 5), 'yyyyyyyyyy'), true);

// ── msysExclusionList ───────────────────────────────────────────────────────
eq('excl trim/join', msysExclusionList(' /data ; /var '), '/data;/var');
eq('excl empty', msysExclusionList(''), undefined);
eq('excl undefined', msysExclusionList(undefined), undefined);

// ── the shipped env overrides must include the load-bearing keys ────────────
// MSYS_NO_PATHCONV is deliberately NOT here: it is applied per dialect by the
// executor, so it can never leak into WSL or contradict the `exclude` mode.
// (A test in test-executor.mjs caught exactly that leak.)
eq('LANG set', BASH_ENV_OVERRIDES.LANG, 'C.UTF-8');
eq('TERM dumb', BASH_ENV_OVERRIDES.TERM, 'dumb');
eq('NO_COLOR set', BASH_ENV_OVERRIDES.NO_COLOR, '1');
eq('no MSYS switch in shared overrides', BASH_ENV_OVERRIDES.MSYS_NO_PATHCONV, undefined);
eq('msys modes enumerated', MSYS_PATHCONV_MODES, ['off', 'default', 'exclude']);

// PATH shadowing is fixed by a script prefix owned by lib/executor.js, not by a
// helper here — setting env.PATH on the spawn spec was measured to have no effect,
// because the subprocess layer hands bash a POSIX PATH of its own construction.
// `pathPrefix` is covered in test-executor.mjs.

console.log(`shell-util tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
