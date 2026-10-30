// A fetch that keeps within a pod host's request limit.
//
// solidcommunity.net throttles to about 20 requests per 10 seconds, and every
// authenticated request is preceded by a CORS preflight, so about 10 requests
// per 10 seconds get through. Over the limit the server answers 429 WITHOUT an
// Access-Control-Allow-Origin header: the browser then hides the status and
// Retry-After and the page sees only a bare TypeError. So the limit is kept
// in advance, per host, and a TypeError from a limited host is retried after a
// cool-down as if it had been a 429.
// The figure is a colleague's report (Oct 2026), not measured here: tune it in
// `hostLimits`.

export const hostLimits = [
  { hostSuffix: "solidcommunity.net", max: 8, windowMs: 10000 },
];

// Safe to send twice: a request that reached the server but whose response was
// lost does no harm. (A PUT repeated after a lost reply meets 412 at worst, and
// the callers already handle that.)
const REPEATABLE = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

const MAX_RETRY_AFTER_MS = 60000;

function limitFor(url, limits) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch (_) {
    return null; // not a URL: let the real fetch report it
  }
  return (
    limits.find(
      (l) => host === l.hostSuffix || host.endsWith("." + l.hostSuffix),
    ) || null
  );
}

function retryAfterMs(resp, fallbackMs) {
  const seconds = Number(resp.headers && resp.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : fallbackMs;
}

/**
 * @param {(input, init?) => Promise<Response>} baseFetch
 * @param {object} [opts]
 * @param {Array} [opts.limits] host limits, as `hostLimits`
 * @param {number} [opts.retries] extra attempts after a 429 or a TypeError
 * @param {() => number} [opts.now] clock in ms (for tests)
 * @param {(ms: number) => Promise<void>} [opts.sleep] wait (for tests)
 */
export function createLimitedFetch(baseFetch, opts = {}) {
  const {
    limits = hostLimits,
    retries = 2,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const states = new Map(); // limit → { stamps, cooldownUntil, tail }

  function stateFor(limit) {
    if (!states.has(limit)) {
      states.set(limit, {
        stamps: [],
        cooldownUntil: 0,
        tail: Promise.resolve(),
      });
    }
    return states.get(limit);
  }

  // Requests are admitted one at a time, in arrival order, so a burst queues
  // behind the window instead of all finding it free at once.
  function admit(state, limit) {
    const run = state.tail.then(async () => {
      for (;;) {
        const t = now();
        while (
          state.stamps.length &&
          t - state.stamps[0] >= limit.windowMs
        ) {
          state.stamps.shift();
        }
        if (t < state.cooldownUntil) {
          await sleep(state.cooldownUntil - t);
        } else if (state.stamps.length >= limit.max) {
          await sleep(state.stamps[0] + limit.windowMs - t);
        } else {
          state.stamps.push(t);
          return;
        }
      }
    });
    state.tail = run.catch(() => {});
    return run;
  }

  return async function limitedFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const limit = url ? limitFor(url, limits) : null;
    if (!limit) return baseFetch(input, init);
    const state = stateFor(limit);
    const method = (
      (init && init.method) ||
      (typeof input !== "string" && input.method) ||
      "GET"
    ).toUpperCase();
    const repeatable = REPEATABLE.has(method);
    for (let attempt = 0; ; attempt++) {
      await admit(state, limit);
      let resp;
      try {
        resp = await baseFetch(input, init);
      } catch (err) {
        if (!(err instanceof TypeError) || !repeatable || attempt >= retries) {
          throw err;
        }
        state.cooldownUntil = now() + limit.windowMs;
        continue;
      }
      if (resp.status === 429 && repeatable && attempt < retries) {
        state.cooldownUntil = now() + retryAfterMs(resp, limit.windowMs);
        continue;
      }
      return resp;
    }
  };
}

/** The auth library, with `fetch` replaced by a limited one; the rest passes through. */
export function withLimitedFetch(lib, opts) {
  const limited = createLimitedFetch((input, init) => lib.fetch(input, init), opts);
  return new Proxy(lib, {
    get: (target, prop) => (prop === "fetch" ? limited : Reflect.get(target, prop)),
  });
}
