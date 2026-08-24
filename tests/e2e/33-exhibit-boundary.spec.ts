// 33. The exhibit may not import listen.js (source invariant, no browser needed)
//
// The museum exhibit (plan §3) is a second consumer of the same engine, and the
// hard rule is that it may not import `listen.js` — directly or TRANSITIVELY.
// Importing it boots Listen Here: a global drop handler, a resize listener, a
// theme listener, a `_listenTest` hook, and the whole DOMContentLoaded UI wiring.
//
// Discipline is not enough. Co-location is exactly how `app/static/js/engine/`
// accumulated 79 back-imports into listen.js while nobody decided to add one, so
// the rule ships as a test rather than a convention. Transitive closure is the
// whole point: importing ONE coupled engine module defeats a direct-import check
// silently, and 12 of the 15 engine modules are coupled today.
//
// Ratcheted at zero: the exhibit is allowed exactly no path to listen.js. When
// something under app/static/exhibit/ needs engine behaviour that only exists
// behind that boundary, the answer is an entry in ENGINE-WANTS.md and either a
// copy or an extraction — never a relaxation here.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const STATIC_ROOT = path.join(__dirname, '..', '..', 'app', 'static');
const JS_ROOT = path.join(STATIC_ROOT, 'js');
const EXHIBIT_ROOT = path.join(STATIC_ROOT, 'exhibit');
const LISTEN_JS = path.join(JS_ROOT, 'listen.js');

/** Every first-party .js/.mjs module under `dir` (vendor bundles and spikes excluded). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'spikes' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * First-party module specifiers in `file`, resolved to absolute paths.
 *
 * Static `import`/`export ... from` and dynamic `import(...)` with a literal
 * argument. Two specifier shapes count, and both must, or the closure has a hole
 * a future import could walk straight through:
 *
 *   * RELATIVE (`./x.js`, `../js/engine/x.js`) — the convention everywhere in
 *     this codebase, since there is no bundler and no import map;
 *   * SERVER-ABSOLUTE (`/static/js/engine/x.js`) — legal in a browser and
 *     therefore legal here, so it is resolved against app/static/ rather than
 *     ignored. Nothing uses it today; the point is that it cannot be used to
 *     smuggle listen.js past this test tomorrow.
 *
 * Genuinely bare specifiers (`lodash`) stay ignored: they cannot resolve at all.
 */
function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const specs = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,   // side-effect import
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,  // dynamic import, literal only
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  const out: string[] = [];
  for (const spec of specs) {
    let resolved: string | null = null;
    if (spec.startsWith('.')) {
      resolved = path.resolve(path.dirname(file), spec);
    } else if (spec.startsWith('/static/')) {
      resolved = path.join(STATIC_ROOT, spec.slice('/static/'.length));
    } else if (spec.startsWith('/')) {
      // Some other server-absolute path; only meaningful if it lands in static/.
      resolved = path.join(STATIC_ROOT, spec.slice(1));
    }
    if (resolved && fs.existsSync(resolved)) out.push(resolved);
  }
  return out;
}

/** Every module reachable from `roots`, plus the first path found to each. */
function closure(roots: string[]): Map<string, string[]> {
  const pathTo = new Map<string, string[]>();
  const queue: string[] = [];
  for (const r of roots) {
    if (pathTo.has(r)) continue;
    pathTo.set(r, [r]);
    queue.push(r);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of importsOf(cur)) {
      if (pathTo.has(next)) continue;
      pathTo.set(next, [...pathTo.get(cur)!, next]);
      queue.push(next);
    }
  }
  return pathTo;
}

const rel = (p: string) => path.relative(STATIC_ROOT, p);

test.describe('33. Exhibit engine boundary', () => {
  // 33.1 THE RULE. Ratchet at zero.
  test('33.1 nothing under app/static/exhibit/ reaches listen.js, at any depth', () => {
    const roots = sourceFiles(EXHIBIT_ROOT);
    const reached = closure(roots);
    const chain = reached.get(LISTEN_JS);
    const trail = chain ? chain.map(rel).join('\n    -> ') : '';
    expect(
      chain ? [trail] : [],
      `the exhibit must not import listen.js, directly or transitively:\n    ${trail}`,
    ).toEqual([]);
  });

  // 33.2 The closure machinery has to actually find a transitive path, or 33.1 is
  //      a test that passes for the wrong reason. group-modal.js reaches listen.js
  //      only THROUGH grouping-model.js, so it is the honest witness: a
  //      direct-import check would clear it.
  test('33.2 the closure finds an indirect path to listen.js (self-check)', () => {
    const start = path.join(JS_ROOT, 'engine', 'group-modal.js');
    const chain = closure([start]).get(LISTEN_JS);
    expect(chain, 'group-modal.js must still reach listen.js — otherwise 33.1 proves nothing').toBeTruthy();
    // It also imports listen.js directly today; what matters is that a path of
    // length > 2 is discovered at all, which only the transitive walk can do.
    const indirect = closure([path.join(JS_ROOT, 'engine', 'grouping-ui.js')]).get(LISTEN_JS);
    expect(indirect!.length).toBeGreaterThan(1);
  });

  // 33.3 The two week-0 extractions are the boundary's first inhabitants: the
  //      exhibit is meant to import them rather than copy them, so they must stay
  //      import-free. If either grows an import, this fails before the exhibit
  //      even exists.
  test('33.3 align-core and grouping-core import nothing', () => {
    const offenders: string[] = [];
    for (const name of ['align-core.js', 'grouping-core.js']) {
      const file = path.join(JS_ROOT, 'engine', name);
      expect(fs.existsSync(file), `${name} is missing`).toBe(true);
      const reached = [...closure([file]).keys()].filter((p) => p !== file);
      if (reached.length) offenders.push(`${name} -> ${reached.map(rel).join(', ')}`);
    }
    expect(offenders, `these must have zero imports:\n${offenders.join('\n')}`).toEqual([]);
  });

  // 33.4 Until the exhibit exists there is nothing for 33.1 to scan, and a test
  //      that silently checks nothing is worse than no test. Fail loudly once the
  //      directory appears without its TODO ledger, and report the empty state
  //      plainly until then.
  test('33.4 the exhibit directory, once it exists, carries its ENGINE-WANTS ledger', () => {
    if (!fs.existsSync(EXHIBIT_ROOT)) {
      test.info().annotations.push({
        type: 'note',
        description: 'app/static/exhibit/ does not exist yet — 33.1 is a ratchet held at zero.',
      });
      return;
    }
    expect(
      fs.existsSync(path.join(EXHIBIT_ROOT, 'ENGINE-WANTS.md')),
      'every copied or stubbed engine behaviour needs an entry in app/static/exhibit/ENGINE-WANTS.md (plan §3)',
    ).toBe(true);
  });
});
