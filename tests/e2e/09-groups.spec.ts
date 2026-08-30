import { type Page } from '@playwright/test';
import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';
import { htmlDragTo } from '../support/helpers';

// ---------------------------------------------------------------------------
// Section 9 — Recording Groups (sidebar + Group Recordings modal)
// ---------------------------------------------------------------------------

/** Open the Group Recordings modal and wait for it to render. */
async function openGroupModal(page: Page) {
  await page.evaluate(() => (document.getElementById('group-files-btn') as HTMLElement).click());
  await page.waitForSelector('.gm-modal', { state: 'visible' });
}

/** Selector for an ungrouped recording row by its full filename key. */
const ung = (f: string) => `#gm-ungrouped li.gm-file-item[data-file="${f}"]`;
/** Real (non-preview) members of the first group card. */
const GROUP_MEMBERS = '.gm-group-card .gm-group-files li.gm-grouped:not(.gm-preview):not(.gm-drag-preview)';

test.describe('9. Recording Groups', () => {

  // 9.1 Default grouping — ungrouped recordings + separate score
  test('9.1 default grouping shows ungrouped recordings and separate score', async ({ listenPage: page }) => {
    const scoreSection = await page.evaluate(() => {
      const scoreCheckbox = document.querySelector('input[value="Score (synthesised from MEI)"]');
      if (!scoreCheckbox) return null;
      const fieldset = scoreCheckbox.closest('fieldset');
      return fieldset?.querySelector('legend')?.textContent?.trim() ?? null;
    });
    expect(scoreSection).toBeTruthy();

    const recordingFieldsets = await page.evaluate(() => {
      const checkboxes = document.querySelectorAll('#audios input[type="checkbox"]');
      const fieldsets = new Set<string>();
      checkboxes.forEach(cb => {
        const val = (cb as HTMLInputElement).value;
        if (val === 'Score (synthesised from MEI)') return;
        const fs = cb.closest('fieldset');
        const legend = fs?.querySelector('legend')?.textContent?.trim();
        if (legend) fieldsets.add(legend);
      });
      return [...fieldsets];
    });
    expect(recordingFieldsets.length).toBeGreaterThanOrEqual(1);
  });

  // 9.8 Group All/None buttons in the content pane
  test('9.8 group All/None buttons show and hide waveforms', async ({ loadedPage: page }) => {
    const allBtn = page.locator('#waveforms .group-all').first();
    await allBtn.click();
    await page.waitForTimeout(1000);
    const visibleAfterAll = await page.locator('#waveforms .waveform:not([style*="display: none"])').count();
    expect(visibleAfterAll).toBeGreaterThanOrEqual(2);

    const noneBtn = page.locator('#waveforms .group-none').first();
    await noneBtn.click();
    await page.waitForTimeout(500);
    const visibleAfterNone = await page.locator('#waveforms .waveform:not([style*="display: none"])').count();
    expect(visibleAfterNone).toBeLessThan(visibleAfterAll);
  });

  // -------------------------------------------------------------------------
  // Group Recordings modal
  // -------------------------------------------------------------------------

  // 9.2 Modal opens with the renamed title and lists ungrouped recordings
  test('9.2 Group Recordings modal opens and lists ungrouped recordings', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await expect(page.locator('.gm-header h3')).toHaveText('Group Recordings');
    await expect(page.locator('.gm-left h4')).toHaveText('Ungrouped Recordings');
    // All four fixture recordings start ungrouped.
    expect(await page.locator('#gm-ungrouped li.gm-file-item').count()).toBe(4);
  });

  // 9.2b Modal height is locked to ~85% of the viewport (no jumping)
  test('9.2b modal height is fixed at ~85vh', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    const ratio = await page.evaluate(() => {
      const h = document.querySelector('.gm-modal')!.getBoundingClientRect().height;
      return h / window.innerHeight;
    });
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(0.9);
  });

  // 9.3 Multi-select: plain / ctrl / shift click semantics
  test('9.3 multi-select of ungrouped recordings (click / ctrl / shift)', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    const items = page.locator('#gm-ungrouped li.gm-file-item');
    const files = await items.evaluateAll(els => els.map(e => (e as HTMLElement).dataset.file));

    // Plain click selects exactly one.
    await page.locator(ung(files[0]!)).click();
    expect(await page.locator('#gm-ungrouped .gm-selected').count()).toBe(1);

    // Ctrl-click adds a second.
    await page.locator(ung(files[1]!)).click({ modifiers: ['ControlOrMeta'] });
    expect(await page.locator('#gm-ungrouped .gm-selected').count()).toBe(2);

    // Shift-click extends a range from the anchor (item 1) to item 3.
    await page.locator(ung(files[3]!)).click({ modifiers: ['Shift'] });
    expect(await page.locator('#gm-ungrouped .gm-selected').count()).toBeGreaterThanOrEqual(3);

    // Plain click collapses back to a single selection.
    await page.locator(ung(files[0]!)).click();
    expect(await page.locator('#gm-ungrouped .gm-selected').count()).toBe(1);
  });

  // 9.4 Add by filename (substring) with live preview
  test('9.4 add-by-filename adds matching recordings with live preview', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    const input = page.locator('.gm-group-card .gm-addby-input');
    await input.fill('audio-a');
    // Live greyed-out preview appears before committing.
    await expect(page.locator('.gm-group-card li.gm-preview')).toHaveCount(1);
    await page.locator('.gm-group-card .gm-addby-btn').click();
    // Committed as a real member; removed from the ungrouped pane.
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(1);
    await expect(page.locator(ung(AUDIO_A))).toHaveCount(0);
  });

  // 9.5 Regex toggle: persistence + invalid-pattern indication
  test('9.5 regex toggle persists and flags invalid patterns', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    await page.locator('.gm-apply').click(); // persist the empty group
    await page.waitForSelector('.gm-modal', { state: 'detached' });

    // Reopen: toggle defaults off, then enable it.
    await openGroupModal(page);
    const toggle = page.locator('.gm-group-card .gm-regex-toggle').first();
    await expect(toggle).not.toHaveClass(/gm-active/);
    await toggle.click();
    await expect(toggle).toHaveClass(/gm-active/);
    expect(await page.evaluate(() => localStorage.getItem('listenTool_addByRegex'))).toBe('1');

    // Invalid regex flags the input.
    await page.locator('.gm-group-card .gm-addby-input').fill('(');
    await expect(page.locator('.gm-group-card .gm-addby-input')).toHaveClass(/gm-invalid/);

    // Close (no group changes) and reopen — preference is remembered.
    await page.locator('#group-modal-backdrop').click({ position: { x: 5, y: 5 } });
    await page.waitForSelector('.gm-modal', { state: 'detached' });
    await openGroupModal(page);
    await expect(page.locator('.gm-group-card .gm-regex-toggle').first()).toHaveClass(/gm-active/);
  });

  // 9.6 Remove a recording from a group via its ✕
  test('9.6 remove recording from a group returns it to ungrouped', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    await page.locator('.gm-group-card .gm-addby-input').fill('audio-a');
    await page.locator('.gm-group-card .gm-addby-btn').click();
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(1);

    await page.locator('.gm-group-card .gm-remove-file').click();
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(0);
    await expect(page.locator(ung(AUDIO_A))).toHaveCount(1);
  });

  // 9.9 Unapplied-changes guard on dismissal
  test('9.9 dismissing with unapplied changes prompts; clean dismiss closes', async ({ loadedPage: page }) => {
    // Clean dismiss: no changes → backdrop click closes immediately.
    await openGroupModal(page);
    await page.locator('#group-modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.gm-modal')).toHaveCount(0);

    // With changes: backdrop click raises the confirm overlay.
    await openGroupModal(page);
    await page.locator('.gm-add-group').click(); // mutate modal state
    await page.locator('#group-modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.gm-confirm-overlay')).toBeVisible();

    // "Keep editing" dismisses the prompt but leaves the modal open.
    await page.locator('.gm-confirm-overlay .gm-confirm-buttons button', { hasText: 'Keep editing' }).click();
    await expect(page.locator('.gm-confirm-overlay')).toHaveCount(0);
    await expect(page.locator('.gm-modal')).toBeVisible();

    // Esc also triggers the guard; Discard then throws the work away.
    await page.keyboard.press('Escape');
    await expect(page.locator('.gm-confirm-overlay')).toBeVisible();
    await page.locator('.gm-confirm-discard').click();
    await expect(page.locator('.gm-modal')).toHaveCount(0);
  });

  // 9.10 Drag an ungrouped recording into a group card
  test('9.10 drag a recording into a group', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    await htmlDragTo(page, ung(AUDIO_A), '.gm-group-card');
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(1);
    await expect(page.locator(ung(AUDIO_A))).toHaveCount(0);
  });

  // 9.10b Drag a multi-selection into a group in one gesture
  test('9.10b drag a multi-selection into a group', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    await page.locator(ung(AUDIO_A)).click();
    await page.locator(ung(AUDIO_B)).click({ modifiers: ['ControlOrMeta'] });
    await htmlDragTo(page, ung(AUDIO_A), '.gm-group-card');
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(2);
  });

  // 9.11 Drag a recording from one group to another
  test('9.11 drag a recording between groups', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    await page.locator('.gm-add-group').click();
    // Put audio-a in the first group, then drag it into the second.
    await htmlDragTo(page, ung(AUDIO_A), '.gm-group-card:nth-of-type(1)');
    await expect(page.locator('.gm-group-card:nth-of-type(1) .gm-group-files li.gm-grouped')).toHaveCount(1);
    await htmlDragTo(page,
      '.gm-group-card:nth-of-type(1) .gm-group-files li.gm-grouped',
      '.gm-group-card:nth-of-type(2)');
    await expect(page.locator('.gm-group-card:nth-of-type(1) .gm-group-files li.gm-grouped')).toHaveCount(0);
    await expect(page.locator('.gm-group-card:nth-of-type(2) .gm-group-files li.gm-grouped')).toHaveCount(1);
  });

  // 9.12 Drag a recording back out to the ungrouped pane
  test('9.12 drag a recording back to the ungrouped pane', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    await htmlDragTo(page, ung(AUDIO_A), '.gm-group-card');
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(1);
    await htmlDragTo(page, '.gm-group-card .gm-group-files li.gm-grouped', '.gm-left');
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(0);
    await expect(page.locator(ung(AUDIO_A))).toHaveCount(1);
  });

  // 9.13 Drag onto the dashed target to create a new group
  test('9.13 drag-to-create a new group', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    // No groups yet — the dropzone is the empty state.
    await expect(page.locator('.gm-group-card')).toHaveCount(0);
    await htmlDragTo(page, ung(AUDIO_A), '.gm-newgroup-dropzone');
    await expect(page.locator('.gm-group-card')).toHaveCount(1);
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(1);
  });

  // 9.14 Hover preview while dragging over a group (no drop)
  test('9.14 dragging over a group previews the would-be member', async ({ loadedPage: page }) => {
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    // dragstart + dragover only — no drop, no dragend.
    await htmlDragTo(page, ung(AUDIO_A), '.gm-group-card', { fireDrop: false, fireDragEnd: false });
    await expect(page.locator('.gm-group-card li.gm-drag-preview')).toHaveCount(1);
    // It is a preview, not a real member.
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(0);
    // Ending the drag clears the preview.
    await page.evaluate(() => {
      const src = document.querySelector('#gm-ungrouped li.gm-file-item');
      src?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    });
    await expect(page.locator('.gm-group-card li.gm-drag-preview')).toHaveCount(0);
  });

  // 9.15 Group container order in the content pane is owned by
  // ensureWaveformGroupContainers alone: Score first, then named groups, then
  // Ungrouped. It used to be re-scrambled by a vestigial re-sort at the end of
  // prepareWaveform, whose comparator reversed the (id-less) container divs on
  // every row creation — so the Score group rendered LAST for any odd number of
  // rows, which the default fixture (4 recordings + score = 5) hits.
  test('9.15 Score group container renders above the recordings', async ({ loadedPage: page }) => {
    const containers = await page.evaluate(() =>
      [...document.getElementById('waveforms')!.children]
        .filter((n) => n.classList.contains('file-group'))
        .map((n) => (n as HTMLElement).dataset.group),
    );
    expect(containers).toEqual(['Score', 'Ungrouped']);
    // …and the score row really is inside the Score container, not merely
    // parented somewhere that happens to sort first.
    await expect(page.locator('.file-group-score .group-list .waveform')).toHaveCount(1);
  });

  // 9.16 A coloured group card is legible in dark mode.
  // The group colour palette is a fixed set of pale pastels that ignores the
  // active theme, so the theme's own text variables are wrong inside a coloured
  // card: in dark mode `--color-text` is near-white (#f1f5f9), and the filenames
  // it painted were invisible on the pastel. The fix hands the card's computed
  // contrast colour to its text via `.gm-has-colour`. Asserting a real contrast
  // ratio rather than an expected colour keeps this about legibility, so it
  // still holds if the palette or the contrast helper changes.
  test('9.16 filenames in a coloured group card stay legible in dark mode', async ({ loadedPage: page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await openGroupModal(page);
    await page.locator('.gm-add-group').click();
    await page.locator('.gm-group-card .gm-addby-input').fill('audio-a');
    await page.locator('.gm-group-card .gm-addby-btn').click();
    await expect(page.locator(GROUP_MEMBERS)).toHaveCount(1);

    // Give the card a colour from the palette, then measure the member row.
    await page.locator('.gm-group-card .gm-swatch').first().click();
    await expect(page.locator('.gm-group-card')).toHaveClass(/gm-has-colour/);

    const ratio = await page.locator(GROUP_MEMBERS).first().evaluate((li) => {
      // Walk up for the nearest non-transparent background, as the row itself
      // is transparent and sits on the card.
      const chan = (c: string) => {
        const v = parseInt(c, 10) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const lum = (rgb: string) => {
        const [r, g, b] = rgb.match(/\d+/g)!;
        return 0.2126 * chan(r!) + 0.7152 * chan(g!) + 0.0722 * chan(b!);
      };
      let bgEl: HTMLElement | null = li as HTMLElement;
      let bg = 'rgba(0, 0, 0, 0)';
      while (bgEl) {
        const c = getComputedStyle(bgEl).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
        bgEl = bgEl.parentElement;
      }
      const l1 = lum(getComputedStyle(li).color);
      const l2 = lum(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    });

    // WCAG AA for body text. Before the fix this was ~1.1 (near-white on pastel).
    expect(ratio).toBeGreaterThan(4.5);
  });

  // 9.17 Semantic buttons keep their colour in a non-light theme.
  // `[data-theme] button:not(…)` in default.css takes ID-level specificity from
  // the id inside its `:not()`, so it beat every class-based button rule: in any
  // non-light theme all twelve Group Recordings buttons flattened to the same
  // grey, and Discard and the group-delete ✕ lost their danger red. Apply had
  // survived only by carrying `!important`. The rule now excludes
  // `.gm-modal button`. Asserting "Discard is not the neutral button colour"
  // tests the reported symptom — marked in light, unmarked in dark — while also
  // pinning it to the theme's own danger colour.
  test('9.17 Discard stays marked as dangerous in dark mode', async ({ loadedPage: page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await openGroupModal(page);
    await page.locator('.gm-add-group').click(); // make the modal dirty
    await page.keyboard.press('Escape');
    await expect(page.locator('.gm-confirm-overlay')).toBeVisible();

    const seen = await page.evaluate(() => {
      const danger = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-danger').trim();
      const discard = document.querySelector('.gm-confirm-discard') as HTMLElement;
      const keep = [...document.querySelectorAll('.gm-confirm-buttons button')]
        .find((b) => b.textContent!.includes('Keep')) as HTMLElement;
      // Resolve the declared variable to rgb() for comparison with computed values.
      const probe = document.createElement('span');
      probe.style.color = danger;
      document.body.appendChild(probe);
      const dangerRgb = getComputedStyle(probe).color;
      probe.remove();
      return {
        dangerRgb,
        discard: getComputedStyle(discard).color,
        discardBorder: getComputedStyle(discard).borderTopColor,
        keep: getComputedStyle(keep).color,
      };
    });

    // Text and border both carry the danger colour…
    expect(seen.discard).toBe(seen.dangerRgb);
    expect(seen.discardBorder).toBe(seen.dangerRgb);
    // …and it is visibly distinct from the neutral button beside it, which is
    // exactly what regressed: both rendered the same grey.
    expect(seen.discard).not.toBe(seen.keep);
  });

});
