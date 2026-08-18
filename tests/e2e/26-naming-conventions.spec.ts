// 26. Naming conventions (source invariant, no browser needed)
//
// The `_` prefix in this codebase means "not exported". It is a module-privacy
// marker, so an exported `_name` is a contradiction: readers take the prefix as
// "don't touch this from outside", while an export says the opposite. This test
// keeps the rule true — it is the enforcement for the repo-wide de-prefixing of
// exported names, so the ambiguity cannot creep back in one convenient export at
// a time.
//
// If you need to expose a `_name`, drop the prefix in the same commit.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const JS_ROOT = path.join(__dirname, '..', '..', 'app', 'static', 'js');

/** Every first-party .js module (vendor bundles and throwaway spikes excluded). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'spikes') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test.describe('26. Naming conventions', () => {
  // 26.1 no exported name carries the module-private prefix
  test('26.1 no exported identifier starts with an underscore', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(JS_ROOT)) {
      const rel = path.relative(JS_ROOT, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // export const/let/var/function/async function _name
        if (/^export\s+(?:const|let|var|function|async function)\s+_/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
        // export { _name, ... } re-export lists
        const reexport = line.match(/^export\s*\{([^}]*)\}/);
        if (reexport && /(^|[\s,])_[A-Za-z]/.test(reexport[1])) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `exported names must not start with "_":\n${offenders.join('\n')}`).toEqual([]);
  });
});
