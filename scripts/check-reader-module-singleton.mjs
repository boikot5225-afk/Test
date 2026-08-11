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

// Scan every quoted Reader URL, not just direct import(...) syntax. Several
// runtime modules keep the URL in READER_APP_URL and import that variable later;
// those are equally capable of creating a second ES-module instance.
const refs = [];
const readerUrlRe = /['"]([^'"\n]*reader-app\.js(?:\?[^'"\n]*)?)['"]/g;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(readerUrlRe)) {
        refs.push({ file: path.relative(repo, full).replaceAll('\\', '/'), specifier: match[1] });
      }
    }
  }
}
walk(jsRoot);

const actualReaderRefs = refs.filter(({ specifier }) => specifier.split('?')[0].endsWith('reader-app.js'));
const offenders = actualReaderRefs.filter(({ specifier }) => !specifier.endsWith(`reader-app.js${canonicalQuery}`));

console.log('canonical reader module:', canonicalSpecifier);
for (const ref of actualReaderRefs) console.log(`${ref.file}: ${ref.specifier}`);
if (offenders.length) {
  console.error('\nDuplicate Reader module URLs detected:');
  for (const ref of offenders) console.error(`  ${ref.file}: ${ref.specifier}`);
  console.error('Every Reader module URL must use the canonical versioned identity.');
  process.exit(1);
}
if (actualReaderRefs.length < 5) {
  console.error(`Too few Reader URL references were found (${actualReaderRefs.length}); scanner may have regressed.`);
  process.exit(1);
}
console.log(`reader module singleton: PASS (${actualReaderRefs.length} URL references, one identity)`);
