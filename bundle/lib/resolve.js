// Resolve DSH packages from the RUNNING installation.
//
// WHY THIS EXISTS
// A workspace plugin's module graph lives in the workspace. pnpm links the
// package, and Node resolves a module's REALPATH, so the resolution base is the
// bundle directory — where no `@deepseek-ai/*` package exists. A bare
// `import '@deepseek-ai/dsh-shell'` therefore fails with ERR_MODULE_NOT_FOUND.
//
// WHY NOT THE OBVIOUS ALTERNATIVES (both measured):
//   * `createRequire(profileDir).resolve(...)` finds a GLOBAL `dsh` install
//     (%APPDATA%\npm\...). On this machine that is 0.1.5-rc.1 while the running
//     Host is 0.2.0-rc.2 — it even exports a symbol rc.2 removed. Importing it
//     would yield a FOREIGN `Service` class and silently break `ctx.shell`.
//   * `ctx.loader.tree.import(name)` throws "Cannot convert object to primitive
//     value" — cordis's loader holds null-prototype objects.
//
// THE MECHANISM
// The desktop ships `<exeDir>/resources/app.asar/dsh/desktop-runtime.json`, the
// same manifest the Host booted from. `sharedPackages[]` lists every shared
// package with an archive-relative path, so we build absolute `file:///` URLs and
// import them directly. Node resolution never runs, and version identity is
// guaranteed because it is literally the Host's own manifest.
//
// Electron's patched fs (and its ESM loader) read inside app.asar, so these URLs
// load. Verified live: 287 packages resolved, both `dsh-tool-bash` and
// `dsh-pwsh-local` imported successfully.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Manifest filenames to probe, in order. */
const MANIFEST_RELATIVE_PATHS = [
  ['resources', 'app.asar', 'dsh', 'desktop-runtime.json'],
  ['resources', 'app', 'dsh', 'desktop-runtime.json'],
  ['resources', 'app.asar.unpacked', 'dsh', 'desktop-runtime.json'],
];

let cached = null;

/**
 * Locate and parse the runtime manifest for the running installation.
 * @returns `{ manifestPath, manifest, packages }` or `undefined` when absent
 *   (a non-desktop host, e.g. a source checkout or a CLI install).
 */
function loadRuntime() {
  if (cached !== null) return cached;

  const execDir = dirname(process.execPath);
  for (const rel of MANIFEST_RELATIVE_PATHS) {
    const manifestPath = join(execDir, ...rel);
    let manifest;
    try {
      if (!existsSync(manifestPath)) continue;
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    const root = dirname(manifestPath);
    const packages = new Map();
    for (const entry of manifest?.sharedPackages ?? []) {
      if (typeof entry?.name !== 'string' || typeof entry?.path !== 'string') continue;
      packages.set(entry.name, {
        dir: join(root, entry.path),
        version: entry.version,
      });
    }
    cached = { manifestPath, manifest, packages };
    return cached;
  }

  cached = undefined;
  return cached;
}

/**
 * Version guard for the fallback path.
 *
 * The plugin runs inside the Host process, so any package carrying a `Service`
 * subclass must be the SAME module instance the Host booted from: a second copy of
 * `ShellExecutor` has a different identity, and registering `ctx.shell` against it
 * fails in a way that is hard to diagnose. The manifest guarantees identity.
 *
 * The check is scoped to `@deepseek-ai/dsh-*`, which is where service classes live.
 * Packages such as `schemastery` are versioned independently (3.18.x here, not DSH's
 * 0.2.0-rc.2) and carry no service identity, so gating them on the DSH version
 * would reject a perfectly valid install for no benefit.
 */
const EXPECTED_DSH_VERSION = '0.2.0-rc.2';
const IDENTITY_BEARING = /^@deepseek-ai\/dsh-/u;

/** Read a package's declared version, or undefined. */
function versionOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/**
 * Fallback resolver for a host without a runtime manifest: walk up from the profile
 * directory. Used ONLY when the manifest is unavailable.
 *
 * A measured trap this guards against: on this machine `createRequire` from the
 * profile finds a GLOBAL `dsh` install at 0.1.5-rc.1 while the Host runs
 * 0.2.0-rc.2. That copy even exports a symbol rc.2 removed, so importing it would
 * be silently wrong rather than obviously broken.
 */
function packageDirViaRequire(name) {
  const anchors = [];
  if (process.env.DSH_PROFILE_DIR) anchors.push(join(process.env.DSH_PROFILE_DIR, 'package.json'));
  if (process.env.DSH_HOME) anchors.push(join(process.env.DSH_HOME, 'package.json'));
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      return dirname(req.resolve(`${name}/package.json`));
    } catch {
      /* try the next anchor */
    }
  }
  return undefined;
}

/** Read a package's declared entry, defaulting to the repository convention. */
function entryOf(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const exported = pkg.exports;
    if (typeof exported === 'string') return exported;
    const dot = exported?.['.'];
    if (typeof dot === 'string') return dot;
    if (typeof dot?.default === 'string') return dot.default;
    if (typeof dot?.import === 'string') return dot.import;
    if (typeof pkg.module === 'string') return pkg.module;
    if (typeof pkg.main === 'string') return pkg.main;
  } catch {
    /* fall through to the convention */
  }
  return 'lib/index.js';
}

/**
 * Import one shared package from the running installation.
 * @param name - exact package name, e.g. `@deepseek-ai/dsh-pwsh-local`.
 * @returns the imported module namespace.
 * @throws when the runtime manifest is unavailable or the package is not in it.
 *   The message names the remedy, because this is the one failure mode a user
 *   cannot diagnose from the plugin's own output.
 */
export async function importShared(name) {
  const runtime = loadRuntime();
  if (runtime !== undefined) {
    const dir = runtime.packages.get(name)?.dir;
    if (dir === undefined) {
      throw new Error(
        `shell-getaway: "${name}" is not in ${runtime.manifestPath} ` +
          `(${runtime.packages.size} shared packages). The running installation does not ship it.`,
      );
    }
    return import(pathToFileURL(join(dir, entryOf(dir))).href);
  }

  // No manifest. Fall back to require-based discovery, but only accept a copy whose
  // version matches the running Host — a mismatched `Service` class would break
  // `ctx.shell` registration in a way that is painful to trace.
  const dir = packageDirViaRequire(name);
  if (dir === undefined) {
    throw new Error(
      `shell-getaway: cannot locate ${name}. No runtime manifest was found next to ` +
        `${process.execPath} and the profile/home anchors did not resolve it either. ` +
        `This plugin needs the desktop layout (<app>/resources/app.asar/dsh/desktop-runtime.json) ` +
        `or a resolvable @deepseek-ai package set.`,
    );
  }
  const version = versionOf(dir);
  if (IDENTITY_BEARING.test(name) && version !== undefined && version !== EXPECTED_DSH_VERSION) {
    throw new Error(
      `shell-getaway: refusing ${name} v${version} at ${dir}: this package carries Service ` +
        `identity, the running Harness is v${EXPECTED_DSH_VERSION}, and a mismatched copy would ` +
        `register services under a foreign class. Locate the running installation's copy instead.`,
    );
  }
  return import(pathToFileURL(join(dir, entryOf(dir))).href);
}

/**
 * A diagnostics snapshot of what this resolver found.
 * @returns manifest path, version, package count, and whether named packages are
 *   present. Used by the plugin's startup log so a broken environment is visible
 *   without a debugger.
 */
export function runtimeFacts() {
  const runtime = loadRuntime();
  if (runtime === undefined) return { located: false };
  return {
    located: true,
    manifestPath: runtime.manifestPath,
    version: runtime.manifest?.release?.version,
    packageCount: runtime.packages.size,
  };
}
