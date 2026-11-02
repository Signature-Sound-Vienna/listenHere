import { type Page } from '@playwright/test';
import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 22 — Annotation editor: selection-group re-pinning
// ---------------------------------------------------------------------------
// The V6 annotation editor lets you adopt ("re-pin") the current application
// grouping into an existing annotation, behind a diff-confirmation dialog, and
// recover notes whose group left the pinned set. Editing is not Solid-gated, so
// these run in the functional project. Driven entirely through the editor UI;
// state is only read back (window.__annotationV6) for assertions.

/** Open the Group Recordings modal. */
async function openGroupModal(page: Page) {
  await page.evaluate(() => (document.getElementById('group-files-btn') as HTMLElement).click());
  await page.waitForSelector('.gm-modal', { state: 'visible' });
}

/** Add a group (named `name`) and pull `filenameTerm` into it via add-by-filename. */
async function addGroup(page: Page, idx: number, name: string, filenameTerm: string) {
  await page.locator('.gm-add-group').click();
  const card = page.locator('.gm-group-card').nth(idx);
  await card.locator('.gm-group-name').fill(name);
  await card.locator('.gm-addby-input').fill(filenameTerm);
  await card.locator('.gm-addby-btn').click();
}

/** Create two groups (Alpha→audio-a, Beta→audio-b) and apply them. */
async function setupTwoGroups(page: Page) {
  await openGroupModal(page);
  await addGroup(page, 0, 'Alpha', 'audio-a');
  await addGroup(page, 1, 'Beta', 'audio-b');
  await page.locator('.gm-apply').click();
  await page.waitForSelector('.gm-modal', { state: 'detached' });
}

/** Create a new annotation (pins the current grouping) and return its id. */
async function newAnnotation(page: Page): Promise<string> {
  await page.locator('.lh-v6-ribbon-new').click();
  await page.waitForSelector('.lh-v6-group-repin');
  return page.evaluate(() => (window as any).__annotationV6.state.getActiveId());
}

const pinnedLabels = (page: Page, id: string) =>
  page.evaluate(
    (annId) =>
      (window as any).__annotationV6.state
        .getById(annId)
        .pinnedGrouping.groups.map((g: any) => g.label),
    id,
  );

test.describe('22. Annotation editor — group re-pinning', () => {

  // 22.1 Re-pin button reflects the diff; cancel keeps, confirm adopts
  test('22.1 re-pin button enables on grouping change; cancel vs. confirm', async ({ loadedPage: page }) => {
    await setupTwoGroups(page);
    const annId = await newAnnotation(page);

    // Freshly pinned to the current view → nothing to update.
    await expect(page.locator('.lh-v6-group-repin')).toBeDisabled();
    expect(await pinnedLabels(page, annId)).toEqual(['Alpha', 'Beta']);

    // Rename Beta → Gamma in the modal and apply.
    await openGroupModal(page);
    await page.locator('.gm-group-card').nth(1).locator('.gm-group-name').fill('Gamma');
    await page.locator('.gm-apply').click();
    await page.waitForSelector('.gm-modal', { state: 'detached' });

    // The editor re-renders on lh-grouping-changed → re-pin is now enabled.
    await expect(page.locator('.lh-v6-group-repin')).toBeEnabled();

    // Open the diff dialog; it lists the rename. Cancel leaves the pin intact.
    await page.locator('.lh-v6-group-repin').click();
    await expect(page.locator('.lh-v6-confirm-overlay')).toBeVisible();
    await expect(page.locator('.lh-v6-repin-line.renamed')).toContainText('Gamma');
    await page.locator('.lh-v6-confirm-cancel').click();
    await expect(page.locator('.lh-v6-confirm-overlay')).toHaveCount(0);
    expect(await pinnedLabels(page, annId)).toEqual(['Alpha', 'Beta']);

    // Re-open and confirm → the new grouping is adopted (note kept by groupId).
    await page.locator('.lh-v6-group-repin').click();
    await page.locator('.lh-v6-confirm-ok').click();
    await expect(page.locator('.lh-v6-confirm-overlay')).toHaveCount(0);
    expect(await pinnedLabels(page, annId)).toEqual(['Alpha', 'Gamma']);
    // Matches again → button disables.
    await expect(page.locator('.lh-v6-group-repin')).toBeDisabled();
  });

  // 22.2 A note on a removed group detaches, is recoverable, and can be discarded
  test('22.2 note on a removed group detaches and can be discarded', async ({ loadedPage: page }) => {
    await setupTwoGroups(page);
    const annId = await newAnnotation(page);

    // Attach audio-a to the annotation by clicking its waveform (edit mode).
    await page.evaluate((f) => {
      const wf = document.querySelector(`.waveform[data-ix='${f}']`);
      wf?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, AUDIO_A);
    await page.waitForFunction(
      (id) => (window as any).__annotationV6.state.getById(id).targets.length > 0,
      annId,
    );

    // Group Alpha's note is now enabled — write a note into it.
    const alphaNote = page.locator('.lh-v6-group-note-textarea:not([disabled])');
    await expect(alphaNote).toBeVisible();
    await alphaNote.fill('alpha group note');
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            Object.values((window as any).__annotationV6.state.getById(id).groupNotes),
          annId,
        ),
      )
      .toContain('alpha group note');

    // Delete the Alpha group, sending audio-a back to ungrouped.
    await openGroupModal(page);
    await page.locator('.gm-group-card').nth(0).locator('.gm-icon-btn.gm-delete').click();
    await page.locator('.gm-apply').click();
    await page.waitForSelector('.gm-modal', { state: 'detached' });

    // Re-pin: the diff flags the departing group + its note moving.
    await expect(page.locator('.lh-v6-group-repin')).toBeEnabled();
    await page.locator('.lh-v6-group-repin').click();
    await expect(page.locator('.lh-v6-repin-line.removed')).toContainText('Alpha');
    await page.locator('.lh-v6-confirm-ok').click();

    // The note now lives in the recoverable "removed groups" strip.
    await expect(page.locator('.lh-v6-detached')).toBeVisible();
    await expect(page.locator('.lh-v6-detached-text')).toContainText('alpha group note');
    expect(await pinnedLabels(page, annId)).toEqual(['Beta']);

    // Expand the (collapsed) recovery strip, then discard the note (confirm
    // dialog) → the strip empties.
    await page.locator('.lh-v6-detached-summary').click();
    page.once('dialog', (d) => d.accept());
    await page.locator('.lh-v6-detached-discard').click();
    await expect(page.locator('.lh-v6-detached-tile')).toHaveCount(0);
  });

});
