import { test, expect } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 13 — Manage Files Modal
// ---------------------------------------------------------------------------

test.describe('13. Manage Files Modal', () => {

  // 13.1 Modal opens and closes
  test('13.1 manage files button opens file picker overlay', async ({ loadedPage: page }) => {
    // Click Manage files
    await page.evaluate(() => (document.getElementById('manage-files-btn') as HTMLElement).click());
    await page.waitForTimeout(300);

    // File picker overlay should be visible
    const overlay = page.locator('#file-picker-overlay');
    await expect(overlay).toBeVisible();
  });

  // 13.2 (0.111.0) The drawer's Post to Solid follows the URIs set here
  test('13.2 Post to Solid, refused for want of Linked Data URIs, comes on when Manage recordings closes with a prefix set', async ({ loadedPage: page }) => {
    await page.evaluate(async () => {
      const L: any = await import('/static/js/listen.js' as any);
      delete L.loadedAlignmentJSON.header.linkedDataUriPrefix;
      delete L.loadedAlignmentJSON.header.linkedDataUris;
      const sca = (window as any).solidClientAuthentication;
      const s = (sca.default || sca).getDefaultSession();
      s.info.isLoggedIn = true;
      s.info.webId = 'https://pod.example/profile/card#me';
      const v6 = (window as any).__annotationV6;
      const id = v6.state.createAnnotation({ label: 'needs URIs' });
      v6.state.addTarget(id, 'audio-a.mp3');
      v6.state.setActiveAnnotation(id);
      v6.uiState.setDrawerOpen(true);
      v6.uiState.setMode('edit');
    });
    const post = page.locator('.lh-v6-publish-btn');
    await expect(post).toBeDisabled();
    await expect(post).toHaveAttribute('title', /Set Linked Data URI prefix/);

    await page.evaluate(() => (document.getElementById('manage-files-btn') as HTMLElement).click());
    await expect(page.locator('#file-picker-overlay')).toBeVisible();
    await page.evaluate(() => {
      const input = document.getElementById('ld-uri-prefix') as HTMLInputElement;
      input.value = 'https://example.org/media/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('file-picker-continue') as HTMLElement).click();
    });
    // No drawer close or mode switch in between.
    await expect(post).toBeEnabled();
  });

});
