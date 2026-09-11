#!/usr/bin/env node
// The attract loop's SOAK (plan §7.4): run the loop unattended in headless
// Chromium and sample the page's memory over CDP once a minute, for an hour.
//
// NEVER part of the suite — an hour is an hour, and the point is what a museum
// day does to a page nobody reloads. Run it against a serving exhibit:
//
//   node tools/exhibit_soak.mjs                       # 60 min, the staff preset, reload OFF
//   node tools/exhibit_soak.mjs --minutes 3 --every 10   # a smoke run
//   node tools/exhibit_soak.mjs --reload on           # does the reload-in-the-gap flush suffice?
//   node tools/exhibit_soak.mjs --screens 2           # the second window mirrors (R7)
//   node tools/exhibit_soak.mjs --params 'attractGapMs=25000&attractAudience=expert'
//
// WHAT IT MEASURES, and why these defaults. The staff preset (study-panel.js) with
// every player kept (playerCache=8), the loop starting after 3 s of idle and the
// silence cut to a few seconds so passes come often, and the RELOAD OFF: that is
// the worst case for a leak, because the reload in the silence is the flush
// the loop carries for exactly this risk, and a soak that reloads every pass
// measures the flush, not the page. Each sample forces a GC first, so the used
// heap is live objects, not garbage waiting; the totals are read from CDP's
// Performance domain (JSHeapUsedSize, Nodes, JSEventListeners, Documents…)
// alongside the page's own facts (players built, bytes warmed, DOM size, the
// loop's phase and pass count, cue overlays left behind). The summary fits a
// line to the used heap after a warm-up and reports the slope in MB per hour —
// the number the §7.4 risk asks for — plus node and listener growth.
//
// The kiosk's autoplay flag is passed so the loop sounds without a gesture, as
// on the museum PC. Samples go to a JSONL file (--out; default in the OS temp
// dir) and to the console. Exit code 0; the judgement is the reader's.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const minutes = Number(arg("minutes", 60));
const everyS = Number(arg("every", 60));
const url = arg("url", process.env.APP_BASE_URL || "http://localhost:5002");
const reload = arg("reload", "off") === "on";
const screens = Math.max(1, Number(arg("screens", 1)));
const gapMs = Number(arg("gap", 6000));
const out = arg("out", path.join(os.tmpdir(), `exhibit-soak-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));

// The staff preset, as study-panel.js defines it, with the loop timers made short.
const params = new URLSearchParams(
  "debug=1&focus=playhead&sideSlot=annotations&detailFade=auto&stageRotation=90&zoomControls=false" +
    "&bandOrientation=mirrored&bandTap=shimmer&theme=parchment&annotationColors=theme" +
    "&turnPolicy=request&tapMode=direct&marker=glass&audienceAll=true&pinExpiry=auto" +
    "&preload=on&playerCache=8&loadingGrace=500&switchCue=arrow&arbiter=broadcast" +
    `&attractAfterIdleMs=3000&attractDuringPlaybackMs=0&attractGapMs=${gapMs}&attractReload=${reload ? 1 : 0}`,
);
for (const [k, v] of new URLSearchParams(arg("params", ""))) params.set(k, v);
const pageUrl = `${url.replace(/\/$/, "")}/exhibit?${params}`;

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1024, height: 1366 } });
const pages = [];
for (let i = 0; i < screens; i++) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[screen ${i}] page error:`, e.message));
  await page.goto(pageUrl);
  await page.evaluate(() => window._exhibitTest.ready);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  // A reload in the gap makes a new document; the domains stay enabled on the
  // target, but say so if a sample ever fails to read.
  pages.push({ i, page, cdp });
}

const facts = () => {
  const T = window._exhibitTest;
  const a = T.attract?.state?.() ?? null;
  return {
    phase: a?.phase ?? null,
    passCount: a?.passCount ?? null,
    mirroring: a?.mirroring ?? null,
    audible: a?.audible ?? null,
    file: T.transport.activeFile,
    time: Math.round(T.transport.time),
    players: T.transport._players?.size ?? null,
    warmBytes: T.transport._bytes?.size ?? null,
    domNodes: document.querySelectorAll("*").length,
    cues: document.querySelectorAll(".switch-cue").length,
    frameMeanMs: T.frames ? +T.frames().mean.toFixed(1) : null,
  };
};

const PICK = ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "JSEventListeners", "Documents", "Frames", "LayoutCount", "RecalcStyleCount", "AudioHandlers"];
const samples = pages.map(() => []);
const started = Date.now();
const fh = fs.openSync(out, "w");

async function sample(n) {
  for (const { i, page, cdp } of pages) {
    const rec = { n, i, t: Math.round((Date.now() - started) / 1000) };
    try {
      await cdp.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdp.send("Performance.getMetrics");
      for (const m of metrics) if (PICK.includes(m.name)) rec[m.name] = m.value;
      // The JS heap misses what the audio tier actually holds: the compressed
      // blobs and decoded chunks are ArrayBuffer BACKING STORES, outside it.
      // Runtime.getHeapUsage reports them (experimental fields; absent = null).
      const heap = await cdp.send("Runtime.getHeapUsage").catch(() => null);
      rec.backingStorageMB = heap?.backingStorageSize != null ? +(heap.backingStorageSize / 1048576).toFixed(1) : null;
      rec.embedderHeapMB = heap?.embedderHeapUsedSize != null ? +(heap.embedderHeapUsedSize / 1048576).toFixed(1) : null;
      Object.assign(rec, await page.evaluate(facts));
    } catch (e) {
      rec.error = String(e.message || e).slice(0, 120); // a reload mid-sample, most likely
    }
    samples[i].push(rec);
    fs.writeSync(fh, JSON.stringify(rec) + "\n");
    const mb = rec.JSHeapUsedSize ? (rec.JSHeapUsedSize / 1048576).toFixed(1) : "?";
    console.log(
      `[${String(rec.t).padStart(5)} s] screen ${i}  heap ${mb} MB  buffers ${rec.backingStorageMB ?? "?"} MB` +
        `  nodes ${rec.Nodes ?? "?"}  listeners ${rec.JSEventListeners ?? "?"}  docs ${rec.Documents ?? "?"}` +
        `  players ${rec.players ?? "?"}  dom ${rec.domNodes ?? "?"}  cues ${rec.cues ?? "?"}  ${rec.phase ?? "-"} pass ${rec.passCount ?? "-"}` +
        (rec.mirroring ? " (mirror)" : "") + (rec.error ? `  ! ${rec.error}` : ""),
    );
  }
}

const total = Math.max(1, Math.round((minutes * 60) / everyS));
console.log(`soak: ${screens} screen(s), ${minutes} min, a sample every ${everyS} s (${total} samples), reload ${reload ? "ON" : "OFF"}\n  ${pageUrl}\n  -> ${out}`);
await sample(0);
for (let n = 1; n <= total; n++) {
  await new Promise((r) => setTimeout(r, everyS * 1000));
  await sample(n);
}

// ---- summary --------------------------------------------------------------------
const slope = (pts) => {
  // least squares of y over x (hours), skipping a warm-up of the first three samples
  const p = pts.slice(3);
  if (p.length < 3) return null;
  const xs = p.map((r) => r.t / 3600);
  const ys = p.map((r) => r.JSHeapUsedSize / 1048576);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let k = 0; k < xs.length; k++) {
    num += (xs[k] - mx) * (ys[k] - my);
    den += (xs[k] - mx) ** 2;
  }
  return den ? num / den : null;
};
for (const { i } of pages) {
  const ok = samples[i].filter((r) => r.JSHeapUsedSize);
  if (!ok.length) {
    console.log(`screen ${i}: no readable samples`);
    continue;
  }
  const first = ok[0], last = ok[ok.length - 1];
  const peak = Math.max(...ok.map((r) => r.JSHeapUsedSize));
  const mb = (b) => (b / 1048576).toFixed(1);
  const s = slope(ok);
  console.log(
    `\nscreen ${i}: heap ${mb(first.JSHeapUsedSize)} -> ${mb(last.JSHeapUsedSize)} MB (peak ${mb(peak)}), ` +
      `slope ${s == null ? "n/a" : s.toFixed(1)} MB/h after warm-up; ` +
      `buffers ${first.backingStorageMB ?? "?"} -> ${last.backingStorageMB ?? "?"} MB; ` +
      `nodes ${first.Nodes} -> ${last.Nodes}; listeners ${first.JSEventListeners} -> ${last.JSEventListeners}; ` +
      `documents ${first.Documents} -> ${last.Documents}; passes ${last.passCount ?? "?"}; ` +
      `${samples[i].filter((r) => r.error).length} unreadable sample(s)`,
  );
}
fs.closeSync(fh);
await browser.close();
