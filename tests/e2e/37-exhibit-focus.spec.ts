import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 37 — Playhead-driven focus (?focus=playhead, main.js's follow
// machinery)
//
// The wash: focus follows the shared clock through region ENTRIES on the
// audible recording, per viewport in each viewport's own audience list —
// the exhibit's cousin of Listen Here's card wash, and the driver the chip/×
// machine was designed to survive (2026-08-24). The semantics under test,
// per the agreed definition of "in focus" (2026-08-25):
//
//   * OPT-IN — the default (`manual`) is byte-for-byte the shipped behaviour.
//   * EDGE-DRIVEN — focus changes when the annotation under the playhead
//     CHANGES, never as a per-frame overwrite.
//   * TWO SURFACES — the WASH (washId: chip highlight, region emphasis, group
//     edges, strip deemphasis) paints while the playhead is inside a region
//     and clears when it leaves (focusWash=clear, the default); the DETAIL
//     (shownId: the commentary and its group cards) lingers, because blanking
//     text mid-read is the worse wash. ?focusWash=sticky keeps week 3's
//     lingering wash as the A/B comparator.
//   * DEEMPHASIS — strips the painted annotation does not TARGET fade
//     (.is-dimmed); focusDim=auto keeps the manual exhibit shipped.
//   * PINNABLE — a chip tap pins paint AND detail against the wash; the
//     machine's unfocus (below-layout toggle-off, the side panel's ×)
//     releases it, and the wash resumes on the NEXT entry, not the same
//     frame. A pinned chip LOOKS held (is-pinned), a wash-lit one does not.
//   * AUTHORED SPANS — containment uses targets[].regionTimes, not the
//     widened display spans.
//
// Test moments are computed from the payload at runtime (spans and the gaps
// between them), not hard-coded, so re-authored annotations move the tests
// rather than breaking them. Seeks drive the clock — transport.seek() emits
// synchronously and needs no audio at all; only 37.8 plays for real.
// ---------------------------------------------------------------------------

/** Navigate to the exhibit and wait for the boot sequence to finish. */
async function boot(page: Page, qs = 'debug=1') {
  await page.goto(`/exhibit?${qs}`);
  const ok = await page.evaluate(() => (window as any)._exhibitTest.ready);
  expect(ok, 'exhibit boot promise resolved falsy — see console for the error').toBe(true);
}

type Span = { annId: string; start: number; end: number };

/**
 * Every authored span the given audience has on the ACTIVE recording, sorted
 * by start — plus a moment guaranteed to be outside all of them (the middle
 * of the widest gap). Computed in the page from the payload itself.
 */
async function spansOnActive(page: Page, audience: string) {
  return page.evaluate((audience) => {
    const T = (window as any)._exhibitTest;
    const file = T.transport.activeFile as string;
    const spans: { annId: string; start: number; end: number }[] = [];
    for (const ann of T.exhibit.byAudience[audience] || []) {
      const target = (ann.targets || []).find((t: any) => t.file === file);
      if (!target) continue;
      for (const region of ann.regions || []) {
        const s = target.regionTimes?.[region.id];
        if (s) spans.push({ annId: ann.id, start: s.start, end: s.end });
      }
    }
    spans.sort((a, b) => a.start - b.start);
    // The widest gap between consecutive spans (and the edges of the piece).
    const duration = T.exhibit.durations[file] as number;
    let gapAt = 0;
    let gapSize = spans.length ? spans[0].start : duration;
    let cursor = 0;
    for (const s of spans) {
      if (s.start - cursor > gapSize) {
        gapSize = s.start - cursor;
        gapAt = cursor + (s.start - cursor) / 2;
      }
      cursor = Math.max(cursor, s.end);
    }
    if (duration - cursor > gapSize) {
      gapSize = duration - cursor;
      gapAt = cursor + (duration - cursor) / 2;
    }
    return { file, spans, outside: gapAt, gapSize };
  }, audience);
}

async function seek(page: Page, t: number) {
  await page.evaluate((t) => (window as any)._exhibitTest.transport.seek(t), t);
}

/** The momentary wash surface — what paints on the strips and chips. */
async function washOf(page: Page, viewport: number) {
  return page.evaluate(
    (viewport) => (window as any)._exhibitTest.viewports[viewport].washId as string | null,
    viewport,
  );
}

/** The sticky detail surface — what the commentary shows. */
async function shownOf(page: Page, viewport: number) {
  return page.evaluate(
    (viewport) => (window as any)._exhibitTest.viewports[viewport].shownId as string | null,
    viewport,
  );
}

/** The app's own tie-break: the latest-START span containing `t`, if any. */
function winnerAt(spans: Span[], t: number): Span | null {
  let best: Span | null = null;
  for (const s of spans) {
    if (s.start <= t && s.end >= t && (!best || s.start > best.start)) best = s;
  }
  return best;
}

/**
 * Spans whose MIDPOINT is uncontested — no overlapping span would win the
 * tie-break there. Adults spans on the reference genuinely overlap (bell
 * strikes versus bar downbeats), so tests must park the clock only on moments
 * where the expected focus is unambiguous.
 */
function cleanSpans(spans: Span[]): Span[] {
  return spans.filter((s) => winnerAt(spans, (s.start + s.end) / 2)?.annId === s.annId);
}

/** Two clean spans from DIFFERENT annotations, for pin-versus-wash tests. */
function twoAnnotations(spans: Span[]): [Span, Span] {
  const clean = cleanSpans(spans);
  const first = clean[0];
  const other = clean.find((s) => s.annId !== first?.annId);
  expect(
    other,
    'payload has uncontested adults spans from at least two annotations on the reference',
  ).toBeTruthy();
  return [first!, other!];
}

test.describe('37. Playhead-driven focus', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  // 37.1 THE DEFAULT IS MANUAL: the clock parking inside a region focuses
  // nothing. This is the A/B baseline pin.
  test('37.1 by default the playhead does not drive focus', async ({ page }) => {
    await boot(page);
    const { spans } = await spansOnActive(page, 'adults');
    expect(spans.length).toBeGreaterThan(0);
    await seek(page, (spans[0].start + spans[0].end) / 2);
    expect(await washOf(page, 0)).toBeNull();
    expect(await washOf(page, 1)).toBeNull();
    expect(await shownOf(page, 0)).toBeNull();
  });

  // 37.2 Entering a region focuses its annotation — on BOTH viewports, since
  // both default to the same audience; the chip lights up like a tap did it.
  test('37.2 with ?focus=playhead a seek into a region focuses its annotation on both halves', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead');
    const { spans } = await spansOnActive(page, 'adults');
    // A clean span far enough in that the seek is a discontinuity — the sweep
    // path gets its own test (37.4); this one pins pure containment.
    const target = cleanSpans(spans).find((s) => s.start > 1.5)!;
    expect(target, 'an uncontested adults span starts later than 1.5 s').toBeTruthy();
    await seek(page, (target.start + target.end) / 2);
    expect(await washOf(page, 0)).toBe(target.annId);
    expect(await washOf(page, 1)).toBe(target.annId);
    // Entries advance BOTH surfaces: the detail follows the wash in.
    expect(await shownOf(page, 0)).toBe(target.annId);
    await expect(
      page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${target.annId}"]`),
    ).toHaveClass(/is-on/);
  });

  // 37.3 THE WASH CLEARS, THE DETAIL LINGERS — the agreed definition
  // (2026-08-25): leaving every region takes the paint with it (the chip
  // trades is-on for the subtle is-shown anchor), while the commentary
  // survives the exit so a reader is never cut off mid-sentence.
  test('37.3 leaving a region clears the wash but keeps the detail', async ({ page }) => {
    await boot(page, 'focus=playhead');
    const { spans, outside, gapSize } = await spansOnActive(page, 'adults');
    expect(gapSize, 'the reference recording has a gap between adults regions').toBeGreaterThan(1);
    const target = cleanSpans(spans).find((s) => s.start > 1.5)!;
    await seek(page, (target.start + target.end) / 2);
    expect(await washOf(page, 0)).toBe(target.annId);
    await seek(page, outside);
    expect(await washOf(page, 0)).toBeNull();
    expect(await shownOf(page, 0)).toBe(target.annId);
    // The class assertions auto-retry: if this exit happened to be continuous
    // (payload distances decide), focusHoldMs keeps the paint briefly and the
    // hold's own timer then clears it — both end states below.
    const chip = page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${target.annId}"]`);
    await expect(chip).not.toHaveClass(/is-on/);
    await expect(chip).toHaveClass(/is-shown/);
  });

  // 37.4 Sub-frame regions still wash: a continuous pair of clock samples
  // straddling a narrow region counts as an entry even though NO sample ever
  // landed inside it. This is what the sweep exists for — D or E?'s regions
  // are 12–120 ms, and a 60 fps clock steps ~17 ms.
  //
  // Why a planted span rather than the payload's own narrow regions: measured
  // against the real data, every sub-0.4 s span in every audience sits next to
  // a same-annotation sibling that covers its approach, so the wash already
  // says that annotation before the sweep — the sweep's contribution is
  // unobservable. So this test injects a 20 ms span through the seam the
  // machinery actually scans (`vp.currentAnnotations`, refreshed by every
  // render), placed in the middle of the widest real gap, and reuses a REAL
  // annotation's id so the render that follows the focus keeps it. The two
  // seek endpoints are the only samples — by construction neither lands
  // inside the span, so only the sweep can raise the entry.
  test('37.4 a region narrower than one frame is entered by the sweep between samples', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead');
    const { spans, outside, gapSize } = await spansOnActive(page, 'adults');
    expect(gapSize, 'the reference has a >1 s gap free of adults regions').toBeGreaterThan(1);
    expect(spans.length).toBeGreaterThan(0);

    const planted = await page.evaluate((outside) => {
      const T = (window as any)._exhibitTest;
      const vp = T.viewports[0];
      const real = vp.currentAnnotations[0];
      const file = T.transport.activeFile;
      vp.currentAnnotations = [
        {
          ...real,
          regions: [{ id: 'zz_sweep_probe' }],
          targets: [
            {
              file,
              regionTimes: { zz_sweep_probe: { start: outside - 0.01, end: outside + 0.01 } },
            },
          ],
        },
      ];
      return { annId: real.id as string };
    }, outside);

    await seek(page, outside - 0.3); // a discontinuity: parks OUTSIDE the span
    expect(await washOf(page, 0)).toBeNull();
    await seek(page, outside + 0.3); // one continuous step across it
    // The sweep raised the entry, and with no further clock sample the wash
    // has seen no exit edge yet — it still says the swept annotation.
    expect(await washOf(page, 0)).toBe(planted.annId);
    // The other half scans its own (real) list: the sweep crossed a real gap,
    // so nothing focused there — per-viewport lists really are per viewport.
    expect(await washOf(page, 1)).toBeNull();
  });

  // 37.5 The pin, in the default below-strips layout: a chip tap outranks the
  // wash; the same chip's toggle-off releases it, and the wash resumes on the
  // next ENTRY — not by instantly re-grabbing the region it is still inside.
  test('37.5 a chip tap pins focus against the wash; toggle-off releases it', async ({ page }) => {
    await boot(page, 'focus=playhead');
    const { spans, outside } = await spansOnActive(page, 'adults');
    const [first, other] = twoAnnotations(spans);

    await seek(page, (first.start + first.end) / 2);
    expect(await washOf(page, 0)).toBe(first.annId);

    // Pin a DIFFERENT annotation by tapping its chip: the pin holds paint and
    // detail alike on the visitor's choice.
    const chip = page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${other.annId}"]`);
    await chip.click();
    expect(await shownOf(page, 0)).toBe(other.annId);
    await expect(chip).toHaveClass(/is-on/);

    // The wash must not overwrite the pin — leave and re-enter a region.
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await shownOf(page, 0)).toBe(other.annId);
    await expect(chip).toHaveClass(/is-on/);
    // The other half was never pinned: it followed.
    expect(await washOf(page, 1)).toBe(first.annId);

    // Toggle the pinned chip off: unfocused, unpinned — and NOT instantly
    // re-focused by the region the playhead is still inside.
    await chip.click();
    expect(await shownOf(page, 0)).toBeNull();
    expect(await washOf(page, 0)).toBeNull();

    // The next entry edge resumes the wash.
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await washOf(page, 0)).toBe(first.annId);
  });

  // 37.6 The pin in the side-slot layout, released by the panel's ×. Also
  // pins on the panel-toggle branch: opening the panel to READ the focused
  // annotation is engagement, and the wash must not swap the text mid-read.
  test('37.6 in the side layout the × releases the pin and the wash resumes on the next entry', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&sideSlot=annotations');
    const { spans, outside } = await spansOnActive(page, 'adults');
    const [first, other] = twoAnnotations(spans);

    await seek(page, (first.start + first.end) / 2);
    expect(await washOf(page, 0)).toBe(first.annId);

    // Tap another chip: focus + pin + panel.
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${other.annId}"]`);
    expect(await shownOf(page, 0)).toBe(other.annId);
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await shownOf(page, 0)).toBe(other.annId); // pinned through the wash

    // × — the machine's one unfocus — releases the pin without an instant
    // re-grab, and the next entry refocuses.
    await page.click('.vp[data-viewport="0"] .side-close');
    expect(await shownOf(page, 0)).toBeNull();
    expect(await washOf(page, 0)).toBeNull();
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await washOf(page, 0)).toBe(first.annId);
  });

  // 37.7 An audience switch re-derives the wash at once in the NEW list: the
  // old audience's focus never survives, and whatever the new audience says
  // about this moment (an annotation, or honestly nothing) is what shows.
  // The other half keeps its own state — audience is per viewport.
  test('37.7 an audience switch re-derives focus against the new list immediately', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead');
    const { spans } = await spansOnActive(page, 'adults');
    const target = cleanSpans(spans).find((s) => s.start > 1.5)!;
    const moment = (target.start + target.end) / 2;
    await seek(page, moment);
    expect(await washOf(page, 0)).toBe(target.annId);

    await page.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'kids'));
    const after = await washOf(page, 0);
    expect(after).not.toBe(target.annId);
    // If anything focused, it is a kids annotation containing this moment —
    // computed from the payload, the same arithmetic the app runs.
    const expected = await page.evaluate((moment) => {
      const T = (window as any)._exhibitTest;
      const file = T.transport.activeFile;
      let best: string | null = null;
      let bestStart = -Infinity;
      for (const ann of T.exhibit.byAudience['kids'] || []) {
        const t = (ann.targets || []).find((x: any) => x.file === file);
        if (!t) continue;
        for (const region of ann.regions || []) {
          const s = t.regionTimes?.[region.id];
          if (s && s.start <= moment && s.end >= moment && s.start > bestStart) {
            best = ann.id;
            bestStart = s.start;
          }
        }
      }
      return best;
    }, moment);
    expect(after).toBe(expected);
    expect(await washOf(page, 1)).toBe(target.annId); // the other half kept its own
  });

  // 37.9 Chip elements SURVIVE same-list re-renders. The wash re-renders on
  // every region entry, resize re-derivations re-render on layout settling —
  // and a chip replaced between a finger's down and its up eats the tap (the
  // click fires on the row, the common ancestor, instead). That raced
  // Playwright's own taps as low-rate Firefox flakes in 35.22/37.6 before
  // annotation-list.js reconciled chips in place; this is the deterministic
  // pin for the reconciliation, plus its deliberate boundary: an audience
  // switch changes the list, and THERE the row rebuilds.
  test('37.9 a re-render updates chips in place; only a list change rebuilds them', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead');
    const { spans } = await spansOnActive(page, 'adults');
    const target = cleanSpans(spans).find((s) => s.start > 1.5)!;

    const marked = await page.evaluate(() => {
      const chip = document.querySelector('.vp[data-viewport="0"] .ann-chip') as any;
      chip._probe = 'kept';
      return chip.dataset.ann as string;
    });
    const probe = () =>
      page.evaluate(
        () =>
          (document.querySelector('.vp[data-viewport="0"] .ann-chip') as any)?._probe ?? null,
      );

    // A wash render (region entry) keeps the element.
    await seek(page, (target.start + target.end) / 2);
    expect(await washOf(page, 0)).toBe(target.annId);
    expect(await probe()).toBe('kept');

    // A manual focus render (chip tap) keeps it too — including the tapped
    // chip itself.
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${marked}"]`);
    expect(await probe()).toBe('kept');

    // The boundary: an audience switch changes the list, so the row rebuilds
    // and the marked element is legitimately gone.
    await page.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'kids'));
    expect(await probe()).toBeNull();
  });

  // 37.10 The A/B comparator: ?focusWash=sticky keeps week 3's lingering wash
  // — leaving every region keeps the paint, is-on and all. This is the pinned
  // baseline the clearing default is judged against (user ruling 2026-08-25:
  // the definition became the mode's default, the shipped stickiness became
  // the opt-in variant).
  test('37.10 ?focusWash=sticky keeps the wash after leaving a region', async ({ page }) => {
    await boot(page, 'focus=playhead&focusWash=sticky');
    const { spans, outside, gapSize } = await spansOnActive(page, 'adults');
    expect(gapSize, 'the reference recording has a gap between adults regions').toBeGreaterThan(1);
    const target = cleanSpans(spans).find((s) => s.start > 1.5)!;
    await seek(page, (target.start + target.end) / 2);
    expect(await washOf(page, 0)).toBe(target.annId);
    await seek(page, outside);
    expect(await washOf(page, 0)).toBe(target.annId);
    const chip = page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${target.annId}"]`);
    await expect(chip).toHaveClass(/is-on/);
    await expect(chip).not.toHaveClass(/is-shown/);
  });

  // 37.11 DEEMPHASIS: while an annotation paints, the strips it does not
  // TARGET fade (.is-dimmed) — targeting is the payload's own targets[].file
  // fact, computed here per strip, never assumed. The pin path drives the
  // paint because it is deterministic for any payload; a wash-driven dim
  // would need a partially-targeting annotation with spans on the audible
  // file, which the data need not provide. Release restores every strip.
  test('37.11 the painted annotation dims exactly the strips it does not target', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead');
    const pick = await page.evaluate(() => {
      const vp = (window as any)._exhibitTest.viewports[0];
      const files = [...vp.strips.keys()] as string[];
      const ann = vp.currentAnnotations.find(
        (a: any) => (a.targets || []).length && a.targets.length < files.length,
      );
      return ann
        ? {
            annId: ann.id as string,
            targeted: ann.targets.map((t: any) => t.file as string),
            files,
          }
        : null;
    });
    expect(pick, 'an adults annotation targets a strict subset of the strips').toBeTruthy();

    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.annId}"]`);
    for (const file of pick!.files) {
      const strip = page.locator(`.vp[data-viewport="0"] .strip[data-file="${file}"]`);
      if (pick!.targeted.includes(file)) await expect(strip).not.toHaveClass(/is-dimmed/);
      else await expect(strip).toHaveClass(/is-dimmed/);
    }
    // The other half was never focused: nothing faded there.
    await expect(page.locator('.vp[data-viewport="1"] .strip.is-dimmed')).toHaveCount(0);

    // The below-layout toggle-off releases the pin: every strip restored.
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.annId}"]`);
    await expect(page.locator('.vp[data-viewport="0"] .strip.is-dimmed')).toHaveCount(0);
  });

  // 37.12 The deemphasis is severable: ?focusDim=off keeps every strip at
  // full strength even while an annotation paints in playhead mode.
  test('37.12 ?focusDim=off disables the deemphasis under playhead focus', async ({ page }) => {
    await boot(page, 'focus=playhead&focusDim=off');
    const pick = await page.evaluate(() => {
      const vp = (window as any)._exhibitTest.viewports[0];
      const files = [...vp.strips.keys()] as string[];
      const ann = vp.currentAnnotations.find(
        (a: any) => (a.targets || []).length && a.targets.length < files.length,
      );
      return ann ? { annId: ann.id as string } : null;
    });
    expect(pick).toBeTruthy();
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.annId}"]`);
    await expect(
      page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.annId}"]`),
    ).toHaveClass(/is-on/);
    await expect(page.locator('.vp[data-viewport="0"] .strip.is-dimmed')).toHaveCount(0);
  });

  // 37.13 The A/B pin for MANUAL mode: focusDim defaults to "auto" =
  // playhead-only, so the untouched exhibit must not fade a single strip on a
  // tap — byte-for-byte the shipped behaviour — while ?focusDim=on opts
  // manual taps in.
  test('37.13 manual mode does not dim by default; ?focusDim=on opts it in', async ({ page }) => {
    await boot(page);
    const pick = await page.evaluate(() => {
      const vp = (window as any)._exhibitTest.viewports[0];
      const files = [...vp.strips.keys()] as string[];
      const ann = vp.currentAnnotations.find(
        (a: any) => (a.targets || []).length && a.targets.length < files.length,
      );
      return ann
        ? {
            annId: ann.id as string,
            // Count over the strips actually on screen: a target the layout
            // does not show can neither dim nor undim anything.
            expectDimmed: files.filter((f) => !ann.targets.some((t: any) => t.file === f))
              .length,
          }
        : null;
    });
    expect(pick).toBeTruthy();
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.annId}"]`);
    await expect(
      page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.annId}"]`),
    ).toHaveClass(/is-on/);
    await expect(page.locator('.vp[data-viewport="0"] .strip.is-dimmed')).toHaveCount(0);

    await boot(page, 'focusDim=on');
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.annId}"]`);
    await expect(page.locator('.vp[data-viewport="0"] .strip.is-dimmed')).toHaveCount(
      pick!.expectDimmed,
    );
  });

  // 37.14 The three chip states are DISTINCT (user ruling 2026-08-25): the
  // passing wash is plain is-on; an explicit pin adds is-pinned — a hold must
  // look held; and is-shown (37.3) marks lingering text. A wash-lit chip must
  // never carry the pin ring.
  test('37.14 a pinned chip is visually distinct from a wash-lit one', async ({ page }) => {
    await boot(page, 'focus=playhead');
    const { spans } = await spansOnActive(page, 'adults');
    const [first, other] = twoAnnotations(spans);

    await seek(page, (first.start + first.end) / 2);
    const washChip = page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${first.annId}"]`);
    await expect(washChip).toHaveClass(/is-on/);
    await expect(washChip).not.toHaveClass(/is-pinned/);

    const pinChip = page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${other.annId}"]`);
    await pinChip.click();
    await expect(pinChip).toHaveClass(/is-on/);
    await expect(pinChip).toHaveClass(/is-pinned/);
    await expect(washChip).not.toHaveClass(/is-on/); // the pin owns the paint

    // Release: the ring leaves with the pin, and nothing stays painted until
    // the next entry edge.
    await pinChip.click();
    await expect(pinChip).not.toHaveClass(/is-pinned/);
    await expect(pinChip).not.toHaveClass(/is-on/);
  });

  // 37.15 THE UNION AT OVERLAPS (ruled 2026-08-25): every annotation with a
  // region under the playhead paints — chips and deemphasis over the union of
  // their targets — while the detail follows the single latest-start winner.
  test('37.15 overlapping regions paint as a union; the text follows the latest start', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead');
    // The payload's one cross-annotation overlap (measured 2026-08-25) is in
    // the kids list on VPO-1989 — but FIND whatever holds that role at
    // runtime, so re-authoring moves this test rather than breaking it. The
    // audible recording and the audience both switch to reach it.
    const found = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      for (const [aud, list] of Object.entries(T.exhibit.byAudience)) {
        const byFile: Record<string, { annId: string; start: number; end: number }[]> = {};
        for (const ann of list as any[]) {
          for (const target of ann.targets || []) {
            for (const region of ann.regions || []) {
              const s = target.regionTimes?.[region.id];
              if (s) (byFile[target.file] ||= []).push({ annId: ann.id, start: s.start, end: s.end });
            }
          }
        }
        for (const [file, spans] of Object.entries(byFile)) {
          for (const a of spans) {
            for (const b of spans) {
              if (a.annId === b.annId) continue;
              const lo = Math.max(a.start, b.start);
              const hi = Math.min(a.end, b.end);
              if (hi - lo > 0.2) {
                const moment = lo + (hi - lo) / 2;
                const covering = [
                  ...new Set(
                    spans.filter((s) => s.start <= moment && s.end >= moment).map((s) => s.annId),
                  ),
                ].sort();
                let primary: string | null = null;
                let bestStart = -Infinity;
                for (const s of spans) {
                  if (s.start <= moment && s.end >= moment && s.start > bestStart) {
                    primary = s.annId;
                    bestStart = s.start;
                  }
                }
                return { aud, file, moment, covering, primary };
              }
            }
          }
        }
      }
      return null;
    });
    expect(found, 'the payload has a cross-annotation overlap somewhere').toBeTruthy();
    expect(found!.covering.length).toBeGreaterThan(1);

    // Switch the half's audience, then the audible recording — quietly
    // (play=false, spec 36's discipline) and AT the overlap moment, which is
    // a discontinuity: containment only, exactly what the union claim needs.
    await page.evaluate(async ({ aud, file, moment }) => {
      const T = (window as any)._exhibitTest;
      T.audience.set(0, aud);
      await T.transport.select(file, moment, false);
    }, found!);

    const washIds = await page.evaluate(() =>
      [...(window as any)._exhibitTest.viewports[0].washIds].sort(),
    );
    expect(washIds).toEqual(found!.covering);
    for (const id of found!.covering) {
      await expect(page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${id}"]`)).toHaveClass(
        /is-on/,
      );
    }
    expect(await washOf(page, 0)).toBe(found!.primary);
    expect(await shownOf(page, 0)).toBe(found!.primary);

    // Deemphasis over the union: a strip keeps full strength if ANY painted
    // annotation targets it — computed per strip from the payload.
    const dims = await page.evaluate((covering) => {
      const vp = (window as any)._exhibitTest.viewports[0];
      const anns = vp.currentAnnotations.filter((a: any) => covering.includes(a.id));
      const out: { file: string; expected: boolean; actual: boolean }[] = [];
      for (const [file, strip] of vp.strips) {
        out.push({
          file,
          expected: !anns.some((a: any) => (a.targets || []).some((t: any) => t.file === file)),
          actual: strip.el.classList.contains('is-dimmed'),
        });
      }
      return out;
    }, found!.covering);
    for (const d of dims) expect(d.actual, d.file).toBe(d.expected);
  });

  // 37.16 THE MINIMUM HOLD (?focusHoldMs): paint from a region shorter than
  // the bound is held to it — the sub-frame spans must not blink for one
  // frame — cleared by the hold's own timer with no transport event at all;
  // and a discontinuity drops held paint at once (jumps land, they do not
  // carry). Uses 37.4's planted span (and its caveat: the plant survives only
  // until the next render, so it is re-planted for the second phase).
  test('37.16 sub-bound paint is held to focusHoldMs; a discontinuity drops it at once', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&focusHoldMs=1500');
    const { spans, outside, gapSize } = await spansOnActive(page, 'adults');
    expect(gapSize, 'the reference has a >2 s gap free of adults regions').toBeGreaterThan(2);
    expect(spans.length).toBeGreaterThan(0);

    const plant = () =>
      page.evaluate((outside) => {
        const T = (window as any)._exhibitTest;
        const vp = T.viewports[0];
        const real = T.exhibit.byAudience['adults'][0];
        const file = T.transport.activeFile;
        vp.currentAnnotations = [
          {
            ...real,
            regions: [{ id: 'zz_hold_probe' }],
            targets: [
              {
                file,
                regionTimes: { zz_hold_probe: { start: outside - 0.01, end: outside + 0.01 } },
              },
            ],
          },
        ];
        return real.id as string;
      }, outside);

    const annId = await plant();
    const chip = page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${annId}"]`);

    await seek(page, outside - 0.6); // discontinuity: parks outside the span
    await seek(page, outside + 0.2); // continuous sweep: entry
    await expect(chip).toHaveClass(/is-on/);
    await seek(page, outside + 0.5); // continuous exit, well inside the bound
    expect(await washOf(page, 0)).toBeNull(); // the wash is empty…
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.viewports[0].washHold.size),
    ).toBe(1); // …but the hold carries the paint…
    await expect(chip).toHaveClass(/is-on/);
    // …until its own timer clears it.
    await expect(chip).not.toHaveClass(/is-on/);

    // Phase two: held paint versus a JUMP.
    await plant();
    await seek(page, outside - 0.6); // discontinuity: parks outside again
    await seek(page, outside + 0.2); // continuous sweep: re-entry
    await expect(chip).toHaveClass(/is-on/);
    await seek(page, outside + 0.5); // continuous exit -> held again
    await seek(page, outside - 0.9); // a 1.4 s jump: discontinuity
    await expect(chip).not.toHaveClass(/is-on/);
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.viewports[0].washHold.size),
    ).toBe(0);
  });

  // 37.17 PIN EXPIRY (?pinExpiry, ruled 2026-08-25): an abandoned pin must
  // not hold the table. The "Keep reading…" ring warns inside the warning
  // window, a tap re-arms the full time, and expiry — unlike the × — is not
  // a dismissal: the wash re-derives IMMEDIATELY, re-grabbing the region the
  // playhead is inside.
  test('37.17 a pin expires on deadline: the ring warns, a tap re-arms, expiry re-derives at once', async ({
    page,
  }) => {
    // 2400 ms: the warning window is its half, 1200 ms — wide enough that the
    // ring's live phase cannot be swallowed by assertion round-trips under a
    // loaded machine (450 ms windows were, 2026-08-25).
    await boot(page, 'focus=playhead&pinExpiry=2400');
    const { spans } = await spansOnActive(page, 'adults');
    const [first, other] = twoAnnotations(spans);
    await seek(page, (first.start + first.end) / 2); // park inside a region
    expect(await washOf(page, 0)).toBe(first.annId);

    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${other.annId}"]`);
    expect(await shownOf(page, 0)).toBe(other.annId);
    // The ring goes live for the second half of the pin's life.
    const ring = page.locator('.vp[data-viewport="0"] .pin-expiry');
    await expect(ring).toHaveClass(/is-live/);

    // Tapping the ring re-arms the full time: the deadline moves forward.
    const before = await page.evaluate(
      () => (window as any)._exhibitTest.viewports[0].pinDeadline,
    );
    await ring.click();
    const after = await page.evaluate(
      () => (window as any)._exhibitTest.viewports[0].pinDeadline,
    );
    expect(after).toBeGreaterThan(before);

    // Expiry: pin released, wash re-derived at once — still inside `first`.
    await expect.poll(async () => shownOf(page, 0), { timeout: 5000 }).toBe(first.annId);
    expect(await washOf(page, 0)).toBe(first.annId);
  });

  // 37.18 ?detailFade, case 1 (ruled 2026-08-25): playback-triggered text is
  // MORTAL — shown for its window, the ring warns, then it fades out (and
  // never re-shows itself: at expiry the playhead is still inside the same
  // region, and that is a fade, not a refresh). Under sideSlot=annotations
  // the same machine opens the panel on entry and closes it on fade; a fresh
  // RE-ENTRY re-earns the display.
  test('37.18 detailFade: shown text runs its window, warns, fades out, and closes the panel', async ({
    page,
  }) => {
    // 3000 ms: the ring's live phase is the window's second half, 1500 ms —
    // transient-state assertions need windows that survive a loaded machine.
    await boot(page, 'focus=playhead&sideSlot=annotations&detailFade=3000');
    const { spans, outside } = await spansOnActive(page, 'adults');
    const target = cleanSpans(spans).find((s) => s.start > 1.5)!;
    const mid = (target.start + target.end) / 2;
    const vp0 = page.locator('.vp[data-viewport="0"]');

    await seek(page, mid);
    expect(await shownOf(page, 0)).toBe(target.annId);
    await expect(vp0).toHaveAttribute('data-side-open', '1'); // auto-opened
    const ring = page.locator('.vp[data-viewport="0"] .pin-expiry');
    await expect(ring).toHaveClass(/is-live/); // warns inside the window

    // The window ends with the playhead still inside the region: fade, not
    // refresh — text gone, panel closed.
    await expect.poll(async () => shownOf(page, 0), { timeout: 5000 }).toBeNull();
    await expect(vp0).not.toHaveAttribute('data-side-open', '1');

    // A genuine re-entry re-earns the display.
    await seek(page, outside);
    await seek(page, mid);
    expect(await shownOf(page, 0)).toBe(target.annId);
    await expect(vp0).toHaveAttribute('data-side-open', '1');
  });

  // 37.19 ?detailFade, case 2: an unbumped text yields to the next entry at
  // once (floor 0 here); a ring tap BUMPS it to its full window, entries
  // then defer, and the bump's expiry catches up to whatever is relevant.
  test('37.19 detailFade: entries switch unbumped text; a bump defers them until its window ends', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&detailFade=3000&focusHoldMs=0');
    const { spans, outside } = await spansOnActive(page, 'adults');
    const [first, other] = twoAnnotations(spans);

    await seek(page, (first.start + first.end) / 2);
    expect(await shownOf(page, 0)).toBe(first.annId);
    // Unbumped, floor 0: the next entry switches the text immediately.
    await seek(page, (other.start + other.end) / 2);
    expect(await shownOf(page, 0)).toBe(other.annId);

    // Bump: the ring goes live mid-window; tapping it grants the full window.
    const ring = page.locator('.vp[data-viewport="0"] .pin-expiry');
    await expect(ring).toHaveClass(/is-live/);
    await ring.click();
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.viewports[0].shownBumped),
    ).toBe(true);

    // A new entry now defers: paint moves, the bumped text stays…
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await washOf(page, 0)).toBe(first.annId);
    expect(await shownOf(page, 0)).toBe(other.annId);
    // …until the bump expires and the text catches up to what is relevant.
    await expect.poll(async () => shownOf(page, 0), { timeout: 5000 }).toBe(first.annId);
  });

  // 37.20 The A/B pin: without ?detailFade the panel never opens by itself
  // and unpinned text follows entries instantly, sticky forever — today's
  // default, byte-for-byte.
  test('37.20 by default the panel never auto-opens and shown text is immortal', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&sideSlot=annotations');
    const { spans } = await spansOnActive(page, 'adults');
    const [first, other] = twoAnnotations(spans);
    await seek(page, (first.start + first.end) / 2);
    expect(await shownOf(page, 0)).toBe(first.annId);
    await expect(page.locator('.vp[data-viewport="0"]')).not.toHaveAttribute(
      'data-side-open',
      '1',
    );
    await seek(page, (other.start + other.end) / 2);
    expect(await shownOf(page, 0)).toBe(other.annId); // followed instantly
  });

  // 37.8 The genuine path, once: real playback crossing a region start raises
  // the entry and the wash focuses it, driven by the real per-frame clock.
  test('37.8 real playback washes focus in as the clock crosses a region start', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead');
    const { spans } = await spansOnActive(page, 'adults');
    // A clean span starting late enough to seek in front of, with a clear
    // window after its start so the poll observes THIS focus before any next
    // entry could replace it.
    const target = cleanSpans(spans).find(
      (c) =>
        c.start > 2 &&
        !spans.some((s) => s.start > c.start && s.start <= c.start + 3),
    );
    expect(target, 'an adults span with a 3 s clear window starts later than 2 s').toBeTruthy();

    await page.click('.mb-play');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'the band play button never started the transport',
      })
      .toBe(true);
    await seek(page, target!.start - 1);
    // Polled on the STICKY surface: under focusWash=clear the wash itself may
    // legitimately have cleared again by the time a poll samples it (the span
    // can be shorter than the poll interval), but only a real entry ever sets
    // shownId — so this still proves the clock-driven path end to end.
    await expect
      .poll(async () => shownOf(page, 0), {
        timeout: 10_000,
        message: 'playback crossed the region start but the wash never focused it',
      })
      .toBe(target!.annId);
  });
});
