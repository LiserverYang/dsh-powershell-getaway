// Tests for the dialect DECISION, not its helpers.
//
// Why this file exists: the `auto` chain was supposed to be gitbash -> wsl -> pwsh,
// and it silently skipped WSL entirely — no Git Bash meant an immediate fall back to
// PowerShell, with WSL never probed. Every unit test passed the whole time, because
// they covered argv/env construction and nothing covered the decision that picks the
// dialect. So `selectShell` and `detectWsl` are exported and driven here.
//
// Run: node tools/test-select-shell.mjs
//
// MUST run under the Electron binary, because the plugin imports the running
// installation's schemastery and that is located relative to `process.execPath`:
//
//   ELECTRON_RUN_AS_NODE=1 "C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe" \
//     tools/test-select-shell.mjs
//
// Under a plain Node the manifest is not found, the resolver falls back to whatever
// `@deepseek-ai/*` it can reach on disk, and it picks up a GLOBAL DSH install whose
// schemastery has no `.volatile()` — failing with a confusing error that has nothing to
// do with the code under test.
//
// Machine-dependent by nature: the probes really do look for Git Bash and WSL, and the
// WSL expectations name this machine's `Ubuntu` distribution.
import { selectShell, detectWsl } from '../bundle/index.js';
import { selectableDistros } from '../bundle/lib/detect.js';

let pass = 0;
let fail = 0;
const failures = [];
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
  }
};
const ok = (label, condition, detail) => {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}\n    ${detail === undefined ? 'condition was false' : String(detail)}`);
  }
};

const BASE = {
  shell: 'auto',
  gitBashPath: '',
  wslExePath: '',
  wslDistro: '',
  cygwinBashPath: '',
  pwshPath: '',
  msysPathConv: 'off',
  msysArgConvExcl: '',
  allowConfined: false,
  normalizeCrlfForWsl: true,
  useStdinForLongCommands: true,
  cwd: '',
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  maxSpillBytes: 1024,
  graceMs: 3000,
};
const cfg = (over) => ({ ...BASE, ...over });
const noop = () => {};

// ── explicit pwsh ───────────────────────────────────────────────────────────
{
  const r = selectShell(cfg({ shell: 'pwsh' }), noop);
  eq('shell=pwsh picks pwsh', r.shell.kind, 'pwsh');
  eq('shell=pwsh reports no reason', r.reason, undefined);
  eq('pwsh honours an explicit path', selectShell(cfg({ shell: 'pwsh', pwshPath: 'X:/pwsh.exe' }), noop).shell.path, 'X:/pwsh.exe');
}

// ── auto: Git Bash wins when present ────────────────────────────────────────
{
  const r = selectShell(cfg({ shell: 'auto' }), noop);
  eq('auto prefers gitbash on this machine', r.shell.kind, 'gitbash');
  eq('auto emits no diagnostic when it succeeds', r.reason, undefined);
  ok('the chosen executable is a real absolute path', r.shell.path.endsWith('bash.exe'), r.shell.path);
}

// ── THE BUG: auto must reach WSL when Git Bash is absent ────────────────────
// A broken gitBashPath is how Git Bash is made absent without uninstalling it. Before
// the fix the chain went straight to PowerShell here and WSL was never probed.
//
// On this machine the distribution list is `Ubuntu`, `docker-desktop`,
// `docker-desktop-data`. Docker Desktop's two are filtered out of the DEFAULT choice —
// they have no login user — leaving exactly one usable candidate, so auto selects it.
// That filtering is itself asserted below, because without it a machine running Docker
// Desktop looked "ambiguous" and fell back to PowerShell for no good reason.
{
  const r = selectShell(cfg({ shell: 'auto', gitBashPath: 'X:/no-such-git/bash.exe' }), noop);
  ok('auto does not give up on Git Bash and jump to PowerShell', r.shell.kind !== 'pwsh', JSON.stringify(r.shell));
  eq('auto reaches the WSL dialect', r.shell.kind, 'wsl');
  eq('the single usable distribution is selected', r.shell.distro, 'Ubuntu');
  ok('a WSL result is fully resolved', typeof r.shell.path === 'string' && r.shell.path.length > 0, JSON.stringify(r.shell));
  eq('auto emits no diagnostic when WSL succeeds', r.reason, undefined);
}

// ── Docker Desktop's distributions must not block a default ─────────────────
{
  eq(
    'docker-desktop is not selectable',
    selectableDistros(['Ubuntu', 'docker-desktop', 'docker-desktop-data']),
    ['Ubuntu'],
  );
  eq('a lone real distro survives', selectableDistros(['Ubuntu']), ['Ubuntu']);
  eq('docker-only list becomes empty', selectableDistros(['docker-desktop']), []);
  eq('docker-desktop-data alone becomes empty', selectableDistros(['docker-desktop-data']), []);
  eq('case-insensitive', selectableDistros(['Docker-Desktop']), []);
  eq('unrelated names pass through', selectableDistros(['Debian', 'kali-linux']), ['Debian', 'kali-linux']);
  eq('empty in, empty out', selectableDistros([]), []);
  eq('order is preserved', selectableDistros(['docker-desktop', 'Ubuntu', 'Debian']), ['Ubuntu', 'Debian']);
}

// ── auto with a usable WSL distro configured ────────────────────────────────
{
  const r = selectShell(cfg({ shell: 'auto', gitBashPath: 'X:/no-such-git/bash.exe', wslDistro: 'Ubuntu' }), noop);
  eq('auto + wslDistro picks wsl', r.shell.kind, 'wsl');
  eq('the configured distro is carried through', r.shell.distro, 'Ubuntu');
  // A configured distro is honoured even when it is normally filtered out.
  const docker = selectShell(cfg({ shell: 'auto', gitBashPath: 'X:/no-such-git/bash.exe', wslDistro: 'docker-desktop' }), noop);
  eq('an explicitly configured docker distro is honoured', docker.shell.distro, 'docker-desktop');
}

// ── auto exhausted: pwsh, and the diagnostic must be actionable ─────────────
// Reached when Git Bash is broken AND the WSL choice cannot be settled: either the
// configured distro does not exist, or the executable cannot be found.
{
  const r = selectShell(
    cfg({ shell: 'auto', gitBashPath: 'X:/no-such-git/bash.exe', wslDistro: 'NoSuchDistro' }),
    noop,
  );
  eq('nothing usable -> pwsh', r.shell.kind, 'pwsh');
  ok('diagnostic names what was tried', r.reason.includes('Tried:'), r.reason);
  ok('diagnostic mentions gitbash', /gitbash/.test(r.reason), r.reason);
  ok('diagnostic mentions wsl', /wsl/i.test(r.reason), r.reason);
  ok('diagnostic says the tool still runs PowerShell', /PowerShell/.test(r.reason), r.reason);
  ok('diagnostic tells the user how to fix it', /Git for Windows/.test(r.reason), r.reason);
  ok('diagnostic offers a hard-error option', /shell: "gitbash"/.test(r.reason), r.reason);
  ok('diagnostic lists the installed distributions', /Installed: /.test(r.reason), r.reason);

  // An unusable explicit wslExePath, which is authoritative like gitBashPath.
  const noExe = selectShell(
    cfg({ shell: 'auto', gitBashPath: 'X:/no-such-git/bash.exe', wslExePath: 'X:/no-such-wsl/wsl.exe' }),
    noop,
  );
  eq('no usable wsl.exe -> pwsh', noExe.shell.kind, 'pwsh');
  ok(
    'diagnostic blames the configured wslExePath',
    /configured wslExePath .* is not a runnable wsl\.exe/.test(noExe.reason),
    noExe.reason,
  );
}

// ── explicit wsl ────────────────────────────────────────────────────────────
{
  const r = selectShell(cfg({ shell: 'wsl', wslDistro: 'Ubuntu' }), noop);
  eq('shell=wsl picks wsl', r.shell.kind, 'wsl');
  eq('shell=wsl carries the distro', r.shell.distro, 'Ubuntu');
  const path = selectShell(cfg({ shell: 'wsl' }), noop);
  eq('shell=wsl without a distro still yields a working executor', path.shell.kind, 'wsl');
  // Docker Desktop's distributions are filtered out of the default choice, so the one
  // usable distribution on this machine is picked rather than the choice being deferred.
  eq('the single usable distro is chosen, not guessed', path.shell.distro, 'Ubuntu');
  // A name that does not exist must be refused, with the real list in the message.
  const bad = selectShell(cfg({ shell: 'wsl', wslDistro: 'NoSuchDistro' }), noop);
  eq('a nonexistent distro is refused', bad.shell.kind, 'pwsh');
  ok('the refusal lists what IS installed', /Installed: /.test(bad.reason), bad.reason);
  // Case-insensitivity: WSL accepts `ubuntu` for `Ubuntu`, so refusing it would reject
  // a working configuration.
  eq('distro match is case-insensitive', selectShell(cfg({ shell: 'wsl', wslDistro: 'ubuntu' }), noop).shell.kind, 'wsl');
}

// ── explicit gitbash is a HARD requirement ──────────────────────────────────
{
  const r = selectShell(cfg({ shell: 'gitbash', gitBashPath: 'X:/no-such-git/bash.exe' }), noop);
  eq('shell=gitbash still yields a usable executor', r.shell.kind, 'pwsh');
  ok('shell=gitbash explains the configured path is at fault', /configured gitBashPath is unusable/.test(r.reason), r.reason);
  ok('shell=gitbash does NOT silently try WSL', !/wsl/i.test(r.reason), r.reason);
}

// ── cygwin is its own dialect, never a fallback ─────────────────────────────
// `cygwinBashPath` is authoritative exactly like `gitBashPath`: a configured path that
// does not work is a configuration error, not an invitation to use a different binary.
{
  const r = selectShell(cfg({ shell: 'cygwin', cygwinBashPath: 'X:/no-such-cygwin/bash.exe' }), noop);
  eq('shell=cygwin with a broken configured path yields a usable executor', r.shell.kind, 'pwsh');
  ok('shell=cygwin says Cygwin was requested', /shell=cygwin was requested/.test(r.reason), r.reason);
  ok('the diagnostic blames the configured path', /configured cygwinBashPath/.test(r.reason), r.reason);
  // And with no configured path it finds the real Cygwin on this machine.
  eq('shell=cygwin discovers Cygwin when not pinned', selectShell(cfg({ shell: 'cygwin' }), noop).shell.kind, 'cygwin');
}

// ── detectWsl directly ──────────────────────────────────────────────────────
{
  ok('detectWsl finds a runnable wsl.exe here', detectWsl(cfg({})).shell?.kind === 'wsl');
  const bad = detectWsl(cfg({ wslExePath: 'X:/no-such-wsl/wsl.exe' }));
  eq('a bogus wslExePath yields a reason, not a shell', bad.shell, undefined);
  // An explicit wslExePath is authoritative, matching gitBashPath and cygwinBashPath, so
  // the message blames the configured value rather than listing discovered rivals.
  ok('the reason blames the configured path', /configured wslExePath/.test(bad.reason), bad.reason);
  // Two failure modes must be distinguishable, because the fixes differ.
  const noDistro = detectWsl(cfg({ wslDistro: 'NoSuchDistro' }));
  ok('a bad distro name is reported as not installed', /is not installed/.test(noDistro.reason), noDistro.reason);
  const discovered = detectWsl(cfg({}));
  eq('with no distro configured the usable one is chosen', discovered.shell.distro, 'Ubuntu');
}

console.log(`select-shell tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
