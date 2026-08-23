/**
 * Setup applied to every test file, jsdom and node alike (`setupFiles` in vitest.config.ts).
 *
 * jsdom implements none of the element scroll methods — `scrollTo`, `scrollIntoView`, `scrollBy`
 * and `scroll` are all undefined on `Element.prototype` (checked against jsdom 29.1.1). Only
 * `window.scrollTo` exists, which is not what a scroll container calls.
 *
 * That makes any scrolling component a TypeError waiting for the right timing rather than a
 * reliable failure. ChatView's auto-scroll is scheduled in a `requestAnimationFrame`, so it throws
 * only when jsdom's frame timer fires while the component is still mounted — which happens in a
 * test that awaits something and not in one that doesn't. The throw is inside jsdom's callback
 * invocation, outside the test's own call stack, so every test still passes and vitest fails the
 * *run* with an unhandled error instead. It stayed green locally and went red on CI; the only
 * difference was machine timing.
 *
 * Stubbing is the right fix rather than guarding the call site: in a real browser these methods
 * always exist, and scroll position is not something a jsdom test can meaningfully assert anyway.
 */
if (typeof Element !== 'undefined') {
  for (const method of ['scrollTo', 'scrollIntoView'] as const) {
    if (typeof Element.prototype[method] !== 'function') {
      Object.defineProperty(Element.prototype, method, {
        value: () => {},
        writable: true,
        configurable: true,
      });
    }
  }
}
