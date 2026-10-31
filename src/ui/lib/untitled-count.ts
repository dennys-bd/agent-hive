// The untitled tabs' numbers (#818), unique across the app's windows (#551): every window loads the same port, so they share one origin and
// its localStorage, and the number stays synchronous for its callers. Storage that throws (disabled, full) falls back to this page's count.
const KEY = 'hive.untitledCount';
let pageCount = 0;

/** The next untitled tab's number (#818, #551), as VS Code's Untitled-N. */
export function nextUntitled(): number {
  try {
    const next = (Number(localStorage.getItem(KEY)) || 0) + 1; // a missing or unreadable value counts from 0
    localStorage.setItem(KEY, String(next));
    return next;
  } catch {
    pageCount += 1;
    return pageCount;
  }
}

// The main window's load starts the count again (#551): a detached window's page carries `window` in its query and counts on
try {
  if (!new URLSearchParams(location.search).has('window')) localStorage.removeItem(KEY);
} catch {
  // storage refused: nothing to clear, and nextUntitled counts on the page's own
}
