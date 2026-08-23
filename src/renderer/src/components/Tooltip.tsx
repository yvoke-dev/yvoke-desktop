import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The app's own tooltips, replacing the native `title` attribute everywhere.
 *
 * Three reasons not to use `title`: it waits about a second before appearing, it is drawn by the
 * OS so it ignores the app's theme entirely, and on Windows it is a different widget again. This
 * layer is also the only way to show one from inside the slash-autocomplete, which is an
 * `overflow-y: auto` box — a CSS `::after` tooltip would be clipped by it.
 *
 * Usage is one attribute, `data-tip="…"`, on any element. A single delegated listener handles the
 * whole document and one portal renders at the body, so nothing needs a wrapper component and no
 * scroll container can crop the result.
 */

const TIP_ID = 'app-tooltip';

/** Cold-start delay. Long enough not to fire while sweeping a pointer across a list. */
const OPEN_DELAY_MS = 110;
/**
 * After one closes, the next opens with no delay at all. This is what makes reading down a list
 * of playbooks feel immediate: you pay the 110ms once, then every row answers instantly.
 */
const WARM_MS = 600;

/** Distance from the anchor, and the minimum clearance kept from the window edge. */
const GAP = 8;
const EDGE = 8;

interface Tip {
  text: string;
  el: HTMLElement;
}

export function TooltipLayer(): React.JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // Position after render, when the tooltip's own size is known: flip above/below depending on
  // room, centre on the anchor, then clamp so a row near the window edge stays fully visible.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const box = el.getBoundingClientRect();
    const anchor = tip.el.getBoundingClientRect();
    const fitsAbove = anchor.top - box.height - GAP >= EDGE;
    const top = fitsAbove ? anchor.top - box.height - GAP : anchor.bottom + GAP;
    const centred = anchor.left + anchor.width / 2 - box.width / 2;
    const left = Math.max(EDGE, Math.min(centred, window.innerWidth - box.width - EDGE));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.visibility = 'visible';
  }, [tip]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let anchored: HTMLElement | null = null;
    let closedAt = 0;

    const cancel = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const hide = (): void => {
      cancel();
      if (anchored) {
        anchored.removeAttribute('aria-describedby');
        anchored = null;
        closedAt = Date.now();
      }
      setTip((current) => (current === null ? current : null));
    };

    const show = (el: HTMLElement): void => {
      const text = el.dataset.tip;
      if (!text) return;
      anchored = el;
      // Screen readers get the same text a sighted user gets on hover.
      el.setAttribute('aria-describedby', TIP_ID);
      setTip({ text, el });
    };

    const target = (e: Event): HTMLElement | null => {
      const node = e.target;
      if (!(node instanceof Element)) return null;
      return node.closest<HTMLElement>('[data-tip]');
    };

    const onOver = (e: Event): void => {
      const el = target(e);
      if (el === anchored) return;
      hide();
      if (!el?.dataset.tip) return;
      timer = setTimeout(() => show(el), Date.now() - closedAt < WARM_MS ? 0 : OPEN_DELAY_MS);
    };

    // Keyboard users reach the same tooltip by tabbing to the control.
    const onFocus = (e: Event): void => {
      const el = target(e);
      if (el === anchored) return;
      hide();
      if (el?.dataset.tip) show(el);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', hide);
    // Capture phase: a tooltip has to close when ANY scroller moves under it, not just the page.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    document.documentElement.addEventListener('pointerleave', hide);

    return () => {
      cancel();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      document.documentElement.removeEventListener('pointerleave', hide);
    };
  }, []);

  if (!tip) return null;

  return createPortal(
    <div id={TIP_ID} ref={tipRef} className="tooltip" role="tooltip" style={{ visibility: 'hidden' }}>
      {tip.text}
    </div>,
    document.body,
  );
}
