/**
 * The release half of tests/support/e2e-lock.ts, as Playwright's globalTeardown.
 *
 * A file of its own because Playwright runs the DEFAULT export of the
 * globalTeardown module — pointing both options at the lock module made the
 * teardown re-run the setup, which then waited on its own lock for ever (and
 * every other run waited behind it). Found the first time two runs overlapped.
 */
import * as fs from 'fs';
import { LOCK_PATH, readHolder } from './e2e-lock';

export default async function globalTeardown() {
  if (process.env.E2E_NO_LOCK) return;
  const holder = readHolder();
  if (holder && holder.pid !== process.pid) return; // not ours — leave it
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {}
}
