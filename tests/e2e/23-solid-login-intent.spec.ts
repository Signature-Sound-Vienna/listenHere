import { test, expect } from '../support/fixtures';

// ---------------------------------------------------------------------------
// Section 23 — "Load from Solid" login-intent affordance (simulated, no pod)
// ---------------------------------------------------------------------------
// Clicking "Load from Solid" while signed out arms an intent: the drawer
// opens, the button shows a → nudge ("your move — sign in"), and the load
// modal auto-opens once login completes (within 5 min) UNLESS the user does
// something else first. Once the user clicks Connect and the OAuth exchange
// is in flight the nudge becomes a spinner, reverting to the nudge if that
// attempt fails / the popup is closed.
//
// These tests drive that state machine purely through the DOM events the
// real Solid flow dispatches (`solid-login-started`, `solid-auth-changed`),
// so they need NO valid Solid pod or login. The success path stubs
// solidClientAuthentication's getDefaultSession to report a logged-in
// session; everything else is plain event dispatch. Unlike 18-*.solid.spec,
// this runs in the default 'functional' project.

const LOAD_BTN = '.lh-v6-ribbon-load';
const ARROW = '.lh-v6-ribbon-load-arrow';
const SPINNER = '.lh-v6-ribbon-load-spinner';

test.describe('23. Load-from-Solid login intent (simulated)', () => {

  // 23.1 Clicking Load while signed out opens the drawer and shows the nudge.
  test('23.1 Load click arms the "your move" nudge and opens the drawer', async ({ loadedPage: page }) => {
    await page.locator(LOAD_BTN).click();

    await expect(page.locator('.lh-v6-drawer')).toHaveClass(/open/);
    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--waiting/);
    // The → nudge is shown; the spinner is not.
    await expect(page.locator(ARROW)).toBeVisible();
    await expect(page.locator(SPINNER)).toBeHidden();
    // Intent persisted so it survives the OAuth redirect fallback.
    expect(await page.evaluate(() => sessionStorage.getItem('v6-load-intent'))).not.toBeNull();
  });

  // 23.2 Starting login (Connect clicked) swaps the nudge for a spinner.
  test('23.2 solid-login-started swaps the nudge for a spinner', async ({ loadedPage: page }) => {
    await page.locator(LOAD_BTN).click();
    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--waiting/);

    // The real Connect button dispatches this as the OAuth exchange begins.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('solid-login-started')));

    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--connecting/);
    await expect(page.locator(LOAD_BTN)).not.toHaveClass(/lh-v6-ribbon-load--waiting/);
    await expect(page.locator(SPINNER)).toBeVisible();
    await expect(page.locator(ARROW)).toBeHidden();
  });

  // 23.3 A cancelled / closed login reverts the spinner to the nudge.
  test('23.3 a not-logged-in auth change reverts the spinner to the nudge', async ({ loadedPage: page }) => {
    await page.locator(LOAD_BTN).click();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('solid-login-started')));
    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--connecting/);

    // Popup closed / IdP error surfaces as a not-logged-in auth change.
    await page.evaluate(() => document.dispatchEvent(
      new CustomEvent('solid-auth-changed', { detail: { isLoggedIn: false } })));

    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--waiting/);
    await expect(page.locator(LOAD_BTN)).not.toHaveClass(/lh-v6-ribbon-load--connecting/);
    await expect(page.locator(ARROW)).toBeVisible();
    await expect(page.locator(SPINNER)).toBeHidden();
    // Intent is still live so the user can retry Connect.
    expect(await page.evaluate(() => sessionStorage.getItem('v6-load-intent'))).not.toBeNull();
  });

  // 23.4 Interacting elsewhere cancels the pending auto-open.
  test('23.4 a deliberate interaction elsewhere cancels the intent', async ({ loadedPage: page }) => {
    await page.locator(LOAD_BTN).click();
    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--waiting/);
    expect(await page.evaluate(() => sessionStorage.getItem('v6-load-intent'))).not.toBeNull();

    // The ribbon's pencil label is inert and sits outside the login footer /
    // Load button, so clicking it is a genuine "something else".
    await page.locator('.lh-v6-ribbon-label').click();

    await expect(page.locator(LOAD_BTN)).not.toHaveClass(/lh-v6-ribbon-load--waiting/);
    await expect(page.locator(ARROW)).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('v6-load-intent'))).toBeNull();
  });

  // 23.5 Interacting WITHIN the login footer does NOT cancel.
  test('23.5 interacting with the login footer keeps the intent armed', async ({ loadedPage: page }) => {
    await page.locator(LOAD_BTN).click();
    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--waiting/);

    // Clicking inside the Solid footer is part of (re)initiating login — the
    // inert "Solid:" label is a safe, side-effect-free target there.
    await page.locator('.lh-v6-drawer-solid .lh-v6-solid-label').click();

    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--waiting/);
    expect(await page.evaluate(() => sessionStorage.getItem('v6-load-intent'))).not.toBeNull();
  });

  // 23.6 Completing login auto-opens the modal and clears the affordance.
  test('23.6 a completed login auto-opens the load modal', async ({ loadedPage: page }) => {
    await page.locator(LOAD_BTN).click();
    await expect(page.locator(LOAD_BTN)).toHaveClass(/lh-v6-ribbon-load--waiting/);

    // Simulate a completed login without a real pod: the auth-changed handler
    // reads the live session (not the event detail), so flip the default
    // session's info to logged-in. getDefaultSession is a read-only accessor,
    // but the session singleton is stable and its info is mutable.
    await page.evaluate(() => {
      const session = (window as any).solidClientAuthentication.default.getDefaultSession();
      session.info.isLoggedIn = true;
      session.info.webId = 'https://example.test/card#me';
      document.dispatchEvent(
        new CustomEvent('solid-auth-changed', { detail: { isLoggedIn: true } }));
    });

    // Modal auto-opens, with the banner that explains why it appeared.
    await expect(page.locator('.lh-v6-load-overlay')).toBeVisible();
    await expect(page.locator('.lh-v6-load-resumed')).toContainText('resuming');
    // The waiting affordance is fully torn down.
    await expect(page.locator(LOAD_BTN)).not.toHaveClass(/lh-v6-ribbon-load--waiting/);
    await expect(page.locator(LOAD_BTN)).not.toHaveClass(/lh-v6-ribbon-load--connecting/);
    expect(await page.evaluate(() => sessionStorage.getItem('v6-load-intent'))).toBeNull();
  });

});
