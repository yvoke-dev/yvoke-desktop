// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TooltipLayer } from '../../src/renderer/src/components/Tooltip';

/** The layer listens on the document, so anchors are mounted outside the render tree. */
function anchor(tip: string | null, id: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.id = id;
  if (tip !== null) el.dataset.tip = tip;
  document.body.appendChild(el);
  return el;
}

function point(el: Element, type: string): void {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const shown = (): HTMLElement | null => document.getElementById('app-tooltip');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.innerHTML = '';
});

describe('TooltipLayer', () => {
  it('opens after a short delay, not immediately and not after a second', () => {
    render(<TooltipLayer />);
    const a = anchor('Delete conversation', 'a');
    point(a, 'pointerover');
    expect(shown()).toBeNull();
    tick(60);
    expect(shown()).toBeNull();
    tick(60);
    expect(shown()?.textContent).toBe('Delete conversation');
  });

  // The point of the warm window: you pay the delay once, then reading down a list of playbooks
  // answers instantly instead of stuttering on every row.
  it('opens with no delay at all while still warm from the last one', () => {
    render(<TooltipLayer />);
    const a = anchor('first', 'a');
    const b = anchor('second', 'b');
    point(a, 'pointerover');
    tick(120);
    expect(shown()?.textContent).toBe('first');

    point(b, 'pointerover');
    tick(0);
    expect(shown()?.textContent).toBe('second');
  });

  it('goes cold again once the pointer has been away long enough', () => {
    render(<TooltipLayer />);
    const a = anchor('first', 'a');
    const plain = anchor(null, 'plain');
    point(a, 'pointerover');
    tick(120);
    point(plain, 'pointerover');
    tick(1000);

    point(a, 'pointerover');
    tick(0);
    expect(shown()).toBeNull();
    tick(120);
    expect(shown()).not.toBeNull();
  });

  it('closes when the pointer moves to something with no tip', () => {
    render(<TooltipLayer />);
    const a = anchor('first', 'a');
    const plain = anchor(null, 'plain');
    point(a, 'pointerover');
    tick(120);
    expect(shown()).not.toBeNull();
    point(plain, 'pointerover');
    expect(shown()).toBeNull();
  });

  // Any scroller moving under an open tooltip leaves it pointing at the wrong place, so the
  // listener is registered in the capture phase rather than on the page alone.
  it('closes when a nested scroller moves', () => {
    render(<TooltipLayer />);
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    const a = anchor('first', 'a');
    scroller.appendChild(a);
    point(a, 'pointerover');
    tick(120);
    expect(shown()).not.toBeNull();
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(shown()).toBeNull();
  });

  it('closes on Escape', () => {
    render(<TooltipLayer />);
    const a = anchor('first', 'a');
    point(a, 'pointerover');
    tick(120);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(shown()).toBeNull();
  });

  it('opens on keyboard focus, so tabbing reaches the same text', () => {
    render(<TooltipLayer />);
    const a = anchor('Settings', 'a');
    point(a, 'focusin');
    // Focus is deliberate, so it does not wait out the anti-flicker delay.
    expect(shown()?.textContent).toBe('Settings');
  });

  it('points the anchor at the tooltip for assistive tech, and unhooks it on close', () => {
    render(<TooltipLayer />);
    const a = anchor('first', 'a');
    point(a, 'pointerover');
    tick(120);
    expect(a.getAttribute('aria-describedby')).toBe('app-tooltip');
    point(a, 'pointerdown');
    expect(a.getAttribute('aria-describedby')).toBeNull();
    expect(shown()).toBeNull();
  });

  it('ignores an element whose tip is empty', () => {
    render(<TooltipLayer />);
    const a = anchor('', 'a');
    point(a, 'pointerover');
    tick(200);
    expect(shown()).toBeNull();
  });
});
