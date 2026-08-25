import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Section 37 — Playhead-driven focus (?focus=playhead, main.js's follow
// machinery)
//
// The wash: focus follows the shared clock through region ENTRIES on the
// audible recording, per viewport in each viewport's own audience list —
// the exhibit's cousin of Listen Here's card wash, and the driver the chip/×
// machine was designed to survive (2026-08-24). The semantics under test:
//
//   * OPT-IN — the default (`manual`) is byte-for-byte the shipped behaviour.
//   * EDGE-DRIVEN — focus changes when the annotation under the playhead
//     CHANGES, never as a per-frame overwrite.
//   * STICKY — leaving a region keeps the focus; blanking the commentary at
//     the moment the visitor started reading it is the worse wash.
//   * PINNABLE — a chip tap pins focus against the wash; the machine's
//     unfocus (below-layout toggle-off, the side panel's ×) releases it, and
//     the wash resumes on the NEXT entry, not the same frame.
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

async function focusOf(page: Page, viewport: number) {
  return page.evaluate(
    (viewport) => (window as any)._exhibitTest.viewports[viewport].focusedId as string | null,
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
    expect(await focusOf(page, 0)).toBeNull();
    expect(await focusOf(page, 1)).toBeNull();
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
    expect(await focusOf(page, 0)).toBe(target.annId);
    expect(await focusOf(page, 1)).toBe(target.annId);
    await expect(
      page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${target.annId}"]`),
    ).toHaveClass(/is-on/);
  });

  // 37.3 STICKY: leaving every region keeps the focus. The wash advances on
  // entries; it never blanks on exits.
  test('37.3 leaving a region keeps the focus (sticky wash)', async ({ page }) => {
    await boot(page, 'focus=playhead');
    const { spans, outside, gapSize } = await spansOnActive(page, 'adults');
    expect(gapSize, 'the reference recording has a gap between adults regions').toBeGreaterThan(1);
    const target = cleanSpans(spans).find((s) => s.start > 1.5)!;
    await seek(page, (target.start + target.end) / 2);
    expect(await focusOf(page, 0)).toBe(target.annId);
    await seek(page, outside);
    expect(await focusOf(page, 0)).toBe(target.annId);
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
    expect(await focusOf(page, 0)).toBeNull();
    await seek(page, outside + 0.3); // one continuous step across it
    expect(await focusOf(page, 0)).toBe(planted.annId);
    // The other half scans its own (real) list: the sweep crossed a real gap,
    // so nothing focused there — per-viewport lists really are per viewport.
    expect(await focusOf(page, 1)).toBeNull();
  });

  // 37.5 The pin, in the default below-strips layout: a chip tap outranks the
  // wash; the same chip's toggle-off releases it, and the wash resumes on the
  // next ENTRY — not by instantly re-grabbing the region it is still inside.
  test('37.5 a chip tap pins focus against the wash; toggle-off releases it', async ({ page }) => {
    await boot(page, 'focus=playhead');
    const { spans, outside } = await spansOnActive(page, 'adults');
    const [first, other] = twoAnnotations(spans);

    await seek(page, (first.start + first.end) / 2);
    expect(await focusOf(page, 0)).toBe(first.annId);

    // Pin a DIFFERENT annotation by tapping its chip.
    const chip = page.locator(`.vp[data-viewport="0"] .ann-chip[data-ann="${other.annId}"]`);
    await chip.click();
    expect(await focusOf(page, 0)).toBe(other.annId);

    // The wash must not overwrite the pin — leave and re-enter a region.
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await focusOf(page, 0)).toBe(other.annId);
    // The other half was never pinned: it followed.
    expect(await focusOf(page, 1)).toBe(first.annId);

    // Toggle the pinned chip off: unfocused, unpinned — and NOT instantly
    // re-focused by the region the playhead is still inside.
    await chip.click();
    expect(await focusOf(page, 0)).toBeNull();

    // The next entry edge resumes the wash.
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await focusOf(page, 0)).toBe(first.annId);
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
    expect(await focusOf(page, 0)).toBe(first.annId);

    // Tap another chip: focus + pin + panel.
    await page.click(`.vp[data-viewport="0"] .ann-chip[data-ann="${other.annId}"]`);
    expect(await focusOf(page, 0)).toBe(other.annId);
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await focusOf(page, 0)).toBe(other.annId); // pinned through the wash

    // × — the machine's one unfocus — releases the pin without an instant
    // re-grab, and the next entry refocuses.
    await page.click('.vp[data-viewport="0"] .side-close');
    expect(await focusOf(page, 0)).toBeNull();
    await seek(page, outside);
    await seek(page, (first.start + first.end) / 2);
    expect(await focusOf(page, 0)).toBe(first.annId);
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
    expect(await focusOf(page, 0)).toBe(target.annId);

    await page.evaluate(() => (window as any)._exhibitTest.audience.set(0, 'kids'));
    const after = await focusOf(page, 0);
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
    expect(await focusOf(page, 1)).toBe(target.annId); // the other half kept its own
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
    expect(await focusOf(page, 0)).toBe(target.annId);
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
    await expect
      .poll(async () => focusOf(page, 0), {
        timeout: 10_000,
        message: 'playback crossed the region start but the wash never focused it',
      })
      .toBe(target!.annId);
  });
});
