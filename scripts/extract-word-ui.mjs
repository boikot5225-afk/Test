import fs from 'node:fs';

const path = 'js/app.js';
let source = fs.readFileSync(path, 'utf8');

function findRange(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Missing ${name}`);
  const start = match.index;
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return { start, end: i + 1 };
  }
  throw new Error(`Unclosed ${name}`);
}

function replace(name, content) {
  const range = findRange(name);
  source = source.slice(0, range.start) + content + source.slice(range.end);
}

export { source, replace };
