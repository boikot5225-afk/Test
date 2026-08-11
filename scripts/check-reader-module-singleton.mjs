import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const jsRoot = path.join(repo, 'js');
const appPath = path.join(jsRoot, 'app.js');
const app = fs.readFileSync(appPath, 'utf8');
const canonicalMatch = app.match(/from\s+['"](\.\/reader-app\.js(\?[^'"]+)?)['"]/);
if (!canonicalMatch) throw new Error('canonical reader-app import not found in js/app.js');
const canonicalSpecifier = canonicalMatch[1];
const canonicalQuery = canonicalMatch[2] || '';
if (!canonicalQuery) throw new Error('canonical reader-app import must be versioned');

const refs = [];
const importRe = /(?:from\s*|import\s*\()\s*['"]([^'"]*reader-app\.js(?:\?[^'"]*)?)['"]/g;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(importRe)) {
        refs.push({ file: path.relative(repo, full).replaceAll('\\', '/'), specifier: match[1] });
      }
    }
  }
}
walk(jsRoot);

const offenders = refs.filter(({ specifier }) => {
  const base = specifier.split('?')[0];
  if (!base.endsWith('reader-app.js')) return false;
  return !specifier.endsWith(`reader-app.js${canonicalQuery}`);
});

console.log('canonical reader module:', canonicalSpecifier);
for (const ref of refs) console.log(`${ref.file}: ${ref.specifier}`);
if (offenders.length) {
  console.error('\nDuplicate Reader module URLs detected:');
  for (const ref of offenders) console.error(`  ${ref.file}: ${ref.specifier}`);
  console.error('All executable imports must resolve to the same versioned reader-app URL.');
  process.exit(1);
}
console.log(`reader module singleton: PASS (${refs.length} imports, one URL identity)`);
