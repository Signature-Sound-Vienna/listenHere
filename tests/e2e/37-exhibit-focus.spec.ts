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

/**
 * Advance the READING CLOCK — the time base of every fade and expiry window
 * (ruled 2026-08-25: those windows drain only while the music runs). Specs
 * drive the timer machinery with this the way seeks drive the follow
 * machinery: deterministically, without waiting out real windows against
 * real audio. 37.21 pins the genuine clock once.
 */
async function advanceClock(page: Page, ms: number) {
  await page.evaluate((ms) => (window as any)._exhibitTest.readingClock.advance(ms), ms);
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

    // Plant and sweep in ONE synchronous task: a boot-settling resize
    // re-render (rAF-coalesced, main.js) re-derives currentAnnotations from
    // the payload, and one landing between a plant and its sweep silently
    // unplants the probe — it flaked exactly so in mixed runs (2026-08-25).
    // Inside a single evaluate nothing can interleave; the re-render the
    // sweep itself triggers runs AFTER the wash was computed, and the planted
    // id is a real annotation's, so the present() filter keeps it.
    const result = await page.evaluate((outside) => {
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
      T.transport.seek(outside - 0.3); // a discontinuity: parks OUTSIDE the span
      const parked = vp.washId;
      T.transport.seek(outside + 0.3); // one continuous step across it
      return {
        annId: real.id as string,
        parked,
        swept: vp.washId,
        other: T.viewports[1].washId,
      };
    }, outside);

    expect(result.parked).toBeNull();
    // The sweep raised the entry, and with no further clock sample the wash
    // has seen no exit edge yet — it still says the swept annotation.
    expect(result.swept).toBe(result.annId);
    // The other half scans its own (real) list: the sweep crossed a real gap,
    // so nothing focused there — per-viewport lists really are per viewport.
    expect(result.other).toBeNull();
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
  // playhead is inside. The pin runs on the READING CLOCK (rule 2,
  // 2026-08-25 — frozen while the music is not running), so the test
  // advances it explicitly.
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
    // Silent table: the pin's clock stands still, so its second half — the
    // ring's live phase — is reached by advancing the reading clock.
    await advanceClock(page, 1300);
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
    await advanceClock(page, 3000);
    await expect.poll(async () => shownOf(page, 0), { timeout: 5000 }).toBe(first.annId);
    expect(await washOf(page, 0)).toBe(first.annId);
  });

  // 37.18 ?detailFade with the edge rules (ruled 2026-08-25): playback-
  // triggered text is MORTAL, but never while it is RELEVANT — parked inside
  // the shown annotation's span, the deadline defers to the region exit,
  // however far past the natural window (rule 1). A time-jump away starts
  // the "Keep reading…" countdown at once — even on a window already spent
  // during the hold (rule 3) — and its end is a fade, not a refresh: text
  // gone, panel closed. A fresh re-entry re-earns the display.
  test('37.18 detailFade: relevant text holds past its window; a jump away rings, then fades and closes the panel', async ({
    page,
  }) => {
    // 3000 ms: the ring's live phase is the window's second half, 1500 ms —
    // transient-state assertions need windows that survive a loaded machine.
    await boot(page, 'focus=playhead&sideSlot=annotations&detailFade=3000');
    const { spans, outside } = await spansOnActive(page, 'adults');
    // Depth beyond the midpoint, so the deferred deadline lands measurably
    // past the natural window while the clock is advanced beyond it.
    const target = cleanSpans(spans).find((s) => s.end - s.start > 3);
    expect(target, 'an uncontested adults span longer than 3 s exists').toBeTruthy();
    const mid = (target!.start + target!.end) / 2;
    const vp0 = page.locator('.vp[data-viewport="0"]');

    await seek(page, mid);
    expect(await shownOf(page, 0)).toBe(target!.annId);
    await expect(vp0).toHaveAttribute('data-side-open', '1'); // auto-opened

    // The natural window is spent with the playhead still inside the region:
    // the relevance hold defers the deadline to the region exit — no fade.
    await advanceClock(page, 4000);
    await page.waitForTimeout(500); // two fade ticks
    expect(await shownOf(page, 0)).toBe(target!.annId);

    // A jump to unannotated ground: the countdown starts immediately, the
    // full warning granted even though the window itself is spent…
    await seek(page, outside);
    const ring = page.locator('.vp[data-viewport="0"] .pin-expiry');
    await expect(ring).toHaveClass(/is-live/);
    // …and its end is a fade, not a refresh — text gone, panel closed.
    await advanceClock(page, 2000);
    await expect.poll(async () => shownOf(page, 0), { timeout: 5000 }).toBeNull();
    await expect(vp0).not.toHaveAttribute('data-side-open', '1');

    // A genuine re-entry re-earns the display.
    await seek(page, mid);
    expect(await shownOf(page, 0)).toBe(target!.annId);
    await expect(vp0).toHaveAttribute('data-side-open', '1');
  });

  // 37.19 ?detailFade, case 2: an unbumped text yields to the next entry at
  // once (floor 0 here); a ring tap BUMPS it to its full window, entries
  // then defer — but the reader's OWN jump still starts the countdown over
  // the bump (their act, their clock; ruled 2026-08-25), and the countdown's
  // end catches up to whatever is relevant then.
  test('37.19 detailFade: entries switch unbumped text; a bump defers them; a jump countdown ends in catch-up', async ({
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

    // A jump away starts the countdown (parked INSIDE its region the ring
    // could never come: the relevance hold defers the deadline); tapping the
    // ring BUMPS the text to its full window and the ring stands down.
    await seek(page, outside);
    const ring = page.locator('.vp[data-viewport="0"] .pin-expiry');
    await expect(ring).toHaveClass(/is-live/);
    await ring.click();
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.viewports[0].shownBumped),
    ).toBe(true);
    await expect(ring).not.toHaveClass(/is-live/);

    // The entry at the next jump moves the paint but defers to the bump —
    // while the jump itself re-arms the countdown over it…
    await seek(page, (first.start + first.end) / 2);
    expect(await washOf(page, 0)).toBe(first.annId);
    expect(await shownOf(page, 0)).toBe(other.annId);
    // …whose end catches the text up to what is relevant.
    await advanceClock(page, 2000);
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

  // 37.21 THE READING CLOCK (rule 2, 2026-08-25): every fade and expiry
  // window counts only time the music actually runs — the pause button
  // freezes a reader's remaining window, play resumes it where it stopped,
  // and a silent table never starts a countdown at all. The genuine path,
  // once: real playback drives the clock, the pause button stops it. The
  // other timer specs drive this clock through the advance() hook.
  test('37.21 the reading clock advances with playback and freezes on pause', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&detailFade=3000');
    const clock = () =>
      page.evaluate(() => (window as any)._exhibitTest.readingClock.now() as number);
    // Silent table: the clock stands at zero, however long the boot took.
    expect(await clock()).toBe(0);

    await page.click('.mb-play');
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing), {
        timeout: 15_000,
        message: 'the band play button never started the transport',
      })
      .toBe(true);
    const t1 = await clock();
    await page.waitForTimeout(600);
    const t2 = await clock();
    expect(t2, 'the clock advances while the music runs').toBeGreaterThan(t1);

    await page.click('.mb-play'); // the shared toggle: now a pause
    await expect
      .poll(() => page.evaluate(() => (window as any)._exhibitTest.transport.playing))
      .toBe(false);
    const t3 = await clock();
    await page.waitForTimeout(600);
    const t4 = await clock();
    expect(t4, 'the pause button freezes the clock').toBe(t3);
  });

  // 37.22 OWNERSHIP OF A JUMP (ruled 2026-08-25): the jumping side keeps its
  // agency — its own jump lands, switching to what it finds — while the
  // OTHER side's text is never snatched mid-read: it gets the "Keep
  // reading…" countdown instead, and the catch-up at its end switches to
  // whatever is relevant then. Attribution comes from the turn machine,
  // which names its holder before it touches the transport.
  test("37.22 another side's jump never snatches text: countdown first, catch-up after", async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&detailFade=3000&focusHoldMs=0');
    const { spans } = await spansOnActive(page, 'adults');
    // Two uncontested spans of different annotations whose midpoints are far
    // enough apart to register as a jump (the >1 s discontinuity rule).
    const clean = cleanSpans(spans);
    let pair: [Span, Span] | null = null;
    outer: for (const p of clean)
      for (const q of clean) {
        if (p.annId === q.annId) continue;
        if (Math.abs((p.start + p.end) / 2 - (q.start + q.end) / 2) > 1.5) {
          pair = [p, q];
          break outer;
        }
      }
    expect(pair, 'two uncontested adults spans >1.5 s apart exist').toBeTruthy();
    const [first, other] = pair!;

    // Both halves read `first` (both default to the adults list).
    await seek(page, (first.start + first.end) / 2);
    expect(await shownOf(page, 0)).toBe(first.annId);
    expect(await shownOf(page, 1)).toBe(first.annId);

    // Quieten select (spec 36's discipline): the tap's seek must land its
    // emit without fetching and playing real audio mid-test.
    await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const orig = T.transport.select.bind(T.transport);
      T.transport.select = (file: string, time?: number) => orig(file, time, false);
    });
    // Viewport 1 taps a moment inside `other` on the active strip: ITS text
    // switches at once (floor 0); viewport 0's holds behind the countdown.
    await page.evaluate(
      (t) => {
        const T = (window as any)._exhibitTest;
        T.turns.request(1, T.transport.activeFile, t);
      },
      (other.start + other.end) / 2,
    );
    expect(await shownOf(page, 1)).toBe(other.annId);
    expect(await shownOf(page, 0)).toBe(first.annId);
    await expect(page.locator('.vp[data-viewport="0"] .pin-expiry')).toHaveClass(/is-live/);

    // The countdown's end catches viewport 0 up to what is relevant now.
    await advanceClock(page, 2000);
    await expect.poll(async () => shownOf(page, 0), { timeout: 5000 }).toBe(other.annId);
  });

  // 37.23 RELEVANCE VOIDS THE COUNTDOWN (rules 1 + 3, 2026-08-25): a jump
  // away starts the countdown; a jump back inside the shown annotation's
  // span voids it — and the relevance hold then keeps the text alive past
  // its natural window for as long as the playhead stays inside.
  test('37.23 a jump back into the region voids the countdown and holds the text', async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&detailFade=3000');
    const { spans, outside } = await spansOnActive(page, 'adults');
    const target = cleanSpans(spans)[0];
    expect(target, 'an uncontested adults span exists').toBeTruthy();
    const mid = (target.start + target.end) / 2;
    const ring = page.locator('.vp[data-viewport="0"] .pin-expiry');

    await seek(page, mid);
    expect(await shownOf(page, 0)).toBe(target.annId);
    await seek(page, outside);
    await expect(ring).toHaveClass(/is-live/); // the countdown is running…
    await seek(page, mid);
    await expect(ring).not.toHaveClass(/is-live/); // …and relevance voids it.

    // Parked inside, the text outlives its natural window indefinitely.
    await advanceClock(page, 5000);
    await page.waitForTimeout(500); // two fade ticks
    expect(await shownOf(page, 0)).toBe(target.annId);
  });

  // 37.24 THE RECORDING-SWITCH EXEMPTION (ruled 2026-08-25): the jumping
  // side's own y-axis switch — comparing interpretations mid-read is the
  // exhibit's point — neither switches its text nor starts a countdown when
  // it lands on unannotated ground; the text stays mortal on its own window
  // alone. (The other side's switch-steal deferral shares the seek path's
  // arming branch but is not separately pinned here: it needs a projection
  // landing inside a foreign span, which the payload need not offer.)
  test("37.24 a recording switch neither snatches the switcher's text nor starts its countdown", async ({
    page,
  }) => {
    await boot(page, 'focus=playhead&detailFade=3000');
    // A probe: a HOST recording carrying exactly one adults annotation's span
    // at the probed moment, and a TARGET recording the annotation does not
    // target, where the projected moment is clear of every adults span
    // (0.75 s margin). A switch preserves the musical moment, so an
    // annotation spanning all eight recordings stays relevant across any
    // switch — only a target-subset annotation (the payload has them) can
    // land its reader on unannotated ground.
    const pick = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const spansOn = (f: string) => {
        const out: { annId: string; start: number; end: number }[] = [];
        for (const ann of T.exhibit.byAudience['adults'] || []) {
          const target = (ann.targets || []).find((t: any) => t.file === f);
          if (!target) continue;
          for (const region of ann.regions || []) {
            const s = target.regionTimes?.[region.id];
            if (s) out.push({ annId: ann.id, start: s.start, end: s.end });
          }
        }
        return out;
      };
      for (const host of T.exhibit.order as string[]) {
        const here = spansOn(host);
        for (const span of here) {
          for (let k = 1; k <= 9; k++) {
            const t = span.start + ((span.end - span.start) * k) / 10;
            const containing = here.filter((s) => s.start <= t && s.end >= t);
            if (!containing.length || !containing.every((s) => s.annId === span.annId))
              continue;
            for (const other of T.exhibit.order as string[]) {
              if (other === host) continue;
              const proj = T.projectPlayhead(t, host, [other])[other];
              if (!Number.isFinite(proj)) continue;
              const clear = spansOn(other).every(
                (s) => proj < s.start - 0.75 || proj > s.end + 0.75,
              );
              if (clear) return { host, t, annId: span.annId, toFile: other };
            }
          }
        }
      }
      return null;
    });
    expect(pick, 'a target-subset adults annotation offers a clear-landing switch').toBeTruthy();

    // Quieten select before any tap, then make the host audible and park
    // inside the probed span.
    await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const orig = T.transport.select.bind(T.transport);
      T.transport.select = (file: string, time?: number) => orig(file, time, false);
    });
    await page.evaluate(
      (f) => (window as any)._exhibitTest.turns.request(0, f),
      pick!.host,
    );
    await seek(page, pick!.t);
    expect(await shownOf(page, 0)).toBe(pick!.annId);
    // The switch tap carries the musical moment, not a finger time.
    await page.evaluate(
      (f) => (window as any)._exhibitTest.turns.request(0, f),
      pick!.toFile,
    );
    expect(await shownOf(page, 0)).toBe(pick!.annId);
    expect(
      await page.evaluate(() => (window as any)._exhibitTest.viewports[0].fadeCapAt),
    ).toBe(0);
    await expect(page.locator('.vp[data-viewport="0"] .pin-expiry')).not.toHaveClass(
      /is-live/,
    );
    // No hold, no countdown: the natural window alone still ends the text.
    await advanceClock(page, 4000);
    await expect.poll(async () => shownOf(page, 0), { timeout: 5000 }).toBeNull();
  });

  // 37.25 THE DETAIL TITLE (?detailTitle, ruled 2026-08-25): playback-driven
  // switching makes "which annotation am I reading?" forgettable, so the
  // shown text carries its own title — pinned above the scrolling commentary,
  // same label source and colour as its chip. auto = playhead mode only (the
  // focusDim pattern, so the manual exhibit stays byte-for-byte shipped);
  // on/off force it either way.
  test('37.25 the detail title follows the shown annotation; auto keeps manual mode shipped', async ({
    page,
  }) => {
    // Playhead mode, auto: the shown text carries its title.
    await boot(page, 'focus=playhead');
    const { spans } = await spansOnActive(page, 'adults');
    const target = cleanSpans(spans)[0];
    await seek(page, (target.start + target.end) / 2);
    expect(await shownOf(page, 0)).toBe(target.annId);
    const title = page.locator('.vp[data-viewport="0"] .ann-title');
    await expect(title).toBeVisible();
    const chipLabel = await page
      .locator(
        `.vp[data-viewport="0"] .ann-chip[data-ann="${target.annId}"] .ann-chip-label`,
      )
      .textContent();
    await expect(title.locator('.ann-title-label')).toHaveText(chipLabel!);

    // Manual mode, auto: focused text but NO title — the shipped panel.
    await boot(page, 'debug=1');
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${target.annId}"]`);
    expect(await shownOf(page, 0)).toBe(target.annId);
    await expect(page.locator('.vp[data-viewport="0"] .ann-title')).toBeHidden();

    // Forced on in manual mode; forced off under playhead focus.
    await boot(page, 'detailTitle=on');
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${target.annId}"]`);
    await expect(page.locator('.vp[data-viewport="0"] .ann-title')).toBeVisible();
    await boot(page, 'focus=playhead&detailTitle=off');
    await seek(page, (target.start + target.end) / 2);
    expect(await shownOf(page, 0)).toBe(target.annId);
    await expect(page.locator('.vp[data-viewport="0"] .ann-title')).toBeHidden();
  });

  // 37.26 THE JUMP BUTTON (?detailJump, ruled 2026-08-25 — ON everywhere, the
  // one deliberate on-by-default: in manual mode chips are pure focus
  // controls, so this is the only direct route from a text to its music).
  // The jump stays on the ACTIVE recording when the annotation targets it;
  // otherwise it switches to the first targeted strip in stack order — and
  // lands at the earliest region start in playback order either way.
  test('37.26 the jump button makes a targeted recording audible at the earliest region start', async ({
    page,
  }) => {
    await boot(page, 'debug=1'); // manual mode: the button is on by default
    // Expected landings, from the payload itself: one annotation that targets
    // the resting reference (jump must NOT switch), and one that does not
    // (jump must switch to its first targeted recording in stack order).
    const picks = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const ref = T.transport.activeFile as string;
      const earliest = (ann: any, f: string) => {
        const tg = (ann.targets || []).find((t: any) => t.file === f);
        if (!tg) return null;
        let s: number | null = null;
        for (const r of ann.regions || []) {
          const sp = tg.regionTimes?.[r.id];
          if (sp && sp.end > sp.start && (s == null || sp.start < s)) s = sp.start;
        }
        return s;
      };
      const anns = T.exhibit.byAudience['adults'] || [];
      const stayAnn = anns.find((a: any) => earliest(a, ref) != null);
      const awayAnn = anns.find((a: any) => !(a.targets || []).some((t: any) => t.file === ref));
      let away = null;
      if (awayAnn) {
        const f = (T.exhibit.order as string[]).find((f) =>
          (awayAnn.targets || []).some((t: any) => t.file === f),
        )!;
        away = { id: awayAnn.id, file: f, start: earliest(awayAnn, f) };
      }
      return {
        ref,
        stay: stayAnn ? { id: stayAnn.id, start: earliest(stayAnn, ref) } : null,
        away,
      };
    });
    expect(picks.stay, 'an adults annotation targets the reference').toBeTruthy();
    expect(picks.away, 'an adults annotation does not target the reference').toBeTruthy();
    // Quieten select: the jump must land its seek without playing real audio.
    await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const orig = T.transport.select.bind(T.transport);
      T.transport.select = (file: string, time?: number) => orig(file, time, false);
    });
    const state = () =>
      page.evaluate(() => {
        const T = (window as any)._exhibitTest;
        return { file: T.transport.activeFile as string, time: T.transport.time as number };
      });

    // Targeted recording already audible: jump seeks, does not switch.
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${picks.stay!.id}"]`);
    await page.click('.vp[data-viewport="0"] .ann-jump');
    let s = await state();
    expect(s.file).toBe(picks.ref);
    expect(s.time).toBeCloseTo(picks.stay!.start!, 3);

    // Untargeted recording audible: jump switches AND keeps its time.
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${picks.away!.id}"]`);
    await page.click('.vp[data-viewport="0"] .ann-jump');
    s = await state();
    expect(s.file).toBe(picks.away!.file);
    expect(s.time).toBeCloseTo(picks.away!.start!, 3);

    // The A/B off switch hides the button.
    await boot(page, 'detailJump=off');
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${picks.stay!.id}"]`);
    await expect(page.locator('.vp[data-viewport="0"] .ann-jump')).toBeHidden();
  });

  // 37.27 THE MARK BUTTON (?marker=glass): the same landing the jump uses —
  // the annotation's earliest region start on a targeted recording — but it
  // puts this reader's MARKER there. Gated on the marker feature, and it must
  // read as a control rather than as the draggable glass, so the chrome is
  // asserted too: a real <button> with a label, not the glass artwork.
  test('37.27 the mark button places the marker at the annotation start, and is a button not the glass', async ({
    page,
  }) => {
    await boot(page, 'debug=1&marker=glass');
    const pick = await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const ref = T.transport.activeFile as string;
      const earliest = (ann: any, f: string) => {
        const tg = (ann.targets || []).find((t: any) => t.file === f);
        if (!tg) return null;
        let s: number | null = null;
        for (const r of ann.regions || []) {
          const sp = tg.regionTimes?.[r.id];
          if (sp && sp.end > sp.start && (s == null || sp.start < s)) s = sp.start;
        }
        return s;
      };
      const anns = T.exhibit.byAudience['adults'] || [];
      const ann = anns.find((a: any) => earliest(a, ref) != null);
      return ann ? { id: ann.id, file: ref, start: earliest(ann, ref) } : null;
    });
    expect(pick, 'an adults annotation targets the reference').toBeTruthy();
    await page.evaluate(() => {
      const T = (window as any)._exhibitTest;
      const orig = T.transport.select.bind(T.transport);
      T.transport.select = (file: string, time?: number) => orig(file, time, false);
    });
    const marker = (i = 0) =>
      page.evaluate((i) => (window as any)._exhibitTest.marker(i), i);

    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.id}"]`);
    expect((await marker()).ix, 'nothing placed yet').toBeNull();
    await page.click('.vp[data-viewport="0"] .ann-mark');
    const placed = await marker();
    expect(placed.homeFile).toBe(pick!.file);
    // Ground truth for "the annotation's start": placing BY TIME at the
    // earliest region start must land on the very same alignment index.
    const byTime = await page.evaluate(
      ([f, t]) => {
        const T = (window as any)._exhibitTest;
        T.placeMarker(0, f, t);
        return T.marker(0).ix;
      },
      [pick!.file, pick!.start] as [string, number],
    );
    expect(placed.ix).toBe(byTime);
    // The other side sees it, as it does for any placement.
    expect((await marker(1)).ghost).toEqual(
      expect.objectContaining({ file: pick!.file, ix: placed.ix }),
    );

    // It must not be mistakable for the glass: a labelled button with a border
    // and a pointer cursor, carrying none of the glass's own artwork.
    const chrome = await page.evaluate(() => {
      const b = document.querySelector(
        '.vp[data-viewport="0"] .ann-mark',
      ) as HTMLElement;
      const cs = getComputedStyle(b);
      return {
        tag: b.tagName.toLowerCase(),
        text: (b.textContent || '').trim(),
        cursor: cs.cursor,
        bordered: parseFloat(cs.borderTopWidth) > 0,
        labelled: !!b.getAttribute('aria-label'),
        glassParts: b.querySelectorAll(
          '.glass-lens, .glass-ring, .glass-handle, .glass-stitch',
        ).length,
      };
    });
    expect(chrome.tag).toBe('button');
    expect(chrome.text.length, 'the control carries a word, not just a glyph').toBeGreaterThan(0);
    expect(chrome.cursor, 'grab would say "drag me" — the glass on the hook is the draggable one').toBe('pointer');
    expect(chrome.bordered).toBe(true);
    expect(chrome.labelled).toBe(true);
    expect(chrome.glassParts, 'the glass artwork must not appear here').toBe(0);

    // Gated on the feature: no marker, no button.
    await boot(page, 'debug=1');
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${pick!.id}"]`);
    await expect(page.locator('.vp[data-viewport="0"] .ann-mark')).toBeHidden();
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
