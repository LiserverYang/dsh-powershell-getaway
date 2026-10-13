// Self-test for the executor's pure functions (argv building, env merging,
// sandbox refusal text). These carry the measured behaviours, so they are worth
// pinning outside the Host process.
//
// Run: node tools/test-executor.mjs
import { buildArgv, mergeEnv, sandboxRefusal, CONFINED_MODES, pathPrefix } from '../bundle/lib/executor.js';
import { buildWslenv, normalizeWslExitCode, decodeMsysStatus } from '../bundle/lib/shell-util.js';

let pass = 0;
let fail = 0;
const failures = [];
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
  }
}
function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}\n    ${detail ?? 'condition was false'}`);
  }
}

const GB = { kind: 'gitbash', path: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' };
const WSL = { kind: 'wsl', path: 'C:\\Program Files\\WSL\\wsl.exe' };
const CYG = { kind: 'cygwin', path: 'C:\\cygwin64\\bin\\bash.exe' };
const PWSH = { kind: 'pwsh', path: 'C:\\pwsh.exe' };

const cfg = {
  msysPathConv: 'off',
  wslDistro: '',
  useStdinForLongCommands: true,
  normalizeCrlfForWsl: true,
  maxOutputBytes: 64_000,
  maxSpillBytes: 1024,
  graceMs: 3000,
  allowConfined: false,
};

// ── argv shape ──────────────────────────────────────────────────────────────
// A bash-dialect argv carries the PATH prefix ahead of the user's script, so the
// assertions compare the stable parts: the argv head, and the script as a suffix.
/** Assert the argv head and that the payload ends with the caller's script. */
function eqArgv(label, actual, expectedHead, expectedScriptTail) {
  eq(`${label} head`, actual.argv.slice(0, -1), expectedHead);
  const tail = actual.argv.at(-1);
  ok(
    `${label} script is the tail`,
    tail.endsWith(expectedScriptTail),
    `payload (${tail.length} chars) does not end with ${JSON.stringify(expectedScriptTail)}`,
  );
}

eqArgv('gitbash', buildArgv(GB, { command: 'echo hi' }, cfg), [GB.path, '--noprofile', '--norc', '-c'], 'echo hi');
eqArgv('cygwin', buildArgv(CYG, { command: 'echo hi' }, cfg), [CYG.path, '--noprofile', '--norc', '-c'], 'echo hi');
// WSL has no MSYS layer, so it gets no PATH prefix and the payload is the plain script.
eq('wsl argv', buildArgv(WSL, { command: 'echo hi' }, cfg), {
  argv: [WSL.path, '-e', 'bash', '-c', 'echo hi'],
});
eq('wsl with distro', buildArgv(WSL, { command: 'echo hi' }, { ...cfg, wslDistro: 'Ubuntu' }), {
  argv: [WSL.path, '-d', 'Ubuntu', '-e', 'bash', '-c', 'echo hi'],
});
eq('pwsh returns undefined (base handles it)', buildArgv(PWSH, { command: 'echo hi' }, cfg), undefined);

// BOM must not become part of the first token.
ok(
  'bom stripped',
  buildArgv(GB, { command: '\uFEFFecho hi' }, cfg).argv[4].endsWith('echo hi') &&
    !buildArgv(GB, { command: '\uFEFFecho hi' }, cfg).argv[4].includes('\uFEFF'),
  'the BOM survived into the payload',
);

// WSL is the only dialect that needs CRLF normalization.
ok('gitbash keeps CRLF', buildArgv(GB, { command: 'a\r\nb' }, cfg).argv[4].endsWith('a\r\nb'), 'CRLF was rewritten');
eq('wsl normalizes CRLF', buildArgv(WSL, { command: 'a\r\nb' }, cfg).argv[4], 'a\nb');
eq('wsl CRLF kept when disabled', buildArgv(WSL, { command: 'a\r\nb' }, { ...cfg, normalizeCrlfForWsl: false }).argv[4], 'a\r\nb');

// Long scripts move to stdin (measured CreateProcess ceiling ~32720).
{
  const long = 'x'.repeat(40_000);
  const r = buildArgv(GB, { command: long }, cfg);
  eq('long gitbash -> -s', r.argv, [GB.path, '--noprofile', '--norc', '-s']);
  ok(
    'long gitbash -> stdin carries prefix + script',
    r.stdin.endsWith(long) && r.stdin.startsWith('export PATH='),
    `stdin length ${r.stdin.length}`,
  );
  const w = buildArgv(WSL, { command: long }, cfg);
  eq('long wsl -> -s', w.argv, [WSL.path, '-e', 'bash', '-s']);
  eq('long wsl -> stdin', w.stdin, long);
  const off = buildArgv(GB, { command: long }, { ...cfg, useStdinForLongCommands: false });
  eq('stdin routing off -> -c', off.argv.at(-2), '-c');
}

// ── environment ─────────────────────────────────────────────────────────────
const gbEnv = mergeEnv(GB, cfg, {});
eq('MSYS_NO_PATHCONV on by default', gbEnv.MSYS_NO_PATHCONV, '1');
eq('LANG set', gbEnv.LANG, 'C.UTF-8');
eq('NO_COLOR', gbEnv.NO_COLOR, '1');
eq('TERM dumb', gbEnv.TERM, 'dumb');

const exclEnv = mergeEnv(GB, { ...cfg, msysPathConv: 'exclude' }, {});
eq('exclude mode uses ARG_CONV_EXCL', exclEnv.MSYS2_ARG_CONV_EXCL, '*');
eq('exclude mode drops NO_PATHCONV', exclEnv.MSYS_NO_PATHCONV, undefined);

const custom = mergeEnv(GB, { ...cfg, msysPathConv: 'exclude', msysArgConvExcl: '/data;/var' }, {});
eq('custom exclusion list', custom.MSYS2_ARG_CONV_EXCL, '/data;/var');

const defaultConv = mergeEnv(GB, { ...cfg, msysPathConv: 'default' }, {});
eq('default mode leaves MSYS alone', defaultConv.MSYS_NO_PATHCONV, undefined);

const wslEnv = mergeEnv(WSL, cfg, { dshEnv: { DSH_HOME: 'C:\\x', DSH_PROFILE: 'desktop' } });
eq('WSL_UTF8 set', wslEnv.WSL_UTF8, '1');
// The whitelist EXTENDS whatever the parent already exports, so assert containment
// rather than an exact string — the Host environment normally carries a WSLENV.
ok('WSLENV whitelists the dsh keys', wslEnv.WSLENV.includes('DSH_HOME') && wslEnv.WSLENV.includes('DSH_PROFILE'), wslEnv.WSLENV);
eq('wsl has no MSYS vagary', wslEnv.MSYS_NO_PATHCONV, undefined);

// ── WSLENV construction (all facts here are measured) ───────────────────────
// Nothing crosses into WSL without a whitelist, and a BARE name passes the value
// through unchanged. Measured against "C:\Program Files\Git\usr\bin\bash.exe":
//     bare -> unchanged   /p -> /mnt/c/...   /l -> /mnt/c/...   /p/u -> ""
// So no flag may ever be emitted: a wrong guess loses the variable entirely.
//
// Because `buildWslenv` also reads the PARENT's `WSLENV`, assertions run with the
// parent's value temporarily cleared — otherwise the expected string would depend on
// whatever the surrounding session happens to export.
const SAVED_WSLENV = process.env.WSLENV;
delete process.env.WSLENV;
{
  eq('bare names, no flags', buildWslenv(undefined, ['DSH_SHELL_KIND', 'DSH_HOME']), 'DSH_SHELL_KIND:DSH_HOME');
  eq('empty list yields undefined (nothing to set)', buildWslenv(undefined, []), undefined);
  eq(
    'a path-shaped value gets NO /p, or it would be rewritten to /mnt/c/...',
    buildWslenv(undefined, ['DSH_SHELL_PATH']),
    'DSH_SHELL_PATH',
  );
  // An inherited WSLENV may carry the user's own flags; those are none of our business.
  eq(
    'inherited entries preserved verbatim',
    buildWslenv('MY_VAR/p:OTHER/u', ['DSH_HOME']),
    'MY_VAR/p:OTHER/u:DSH_HOME',
  );
  // A name the user already whitelisted must not gain a second, conflicting entry.
  eq('no duplicate for an inherited name', buildWslenv('DSH_HOME/p', ['DSH_HOME']), 'DSH_HOME/p');
  eq('duplicate detection ignores the flags', buildWslenv('dsh_home/p', ['DSH_HOME']), 'dsh_home/p');
  // Malformed input must not produce a stray empty entry or a bad key.
  eq('blank and non-string names skipped', buildWslenv(undefined, ['', '  ', undefined, 'OK']), 'OK');
  eq('stray empty inherited segments dropped', buildWslenv('::A::', ['B']), 'A:B');
  eq('duplicate names in one call collapse', buildWslenv(undefined, ['A', 'A']), 'A');

  // The whole point: the names the prompt tells the model to read must be listed.
  const shipped = mergeEnv(WSL, cfg, {
    dshEnv: { DSH_SHELL_KIND: 'wsl', DSH_SHELL_PATH: 'C:\\Program Files\\WSL\\wsl.exe' },
  });
  eq('DSH_SHELL_* reach WSL', shipped.WSLENV, 'DSH_SHELL_KIND:DSH_SHELL_PATH');
}
if (SAVED_WSLENV !== undefined) process.env.WSLENV = SAVED_WSLENV;

// The parent's whitelist is EXTENDED, never replaced or truncated. This matters because
// the Host environment normally carries a `WSLENV` that a previous call set, and dropping
// its entries would silently un-whitelist variables the model was told to read.
{
  const r = mergeEnv(WSL, cfg, { dshEnv: { DSH_NEW: 'x' } });
  const names = String(r.WSLENV).split(':');
  ok('an inherited whitelist is extended', names.includes('DSH_NEW'), r.WSLENV);
  ok('no entry is lost', names.length >= 2, r.WSLENV);
}
// A value smuggled in through the caller env must not override the computed whitelist.
eq('computed whitelist wins over a caller WSLENV', mergeEnv(WSL, cfg, { env: { WSLENV: 'BOGUS' }, dshEnv: { DSH_NEW: 'x' } }).WSLENV.includes('BOGUS'), false);

// ── WSL exit statuses ───────────────────────────────────────────────────────
// WSL does NOT shift the status the way MSYS does, so the two dialects need
// different handling and the MSYS decoder must never touch a WSL status.
{
  eq('sentinel 4294967295 -> -1', normalizeWslExitCode(4294967295), -1);
  eq('sentinel -1 -> -1', normalizeWslExitCode(-1), -1);
  eq('ordinary code untouched', normalizeWslExitCode(15), 15);
  eq('zero untouched', normalizeWslExitCode(0), 0);
  // The MSYS decoder must NOT be applied to a WSL status: 15 is SIGTERM, and
  // decoding it as shifted-by-8 would invent a nonsense signal number.
  const asMsys = decodeMsysStatus(15);
  eq('MSYS decoder would misread WSL 15 as a clean exit', asMsys.exitCode, 15);
  eq('MSYS decoder invents no signal for WSL 15', asMsys.signal, undefined);
  // Contrast: the SAME decoder is required for MSYS, where the status IS shifted.
  const gbTerm = decodeMsysStatus(3840);
  eq('MSYS 3840 really is SIGTERM', gbTerm.signal, 'SIGTERM');
}

// A caller-supplied env must be able to win (trusted caller semantics).
const overridden = mergeEnv(GB, cfg, { env: { LANG: 'en_US.UTF-8' } });
eq('caller env overrides defaults', overridden.LANG, 'en_US.UTF-8');

// ── sandbox refusal ─────────────────────────────────────────────────────────
ok('confined modes enumerated', CONFINED_MODES.has('read-only') && CONFINED_MODES.has('workspace-write'));
{
  const g = sandboxRefusal('workspace-write', 'gitbash');
  ok('gitbash refusal names the mode', g.includes('workspace-write'), g);
  ok('gitbash refusal offers allowConfined escape', g.includes('allowConfined'), g);
  ok('gitbash refusal offers policy switch', g.includes('danger-full-access'), g);
  const w = sandboxRefusal('workspace-write', 'wsl');
  ok('wsl refusal states no override exists', w.includes('no configuration override'), w);
  ok('wsl refusal does NOT offer allowConfined', !w.includes('allowConfined'), w);
}

// ── PATH prefix (fixes the measured Cygwin shadowing bug) ───────────────────
// Regression target: with Cygwin installed, `cygpath` resolved to Cygwin's and
// answered /cygdrive/c/... where Git's answers /c/... — silently unusable.
// The fix is a script prefix, because setting env.PATH on the spawn spec was
// measured to have NO effect: the subprocess layer hands bash its own POSIX PATH.
{
  const pre = pathPrefix(GB);
  ok('gitbash gets a PATH prefix', pre.length > 0, pre);
  // bash's own directory, derived without any PATH lookup.
  ok('uses ${BASH%/*} (no external command, no PATH lookup)', pre.includes('${BASH%/*}'), pre);
  ok('prepends /usr/bin', pre.includes('/usr/bin'), pre);
  ok('prepends /mingw64/bin', pre.includes('/mingw64/bin'), pre);
  ok('keeps the caller PATH last', pre.includes(':$PATH'), pre);
  ok('exports PATH', pre.startsWith('export PATH='), pre);
  ok('ends with a newline so it cannot glue onto the command', pre.endsWith('\n'), JSON.stringify(pre));
  // Non-bash dialects must not get a bash prefix.
  eq('pwsh gets no prefix', pathPrefix(PWSH), '');
  eq('wsl gets no prefix', pathPrefix(WSL), '');
  // The prefix rides inside the same -c argument, ahead of the user's script.
  // Assertions that could print a 30k-character script are avoided: the failing
  // value in this file is dumped verbatim, which floods the log.
  const built = buildArgv(GB, { command: 'echo hi' }, cfg);
  const carried = built.argv[4];
  ok('prefix is in the same argv element', carried.startsWith('export PATH='), 'argv[4] does not start with the prefix');
  ok('user script still comes last', carried.endsWith('echo hi'), 'argv[4] does not end with the user script');
  ok(
    'prefix is emitted exactly once',
    carried.split('export PATH=').length === 2,
    `prefix occurrences: ${carried.split('export PATH=').length - 1}`,
  );
}

console.log(`executor tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
