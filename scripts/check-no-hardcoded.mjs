#!/usr/bin/env node
// Lint rule from the TRACE Field spec: no hardcoded measurement in UI strings.
// Every number a judge sees must load from /data/case.json or /data/manifest.json.
// This flags dB / hectare literals in src/ outside the data layer and comments.
import { readFileSync, readdirSync } from 'node:fs';

let bad = 0;
for (const f of readdirSync('src')) {
  if (!/\.(ts|tsx)$/.test(f) || f === 'data.ts') continue;
  const lines = readFileSync(`src/${f}`, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/(-?\d+(\.\d+)?\s*dB|\d+(\.\d+)?\s*ha\b)/.test(code) && !/grid|canvas|width|height/i.test(code)) {
      // allow unit labels with no value, e.g. "— dB", and the {value} dB interpolations
      if (/\d\s*dB/.test(code) && !code.includes('} dB')) { console.log(`${f}:${i + 1}: ${line.trim()}`); bad++; }
    }
  });
}
if (bad) { console.error(`FAIL: ${bad} hardcoded measurement(s)`); process.exit(1); }
console.log('OK: no hardcoded measurements in UI strings');
