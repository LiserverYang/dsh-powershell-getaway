// In-repo verification that bundle/cordis.patch.yml reproduces the shipped preset
// EXACTLY except for the intended `disabled:` change.
//
// This replaces a shell pipeline that passed the preset block through PowerShell's
// `Set-Content -Encoding utf8`, which re-encoded the non-ASCII characters and made a
// correct regeneration look corrupt. Reading and writing in one Node process avoids
// that entire class of mistake.
//
// Usage:
//   node tools/verify-bundle-patch.mjs <shipped-preset.patch.yml> [patch.yml]
import { readFileSync } from 'node:fs';

const [, , shippedPath, patchPath = 'bundle/cordis.patch.yml'] = process.argv;
if (shippedPath === undefined) {
  console.error('usage: verify-bundle-patch.mjs <shipped-preset.patch.yml> [patch.yml]');
  process.exit(2);
}

const EXPECT_DISABLED = ['tool-pwsh'];

/** Shipped preset: drop comments/blanks and unwrap the `- insert:` block. */
function shippedRows(text) {
  const rows = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
  const at = rows.findIndex((l) => /^-\s+insert:\s*$/.test(l));
  if (at === -1) throw new Error('shipped preset: no "- insert:" block');
  const body = rows.slice(at + 1);
  const strip = body[0].slice(0, body[0].indexOf('- id:'));
  return body.map((l) => (l.startsWith(strip) ? l.slice(strip.length) : l));
}

/** Our patch: keep only the preset row, which starts at `- id: preset-standard`. */
function patchPresetRows(text) {
  const rows = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
  const at = rows.findIndex((l) => /^-\s+id:\s*preset-standard\s*$/.test(l));
  if (at === -1) throw new Error('patch: no "- id: preset-standard" row');
  const out = [];
  for (let i = at; i < rows.length; i += 1) {
    // Stop at the next top-level entry (the `- insert:` for our own row).
    if (i > at && /^- /.test(rows[i])) break;
    out.push(rows[i]);
  }
  return out;
}

const a = shippedRows(readFileSync(shippedPath, 'utf8'));
const b = patchPresetRows(readFileSync(patchPath, 'utf8'));

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// Locate plugin rows in the shipped list so a diff can be attributed to its owner.
const owners = [];
for (let i = 0; i < a.length; i += 1) {
  const m = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(a[i]);
  if (m) owners.push({ line: i, id: m[2], indent: m[1] });
}
const shippedIds = owners.map((o) => o.id);

console.log(`shipped preset rows : ${a.length} meaningful lines, ${shippedIds.length} plugin rows`);
console.log(`patch preset rows   : ${b.length} meaningful lines`);

const diffs = [];
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) diffs.push({ i, shipped: a[i], patched: b[i] });
}

console.log(`differing lines     : ${diffs.length}`);
for (const d of diffs) {
  const owner = owners.filter((o) => o.line < d.i).pop();
  console.log(`  [${d.i}] inside "${owner?.id ?? '<none>'}"`);
  console.log(`    shipped : ${JSON.stringify(d.shipped)}`);
  console.log(`    patched : ${JSON.stringify(d.patched)}`);
}

// Every diff must be a `disabled: true` replacement on an expected row.
for (const d of diffs) {
  const owner = owners.filter((o) => o.line < d.i).pop();
  if (owner === undefined) fail(`diff at line ${d.i} is not inside a plugin row`);
  if (!EXPECT_DISABLED.includes(owner.id)) fail(`unexpected change inside row "${owner.id}"`);
  if (!/^\s*disabled:\s*true\s*$/.test(d.patched ?? '')) {
    fail(`change inside "${owner.id}" is not "disabled: true": ${JSON.stringify(d.patched)}`);
  }
  if (!/^\s*disabled:/.test(d.shipped ?? '')) {
    fail(`change inside "${owner.id}" replaced a line that was not a disabled: key`);
  }
  if (d.shipped === d.patched) fail(`change inside "${owner.id}" is a no-op`);
}
if (diffs.length !== EXPECT_DISABLED.length) {
  fail(`expected ${EXPECT_DISABLED.length} changed line(s), saw ${diffs.length}`);
}
for (const id of EXPECT_DISABLED) {
  if (!shippedIds.includes(id)) fail(`row "${id}" is missing from the shipped preset`);
}

// The whole plugin id set must survive. This is the check that matters: a patch
// replaces the entire `config`, so a dropped row silently removes a capability.
const patchedIds = [];
for (let i = 0; i < b.length; i += 1) {
  const m = /^\s*-\s+id:\s*(\S+)\s*$/.exec(b[i]);
  if (m) patchedIds.push(m[1]);
}
if (JSON.stringify(shippedIds) !== JSON.stringify(patchedIds)) {
  fail(
    `plugin row set changed:\n  shipped: ${shippedIds.join(', ')}\n  patched: ${patchedIds.join(', ')}`,
  );
}

console.log(`\nPASS: all ${shippedIds.length} plugin rows preserved; only ${EXPECT_DISABLED.join(', ')} disabled.`);
