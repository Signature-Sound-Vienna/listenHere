/**
 * One suite at a time, machine-wide.
 *
 * Two checkouts of this repo (a main checkout and a git worktree, each with
 * its own Flask port) can run the suite independently — but not at the same
 * time on one machine: two suites flake the timing specs (35, 37, the fix-mode
 * audition) and stretch a run from ~12 to ~16 minutes. Rather than asking two
 * people (or two Claude sessions) to coordinate, the runner takes a lock.
 *
 * Wired as Playwright's globalSetup (this file) and globalTeardown
 * (tests/support/e2e-unlock.ts — a separate file, because Playwright runs the
 * DEFAULT export of each): setup waits until it can create the lock file in
 * the user's temp folder — the same folder for every session on the machine —
 * and writes its PID into it; teardown removes it. A run that dies hard leaves
 * its lock behind, so a lock whose PID is no longer alive counts as free, and
 * so does one this very process already holds. While waiting, a line every
 * 15 s says whose PID is holding the lock. E2E_NO_LOCK=1 bypasses it (a quick
 * single-spec check while a suite runs elsewhere — at your own risk).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const LOCK_PATH = path.join(os.tmpdir(), 'listen-here-e2e.lock');
const POLL_MS = 2_000;
const REPORT_EVERY_MS = 15_000;
const MAX_WAIT_MS = 45 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // alive, someone else's — still a holder
  }
}

export function readHolder(): { pid: number; tree: string; since: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    return typeof raw?.pid === 'number' ? raw : null;
  } catch {
    return null;
  }
}

function tryAcquire(): boolean {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx'); // atomic: fails if it exists
    fs.writeSync(
      fd,
      JSON.stringify({ pid: process.pid, tree: process.cwd(), since: new Date().toISOString() }),
    );
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalSetup() {
  if (process.env.E2E_NO_LOCK) return;
  const t0 = Date.now();
  let lastReport = 0;
  for (;;) {
    if (tryAcquire()) return;
    const holder = readHolder();
    if (holder && holder.pid === process.pid) return; // ours already
    if (holder && !pidAlive(holder.pid)) {
      // A dead holder: the lock is stale (a crashed or killed run). Take it.
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {}
      continue;
    }
    if (!holder) {
      // Unreadable lock (mid-write, or garbage): give it a moment, then retry.
      await sleep(POLL_MS);
      continue;
    }
    const waited = Date.now() - t0;
    if (waited > MAX_WAIT_MS) {
      throw new Error(
        `e2e lock: gave up after ${Math.round(waited / 60_000)} min — pid ${holder.pid} ` +
          `(${holder.tree}, since ${holder.since}) still holds ${LOCK_PATH}. ` +
          `Remove the file if that run is gone, or set E2E_NO_LOCK=1.`,
      );
    }
    if (Date.now() - lastReport > REPORT_EVERY_MS) {
      lastReport = Date.now();
      console.log(
        `e2e lock: another suite is running (pid ${holder.pid}, ${holder.tree}, ` +
          `since ${holder.since}) — waiting ${Math.round(waited / 1000)} s so far…`,
      );
    }
    await sleep(POLL_MS);
  }
}
