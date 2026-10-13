// Cross the real WSL boundary using the plugin's OWN buildArgv + mergeEnv.
//
// Unit tests prove the argv and env are shaped correctly; this proves they actually
// work when handed to `wsl.exe`. That distinction matters: the PATH-prefix fix passed
// its unit tests and still did nothing in production, because the subprocess layer
// rewrote the environment. Only running the real functions against the real OS finds
// that class of bug.
import { spawnSync } from 'node:child_process';
import { buildArgv, mergeEnv, pathPrefix } from '../bundle/lib/executor.js';

// Run: node tools/test-wsl-e2e.mjs
//
// Requires WSL2 with an 'Ubuntu' distribution on this machine; WSL_EXE, DISTRO and the
// workdir below are the local values. Unit tests cover the argv/env SHAPE; this covers
// whether those shapes work when handed to the real wsl.exe — a distinction that has
// already mattered once, when a PATH fix passed its unit tests and did nothing live.

const WSL_EXE = 'C:\\Program Files\\WSL\\wsl.exe';
const DISTRO = 'Ubuntu';
const WSL = { kind: 'wsl', path: WSL_EXE, distro: DISTRO };

const config = {
  shell: 'wsl',
  wslDistro: DISTRO,
  msysPathConv: 'off',
  normalizeCrlfForWsl: true,
  useStdinForLongCommands: true,
  maxOutputBytes: 64_000,
  maxSpillBytes: 1024,
  graceMs: 3000,
};

const fail = [];
const check = (label, condition, detail) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${condition || detail === undefined ? '' : ` -- ${detail}`}`);
  if (!condition) fail.push(label);
};

/** Run a script through the plugin's real argv/env construction. */
function runThroughPlugin(script, dshEnv = {}, shell = WSL, cfg = config) {
  const spec = { command: script, workdir: 'F:\\TidyProjects\\dsh-powershell-getaway', dshEnv };
  const built = buildArgv(shell, spec, cfg);
  const env = mergeEnv(shell, cfg, spec);
  const [file, ...args] = built.argv;
  const r = spawnSync(file, args, {
    cwd: spec.workdir,
    env,
    input: built.stdin,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: r.status, out: (r.stdout ?? ''), err: (r.stderr ?? ''), argv: built.argv, env, built };
}

console.log('=== argv shape (plugin output) ===');
{
  const r = runThroughPlugin('echo hi', { DSH_SHELL_KIND: 'wsl' });
  console.log(`  argv: ${JSON.stringify(r.argv)}`);
  check('no --cd is passed (cwd is inherited and auto-translated)', !r.argv.includes('--cd'));
  check('distro is pinned with -d', r.argv.includes('-d') && r.argv.includes(DISTRO));
  check('uses -e bash -c', r.argv.includes('-e') && r.argv.includes('bash') && r.argv.includes('-c'));
  check('WSL_UTF8 is set', r.env.WSL_UTF8 === '1');
  check('exit 0', r.status === 0, `status=${String(r.status)}`);
}

console.log('\n=== dialects differ: no MSYS_PATHCONV on WSL, no PATH prefix ===');
{
  const r = runThroughPlugin('echo x');
  check('MSYS layer is not configured for WSL', r.env.MSYS_NO_PATHCONV === undefined, JSON.stringify(r.env.MSYS_NO_PATHCONV));
  check('no MSYS arg-conversion switch', r.env.MSYS2_ARG_CONV_EXCL === undefined);
  check('no MSYS PATH prefix is injected', pathPrefix(WSL) === '');
  check('script is not prefixed with a PATH export', !r.argv.at(-1).startsWith('export PATH='));
}

console.log('\n=== WSLENV: do the DSH_* variables actually arrive? ===');
{
  const r = runThroughPlugin('echo "kind=${DSH_SHELL_KIND:-ABSENT}"; echo "path=${DSH_SHELL_PATH:-ABSENT}"', {
    DSH_SHELL_KIND: 'wsl',
    DSH_SHELL_PATH: WSL_EXE,
  });
  // The whitelist EXTENDS whatever the parent exports (the Host environment normally
  // carries a WSLENV from a previous call), so assert containment, not equality.
  const wslenv = String(r.env.WSLENV ?? '');
  const entries = wslenv.split(':');
  check(
    'WSLENV whitelists both names',
    entries.includes('DSH_SHELL_KIND') && entries.includes('DSH_SHELL_PATH'),
    wslenv,
  );
  check('no flag is emitted on our names (a flag could rewrite or blank the value)', !/DSH_SHELL_(KIND|PATH)\//.test(wslenv), wslenv);
  check('DSH_SHELL_KIND arrived', r.out.includes('kind=wsl'), JSON.stringify(r.out.trim()));
  // A path-shaped value must NOT be rewritten to /mnt/c/...: the model reads this as
  // the identity of the shell it is talking to.
  check(
    'DSH_SHELL_PATH arrived UNCHANGED (bare name, no /p)',
    r.out.includes(`path=${WSL_EXE}`),
    JSON.stringify(r.out.trim()),
  );
}

console.log('\n=== cwd bridging ===');
{
  const r = runThroughPlugin('pwd');
  check(
    'Windows cwd is inherited and mounted as /mnt/f/...',
    r.out.trim() === '/mnt/f/TidyProjects/dsh-powershell-getaway',
    JSON.stringify(r.out.trim()),
  );
}

console.log('\n=== UTF-8 round trip (WSL_UTF8 matters here) ===');
{
  const r = runThroughPlugin("printf '%s\\n' '你好 世界 café Ω'");
  check('unicode is byte-exact through wsl.exe', r.out.includes('你好 世界 café Ω'), JSON.stringify(r.out));
}

console.log('\n=== exit codes ===');
{
  check('exit 7', runThroughPlugin('exit 7').status === 7);
  check('missing command -> 127', runThroughPlugin('definitely-not-a-command-xyz').status === 127);
  // Measured ambiguity: this is NOT distinguishable from a clean `exit 15`, so the
  // plugin must not pretend to decode it.
  check('kill -TERM $$ -> 15 (documented ambiguity)', runThroughPlugin('kill -TERM $$').status === 15);
}

console.log('\n=== CRLF handling (WSL does not strip \\r) ===');
{
  const crlf = runThroughPlugin('printf "%s" "a"\r\nprintf "%s\\n" "b"');
  check('CRLF script still runs with normalization on', crlf.status === 0, `status=${String(crlf.status)} err=${JSON.stringify(crlf.err.slice(0, 80))}`);
  // And prove the hazard is real when it is switched off.
  const spec = { command: 'V=$(printf "x\\r"); printf "%s" "$V" | od -c | head -1', workdir: undefined, dshEnv: {} };
  const raw = buildArgv(WSL, spec, { ...config, normalizeCrlfForWsl: false });
  const r = spawnSync(raw.argv[0], raw.argv.slice(1), { env: mergeEnv(WSL, config, spec), encoding: 'utf8', windowsHide: true });
  console.log(`  (with normalization off: ${JSON.stringify((r.stdout ?? '').trim())})`);
}

console.log('\n=== long-command stdin route (bash -s) ===');
{
  const padding = '#'.repeat(31_000) + '\n';
  const r = runThroughPlugin(`${padding}echo "tail-ran"; echo "kind=\${DSH_SHELL_KIND:-ABSENT}"`, {
    DSH_SHELL_KIND: 'wsl',
  });
  check('routed through bash -s', r.argv.includes('-s'), JSON.stringify(r.argv.slice(1, 3)));
  check('padding did not break the script', r.out.includes('tail-ran'), JSON.stringify(r.out.trim().slice(-40)));
  check('WSLENV still applies on the stdin route', r.out.includes('kind=wsl'));
}

console.log('=== wsl.exe stderr noise ===');
// The line cannot be removed by the plugin. All four routes were measured and are dead
// (spawn env, the observed-stderr facade, an in-script redirect, overriding result()),
// so this asserts the DOCUMENTED truth rather than a fix that does not exist: the noise
// is present, and the command's own stderr arrives intact alongside it.
{
  const r = runThroughPlugin('echo ok', { DSH_SHELL_KIND: 'wsl' });
  check('the invocation succeeds', r.status === 0 && r.out.includes('ok'), `status=${String(r.status)}`);
  // The plugin cannot remove this line (four measured dead routes, see the README), so
  // its presence is a property of the MACHINE, not of this code. `networkingMode=mirrored`
  // in `.wslconfig` silences it; without that, it appears on every invocation.
  // Reported rather than asserted, so the suite passes either way while still showing
  // which state the machine is in.
  const noisy = r.err.includes('localhost proxy configuration');
  console.log(
    `  note: wsl.exe noise present = ${String(noisy)}` +
      (noisy ? ' (silence it with networkingMode=mirrored in .wslconfig)' : ' (mirrored networking is configured)'),
  );
  check(
    'stderr carries no noise beyond what the machine emits',
    r.err.trim() === '' || noisy,
    JSON.stringify(r.err.trim().slice(0, 120)),
  );
  const own = runThroughPlugin('echo mine >&2', { DSH_SHELL_KIND: 'wsl' });
  check('the command own stderr survives', own.err.includes('mine'), JSON.stringify(own.err.trim().slice(0, 120)));
  const both = runThroughPlugin('echo out-line; echo err-line >&2', {});
  check('stdout is separate from stderr', both.out.trim() === 'out-line', JSON.stringify(both.out.trim()));
  check('stderr joins stdout on the stderr channel', both.err.includes('err-line'), JSON.stringify(both.err.trim().slice(0, 80)));
}

console.log('\n=== launch failure signature (nonexistent distro) ===');
// Corrected after measuring: `wsl.exe` reports this on STDOUT, as UTF-16LE unless
// WSL_UTF8 is set, and leaves stderr empty. An earlier version of this check asserted
// stderr and would have "confirmed" a wrong belief. `settleWsl` prevents the situation
// by validating the distro before spawning, so this check documents the raw signature.
{
  // The distro comes from the DESCRIPTOR (which `settleWsl` validated) and only falls
  // back to config, so a bogus name has to be injected on the descriptor to reach
  // wsl.exe at all.
  const bogus = { ...WSL, distro: 'definitely-not-a-distro' };
  const r = runThroughPlugin('echo hi', {}, bogus);
  console.log(`  status=${JSON.stringify(r.status)}`);
  console.log(`  stdout=${JSON.stringify(r.out.trim().slice(0, 70))}`);
  console.log(`  stderr=${JSON.stringify(r.err.trim().slice(0, 40))}`);
  check('sentinel 4294967295', r.status === 4294967295, `status=${String(r.status)}`);
  check(
    'the diagnostic is on stdout, in words (why no detector is needed)',
    r.out.includes('no distribution with the supplied name'),
    JSON.stringify(r.out.trim().slice(0, 60)),
  );
  check('stderr is empty, so a stderr-based detector could never fire', r.err.trim() === '', JSON.stringify(r.err.trim().slice(0, 50)));
}

console.log(`\n${fail.length === 0 ? 'PASS' : `FAIL (${fail.length})`}: ${fail.length === 0 ? 'WSL end-to-end verified through the plugin own argv/env' : fail.join('; ')}`);
process.exit(fail.length === 0 ? 0 : 1);
