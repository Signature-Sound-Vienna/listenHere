// The alignment worker's script, fetched once as the page loads and handed to
// every worker as a blob: URL (fix mode, Add recordings, the wizard).
//
// Why not `new Worker(url)`: on an HTTP/1.1 server (Flask's dev server)
// Firefox allows 6 connections per host:port, and the listen page's <audio>
// elements keep theirs open once they have read the start of their file. With
// a dozen recordings on the page, a worker requested later waits for a free
// connection that never comes: correction mode stuck at "Step 2/4: align
// runtime…", with no error and no request in the server log. This module is
// evaluated before listen.js fetches the alignment, so its request goes out
// ahead of every audio stream; a worker created afterwards needs no network.

const WORKER_PATH = "js/align-worker.js";

/** The worker script's own address: what a test's worker factory is given,
 *  and the fallback while the text is not yet in. */
export function alignWorkerUrl() {
  return window.root + WORKER_PATH;
}

let _blobUrl = null;

const _ready =
  typeof window !== "undefined" && window.root != null
    ? fetch(alignWorkerUrl())
        .then((resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.text();
        })
        .then((text) => {
          // sourceURL keeps the file's name in stack traces and the debugger.
          const name = new URL(alignWorkerUrl(), window.location.href).href;
          _blobUrl = URL.createObjectURL(
            new Blob([text, `\n//# sourceURL=${name}\n`], { type: "text/javascript" }),
          );
        })
        .catch((e) => {
          console.warn("align worker: script prefetch failed (workers load it by URL):", e);
        })
    : Promise.resolve();

/** Settles once the script text is in memory, or its fetch failed. */
export function alignWorkerSourceReady() {
  return _ready;
}

/** A new alignment worker: from the prefetched text when it is in, else by URL. */
export function createAlignWorker() {
  return new Worker(_blobUrl || alignWorkerUrl());
}
