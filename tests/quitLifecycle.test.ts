import { describe, it, expect, vi } from 'vitest';
import { createBeforeQuitHandler } from '../src/main/lifecycle';

/** Lets every queued microtask in the handler's promise chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function hooks(flushLogs: () => Promise<void>) {
  return { dispose: vi.fn(), flushLogs: vi.fn(flushLogs), quit: vi.fn() };
}

describe('createBeforeQuitHandler', () => {
  it('defers the quit and re-issues it only once the log flush has finished', async () => {
    let releaseFlush: () => void = () => {};
    const flushing = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const h = hooks(() => flushing);
    const event = { preventDefault: vi.fn() };

    createBeforeQuitHandler(h)(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.flushLogs).toHaveBeenCalledTimes(1);
    // Electron discards a promise returned from a listener, so the quit cannot simply be
    // awaited: it has to be deferred here and re-issued below.
    expect(h.quit).not.toHaveBeenCalled();

    releaseFlush();
    await settle();

    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it('still quits when the log flush rejects', async () => {
    const h = hooks(() => Promise.reject(new Error('EIO: cannot flush')));
    const event = { preventDefault: vi.fn() };

    createBeforeQuitHandler(h)(event);
    await settle();

    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it('still quits when the log flush throws synchronously', async () => {
    const h = hooks(() => {
      throw new Error('flush exploded before returning a promise');
    });
    const event = { preventDefault: vi.fn() };

    createBeforeQuitHandler(h)(event);
    await settle();

    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it('lets the re-issued quit through instead of deferring it again', async () => {
    const h = hooks(() => Promise.resolve());
    const handler = createBeforeQuitHandler(h);

    const first = { preventDefault: vi.fn() };
    handler(first);
    await settle();

    // This is the quit the handler itself asked for; deferring it again would leave an app
    // that can never be closed.
    const second = { preventDefault: vi.fn() };
    handler(second);
    await settle();

    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.flushLogs).toHaveBeenCalledTimes(1);
  });
});
