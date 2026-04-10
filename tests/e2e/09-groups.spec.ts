import { test, expect, AUDIO_A, AUDIO_B } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 9 — File Groups
// ---------------------------------------------------------------------------

test.describe('9. File Groups', () => {

  // 9.1 Default grouping — ungrouped files
  test('9.1 default grouping shows ungrouped recordings and separate score', async ({ listenPage: page }) => {
    // Score should be in its own group/section
    const scoreSection = await page.evaluate(() => {
      const scoreCheckbox = document.querySelector('input[value="Score (synthesised from MEI)"]');
      if (!scoreCheckbox) return null;
      // Walk up to find the fieldset
      const fieldset = scoreCheckbox.closest('fieldset');
      return fieldset?.querySelector('legend')?.textContent?.trim() ?? null;
    });
    // Score section exists and is separate from the recordings
    expect(scoreSection).toBeTruthy();

    // Recording checkboxes should exist in a separate group
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

  // 9.8 Group All/None buttons
  test('9.8 group All/None buttons show and hide waveforms', async ({ loadedPage: page }) => {
    // Click "All" in the content pane group header — use loadedPage so group containers exist
    const allBtn = page.locator('#waveforms .group-all').first();
    await allBtn.click();
    await page.waitForTimeout(1000);

    const visibleAfterAll = await page.locator('#waveforms .waveform:not([style*="display: none"])').count();
    expect(visibleAfterAll).toBeGreaterThanOrEqual(2);

    // Click "None"
    const noneBtn = page.locator('#waveforms .group-none').first();
    await noneBtn.click();
    await page.waitForTimeout(500);

    const visibleAfterNone = await page.locator('#waveforms .waveform:not([style*="display: none"])').count();
    expect(visibleAfterNone).toBeLessThan(visibleAfterAll);
  });

});
