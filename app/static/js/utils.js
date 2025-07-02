/**
 * @param {string} urlstring
 * @returns {string} relative URL (pathname)
 */
export function ensureRelativeURL(url) {
  try {
    url = new URL(url);
    return url.pathname;
  } catch {
    return url;
  }
} // ensureRelativeURL()
