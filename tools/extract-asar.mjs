import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

const archive = process.argv[2];
const outRoot = process.argv[3];
const filter = process.argv[4] || '';

const fd = readFileSync(archive).subarray(0);
// This archive's header pickle is: [0)=4, [4)=pickleEnd, [8)=outerLen, [12)=jsonLen, [16..)=JSON
const jsonLen = fd.readUInt32LE(12);
const pickleEnd = fd.readUInt32LE(4);
const headerStr = fd.toString('utf8', 16, 16 + jsonLen);
const header = JSON.parse(headerStr);
const baseOffset = 8 + pickleEnd;

// Report header parse status to a file so native stderr cannot corrupt it.
try {
  JSON.parse(headerStr);
} catch (e) {
  writeFileSync(join(outRoot, '..', 'header-error.txt'), String(e && e.message));
}

let files = 0;
let bytes = 0;

function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = rel ? rel + '/' + name : name;
    if (entry.files) {
      walk(entry, p);
    } else if (typeof entry.offset === 'string' || typeof entry.offset === 'number') {
      if (filter && !p.includes(filter)) continue;
      const off = baseOffset + Number(entry.offset);
      const buf = fd.subarray(off, off + Number(entry.size));
      const target = join(outRoot, p.split('/').join(sep));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
      files++;
      bytes += Number(entry.size);
    }
  }
}

walk(header, '');
writeFileSync(
  join(outRoot, '..', 'extract-report.json'),
  JSON.stringify({ files, bytes, pickleEnd, jsonLen, baseOffset }, null, 2),
);
process.exit(0);
