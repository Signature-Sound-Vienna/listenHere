import { test, expect, type Page } from '@playwright/test';
import { ALIGNMENT_OVERLAP, ALIGNMENT_JSON } from '../support/fixtures';
import { loadLocalAlignment } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 32 — One group per recording, per grouping context (roadmap item U)
//
// Within one grouping context — a tab, or an annotation's pinned grouping — a
// recording belongs to exactly ONE group. Switching context may change which
// one; that is what tabs are for. Two groups claiming it inside one context is
// a defect in the alignment file, repaired at load with a warning.
//
// This used to be answered independently in six places, and they disagreed:
// row creation took the FIRST matching group, the tab switch took the LAST, and
// the sidebar, the container builder, the annotation snapshot, and the tempo
// scope each listed a recording under EVERY group it matched. The visible
// consequences were a group container that existed but stayed empty while its
// badge claimed a recording, and a row that changed group on a tab round-trip.
//
// The fixture's active tab is deliberately defective: "First" and "Second" both
// list audio-b.mp3 explicitly, and "Pattern" claims audio-b.mp3 AND the score by
// regex. Its second tab is clean and gives audio-b.mp3 to a different group.
// ---------------------------------------------------------------------------

/** Group containers in the content pane, in DOM order, with badge and rows. */
const containers = (page: Page) =>
  page.evaluate(() =>
    [...document.getElementById('waveforms')!.querySelectorAll('.file-group')].map((fg) => ({
      group: (fg as HTMLElement).dataset.group,
      badge: fg.querySelector('.group-count')?.textContent ?? '',
      rows: [...fg.querySelectorAll('.waveform')].map((w) => (w as HTMLElement).dataset.ix),
    })),
  );

/** Which group container currently holds `file`'s row. */
const groupOf = (page: Page, file: string) =>
  page.evaluate(
    (f) =>
      (
        document
          .querySelector(`#waveforms .waveform[data-ix="${CSS.escape(f)}"]`)
          ?.closest('.file-group') as HTMLElement | null
      )?.dataset.group ?? null,
    file,
  );

/** Sidebar fieldset legends paired with the recordings listed under each. */
const sidebar = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#audios fieldset.audio-group')].map((fs) => ({
      legend: fs.querySelector('legend')?.textContent?.replace(/[▾☰\s]+$/, '') ?? '',
      files: [...fs.querySelectorAll('input[type=checkbox]')].map((cb) => (cb as HTMLInputElement).value),
    })),
  );

async function loadOverlap(page: Page) {
  await loadLocalAlignment(page, ALIGNMENT_OVERLAP);
  await page.waitForFunction(() => ((window as any)._listenTest?.loadGeneration ?? 0) > 0, null, {
    timeout: 40_000,
  });
}

/**
 * Dismiss the load-time overlap warning so it stops covering the pane.
 *
 * Deliberately tolerant of the dialog being absent. 32.1 is what asserts it
 * appears; if this helper insisted on it, every test below would fail on the
 * missing dialog rather than on the membership claim it is actually guarding,
 * which would make their fail-before prove nothing.
 */
async function dismissWarning(page: Page) {
  const dialog = page.locator('.lh-v6-confirm-dialog');
  if (!(await dialog.count())) return;
  await dialog.locator('.lh-v6-confirm-ok').click();
  await expect(dialog).toHaveCount(0);
}

test.describe('32. One group per recording', () => {

  // 32.1 The load-time repair is reported, not silent.
  test('32.1 overlapping group membership raises a warning naming the recording', async ({ page }) => {
    await loadOverlap(page);
    const dialog = page.locator('.lh-v6-confirm-dialog');
    await expect(dialog).toBeVisible();
    const text = await dialog.innerText();
    // Names the recording, every group that over-claimed it, and the one kept.
    expect(text).toContain('audio-b.mp3');
    expect(text).toContain('Second');
    expect(text).toContain('Pattern');
    expect(text).toContain('First');
    // Acknowledgement, not a choice: one button, and a red danger indicator.
    await expect(dialog).toHaveClass(/lh-v6-confirm-danger/);
    await expect(dialog.locator('.lh-v6-confirm-cancel')).toHaveCount(0);
    await expect(dialog.locator('.lh-v6-confirm-ok')).toHaveCount(1);
  });

  // 32.2 A clean alignment must not raise it. Guards against a check that
  // fires on any grouping at all rather than on genuine overlap.
  test('32.2 a non-overlapping alignment raises no warning', async ({ page }) => {
    await loadLocalAlignment(page, ALIGNMENT_JSON);
    await page.waitForFunction(() => ((window as any)._listenTest?.loadGeneration ?? 0) > 0, null, {
      timeout: 40_000,
    });
    await expect(page.locator('.lh-v6-confirm-dialog')).toHaveCount(0);
  });

  // 32.3 The repair reaches the saved data: the losing groups no longer list
  // the recording. The pattern claim survives — a regex cannot have one
  // filename edited out of it without expanding it.
  test('32.3 the losing groups lose their explicit claim; the pattern is left alone', async ({ page }) => {
    await loadOverlap(page);
    await dismissWarning(page);
    const groups = await page.evaluate(() => (window as any)._listenTest.groupingTabs[0].fileGroups);
    expect(groups.find((g: any) => g.name === 'First').files).toContain('audio-b.mp3');
    expect(groups.find((g: any) => g.name === 'Second').files).not.toContain('audio-b.mp3');
    expect(groups.find((g: any) => g.name === 'Pattern').pattern).toBe('^(audio-b|Score)');
    // The other tab is a different context and must be untouched.
    const clean = await page.evaluate(() => (window as any)._listenTest.groupingTabs[1].fileGroups);
    expect(clean[0].files).toEqual(['audio-b.mp3']);
  });

  // 32.4 No phantom container. "Pattern" matches only audio-b.mp3 (which goes
  // to "First") and the score (never groupable), so it has no members and must
  // not get a container at all. Before the fix it got one, whose badge read
  // (0/2) for good.
  test('32.4 a group left with no members gets no container and no lying badge', async ({ page }) => {
    await loadOverlap(page);
    await dismissWarning(page);
    const found = await containers(page);
    expect(found.map((c) => c.group)).toEqual(['Score', 'First', 'Second', 'Ungrouped']);
    // Every badge's numerator matches its row count — the two used to be
    // computed from different membership models.
    for (const c of found) {
      if (c.group === 'Score') continue;
      expect(c.badge, `badge for ${c.group}`).toBe(`(${c.rows.length}/${c.rows.length})`);
    }
  });

  // 32.5 The sidebar agrees with the pane: one fieldset per recording.
  test('32.5 the sidebar lists each recording under exactly one group', async ({ page }) => {
    await loadOverlap(page);
    await dismissWarning(page);
    const groups = await sidebar(page);
    const all = groups.flatMap((g) => g.files).filter((f) => f !== 'Score (synthesised from MEI)');
    expect(all.length).toBe(new Set(all).size);
    expect(groups.find((g) => g.legend === 'First')!.files).toContain('audio-b.mp3');
    expect(groups.find((g) => g.legend === 'Second')!.files).not.toContain('audio-b.mp3');
  });

  // 32.6 The regression that named the issue: a tab round-trip must not move a
  // row. Row creation took the first matching group, the tab switch the last,
  // so audio-b.mp3 changed group each way.
  test('32.6 switching grouping tabs and back leaves the row where it was', async ({ page }) => {
    await loadOverlap(page);
    await dismissWarning(page);
    expect(await groupOf(page, 'audio-b.mp3')).toBe('First');

    const pill = (name: string) => page.locator('#grouping-tab-pills .gt-pill', { hasText: name }).first();
    await pill('Clean').click();
    await expect.poll(() => groupOf(page, 'audio-b.mp3')).toBe('Only B');

    await pill('Overlapping').click();
    await expect.poll(() => groupOf(page, 'audio-b.mp3')).toBe('First');
  });

  // 32.7 The score row is not groupable. "Pattern" matches it by regex, and it
  // must still be in the Score container — the row-creation path used to let a
  // matching group override that, while the tab-switch path never did.
  test('32.7 a pattern matching the score does not pull it out of the Score group', async ({ page }) => {
    await loadOverlap(page);
    await dismissWarning(page);
    await expect(page.locator('.file-group-score .group-list .waveform')).toHaveCount(1);
    expect(await groupOf(page, 'Score (synthesised from MEI)')).toBe('Score');

    // Also across a tab round-trip, which resolves placement separately.
    const pill = (name: string) => page.locator('#grouping-tab-pills .gt-pill', { hasText: name }).first();
    await pill('Clean').click();
    await expect.poll(() => groupOf(page, 'Score (synthesised from MEI)')).toBe('Score');
    await pill('Overlapping').click();
    await expect.poll(() => groupOf(page, 'Score (synthesised from MEI)')).toBe('Score');
  });

  // 32.8 The membership an annotation pins is single-valued too — it is
  // persisted, so a recording under two groups there outlives the session.
  test('32.8 the pinned grouping snapshot puts each recording in one group', async ({ page }) => {
    await loadOverlap(page);
    await dismissWarning(page);
    const snap = await page.evaluate(() => (window as any)._listenTest.activeGroupingSnapshot);
    const all = snap.groups.flatMap((g: any) => g.files);
    expect(all.length).toBe(new Set(all).size);
    expect(snap.groups.find((g: any) => g.label === 'First').files).toContain('audio-b.mp3');
    expect(snap.groups.find((g: any) => g.label === 'Second').files).not.toContain('audio-b.mp3');
    // Never the score, whatever a pattern says.
    expect(all).not.toContain('Score (synthesised from MEI)');
  });

});
