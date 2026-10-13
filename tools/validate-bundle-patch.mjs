// Structural validation of the regenerated bundle patch.
//
// The regeneration touched text inside the preset block (it repaired mojibake), so
// the file is not byte-identical to the one verified live. Parse it for real rather
// than trusting a diff.
//
// This file is a development tool and carries local paths on purpose: the research
// scratch tree that holds the extracted DSH sources is not part of the repository
// (see .gitignore). Adjust DSH_ROOT if you are running it elsewhere.
//
// Usage: node tools/validate-bundle-patch.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DSH_ROOT = 'F:\\TidyProjects\\dsh-powershell-getaway\\.research\\dsh-src\\dsh';
const PATCH = 'F:\\TidyProjects\\dsh-powershell-getaway\\bundle\\cordis.patch.yml';
const YAML_LIB = `${DSH_ROOT}\\node_modules\\js-yaml\\index.js`;

const yaml = await import(pathToFileURL(YAML_LIB).href);
const { load } = yaml.default ?? yaml;

// The shipped preset uses `!!js` for platform-conditional rows, e.g.
//   disabled: !!js process.platform === 'win32'
// The host registers a custom type for that tag; a bare js-yaml does not, and fails
// with "unknown tag !<tag:yaml.org,2002:js>". Registering it here evaluates the
// expression exactly as the host does, so the parse is faithful rather than lenient.
class JsExpression {
  constructor(source) {
    this.source = source;
  }
  /** Evaluate in this process; the expressions are platform checks. */
  value() {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${this.source});`)();
  }
}
const JsType = new yaml.default.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => data !== null && data !== '',
  construct: (data) => new JsExpression(data),
  instanceOf: JsExpression,
  predicate: (data) => data instanceof JsExpression,
  represent: (data) => data.source,
});

const text = readFileSync(PATCH, 'utf8');
const doc = load(text, { schema: yaml.default.DEFAULT_SCHEMA.extend([JsType]) });

if (!Array.isArray(doc)) throw new Error(`expected a top-level array, got ${typeof doc}`);
console.log(`parsed OK: top-level array of ${doc.length} entries`);

for (const [i, entry] of doc.entries()) {
  const kind = entry.insert !== undefined ? `insert (${entry.insert.length} rows)` : `id: ${entry.id}`;
  console.log(`  [${i}] ${kind}`);
}

// Shape assertions.
const [pwsh, preset, insert] = doc;
if (pwsh?.id !== 'tool-pwsh' || pwsh?.disabled !== true) throw new Error('entry 0 must disable tool-pwsh');
if (preset?.id !== 'preset-standard') throw new Error('entry 1 must be the preset-standard override');
if (insert?.insert === undefined) throw new Error('entry 2 must be the insert for our own row');

const rows = preset.config?.plugins;
if (!Array.isArray(rows)) throw new Error('preset override must carry config.plugins as an array');
console.log(`preset override: ${rows.length} top-level rows`);

/** Flatten `cordis:group` rows so nested plugins (plan-mode, subagents) are checked. */
function flatten(list, out = []) {
  for (const row of list) {
    out.push(row);
    if (Array.isArray(row.config)) flatten(row.config, out);
  }
  return out;
}
const all = flatten(rows);
console.log(`                ${all.length} rows including nested groups`);

const pwshRows = all.filter((r) => r.id === 'tool-pwsh');
if (pwshRows.length !== 1) throw new Error(`expected exactly one tool-pwsh row, found ${pwshRows.length}`);
if (pwshRows[0].disabled !== true) throw new Error('tool-pwsh must be disabled inside the preset');

const dupes = all.map((r) => r.id).filter((id, i, arr) => arr.indexOf(id) !== i);
if (dupes.length > 0) throw new Error(`duplicate plugin ids: ${dupes.join(', ')}`);

const unnamed = all.filter((r) => typeof r.id !== 'string' || typeof r.name !== 'string');
if (unnamed.length > 0) throw new Error(`${unnamed.length} row(s) missing id or name`);

// Every tool the shipped preset advertises must still be present. A patch replaces
// the whole config, so a dropped row is a capability silently removed from every agent.
const REQUIRED = [
  'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill',
  'tool-goal', 'tool-todo', 'tool-web', 'tool-ask-user', 'tool-subagent',
  'tool-subagent-fork', 'tool-workflow', 'plan-mode', 'tool-result-pruner',
];
const missing = REQUIRED.filter((id) => !all.some((r) => r.id === id));
if (missing.length > 0) throw new Error(`preset lost required row(s): ${missing.join(', ')}`);

// The plan-mode text that the regeneration repaired must be intact UTF-8.
const planMode = all.find((r) => r.id === 'plan-mode');
const guidance = JSON.stringify(planMode.config);
if (guidance.includes('\uFFFD')) throw new Error('plan-mode config contains a replacement character');
if (!guidance.includes('\u2014')) throw new Error('plan-mode config lost its em dash');
console.log(`plan-mode guidance: ${guidance.length} chars, em dash intact`);

const ourRow = insert.insert[0];
if (ourRow.id !== 'shell-getaway') throw new Error(`insert row must be shell-getaway, got ${ourRow.id}`);
console.log(`our row: ${ourRow.id} -> ${ourRow.name}`);
console.log(`        config: ${JSON.stringify(ourRow.config)}`);

console.log(`\nnon-ASCII characters present: ${(text.match(/[^\x00-\x7F]/g) ?? []).length}`);
console.log('\nPASS: patch parses, shape is correct, and the repaired text is intact UTF-8.');
