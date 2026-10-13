/**
 * High-DPI presentation card overlay injection and choreography for automated demo video recording.
 */
import type { Page } from '@playwright/test';

// Ambient types for browser-context functions executed inside page.evaluate()
declare const document: any;
declare const window: any;

export interface PresentationCardSection {
  title: string;
  points: string[];
}

export interface PresentationSlide {
  id: number;
  title: string;
  subtitle?: string;
  sections?: PresentationCardSection[];
  highlight?: string;
}

export const PRESENTATION_SLIDES: PresentationSlide[] = [
  {
    id: 0,
    title: 'Playbooks & Source Scoping',
    subtitle: 'Scoping sources accurately for high-precision retrieval',
    sections: [
      {
        title: 'Vendor PDFs vs Teams / Confluence / Support',
        points: [
          'Vendor PDFs provide authoritative technical specifications and architectures',
          'Internal Teams, Confluence, and Support history capture operational fixes and incident triage',
        ],
      },
      {
        title: 'Database & History Scoping',
        points: [
          'Scope queries to oim-db-history for telemetry, migration records, and system logs',
        ],
      },
    ],
    highlight: 'If unsure, use oim-full',
  },
  {
    id: 1,
    title: 'Single Agent vs Multi-Agent (OIM MAS)',
    subtitle: 'Coordinated specialist roles with review gates',
    sections: [
      {
        title: 'Architecture Comparison',
        points: [
          'Direct query: Single generalist model with single-turn context limits',
          'Lead Agent: Orchestrates investigation, routes subtasks, synthesizes findings',
          'Specialists: Domain-expert agents query targeted corpuses in parallel',
          'Automatic Reviewer: Enforces factual consistency and gates against hallucinations',
        ],
      },
    ],
    highlight: 'Automatic Reviewer gate against hallucinations',
  },
  {
    id: 2,
    title: 'LLM Prompting & Collaboration Best Practices',
    subtitle: 'Maximizing precision and actionable output',
    sections: [
      {
        title: 'Role & Persona Scoping',
        points: [
          'Define explicit context (lead/ops/dev) to tailor depth and technical terminology',
          'Provide search hints for Teams/Confluence to guide agent retrieval paths',
        ],
      },
      {
        title: 'Iterative Investigation',
        points: [
          'Continue conversation iteratively instead of restarting fresh threads',
        ],
      },
    ],
    highlight: 'Context: lead/ops/dev | Search hints: Teams/Confluence | Continue conversation',
  },
];

/**
 * Escapes HTML characters to prevent XSS and malformed DOM injections.
 */
export function sanitizeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders slide data into a sanitized high-DPI styled card HTML string.
 */
export function renderSlideHtml(slide: PresentationSlide): string {
  const title = sanitizeHtml(slide.title);
  const subtitle = slide.subtitle
    ? `<div class="yvoke-card-subtitle" style="font-size: 16px; color: #94a3b8; margin-bottom: 24px;">${sanitizeHtml(slide.subtitle)}</div>`
    : '';

  let sectionsHtml = '';
  if (slide.sections && slide.sections.length > 0) {
    sectionsHtml = slide.sections
      .map((sec) => {
        const secTitle = sanitizeHtml(sec.title);
        const points = sec.points
          .map(
            (pt) =>
              `<li style="margin-bottom: 8px; line-height: 1.5;">${sanitizeHtml(pt)}</li>`,
          )
          .join('');
        return `<div class="yvoke-card-section" style="margin-bottom: 20px;">
          <div style="font-size: 18px; font-weight: 600; color: #e2e8f0; margin-bottom: 8px;">${secTitle}</div>
          <ul style="padding-left: 24px; color: #cbd5e1; margin: 0;">${points}</ul>
        </div>`;
      })
      .join('');
  }

  const highlightHtml = slide.highlight
    ? `<div class="yvoke-card-highlight" style="background: rgba(56, 189, 248, 0.12); border-left: 4px solid #38bdf8; border-radius: 4px; padding: 12px 16px; font-size: 15px; font-weight: 600; color: #38bdf8; margin-top: 20px;">${sanitizeHtml(slide.highlight)}</div>`
    : '';

  return `<div class="yvoke-presentation-card" style="background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 16px; padding: 36px 44px; max-width: 820px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f8fafc;">
    <div class="yvoke-card-title" style="font-size: 28px; font-weight: 700; color: #38bdf8; margin-bottom: 6px;">${title}</div>
    ${subtitle}
    ${sectionsHtml}
    ${highlightHtml}
  </div>`;
}

/**
 * Injects #yvoke-presentation-root into the DOM with high-DPI styles.
 * Safe to call multiple times (strictly idempotent).
 */
export async function injectPresentationOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as any;
    win.__name = win.__name || function (t: any) { return t; };

    const existing = document.getElementById('yvoke-presentation-root');
    if (existing) {
      existing.remove();
    }

    const root = document.createElement('div');
    root.id = 'yvoke-presentation-root';
    root.style.cssText =
      'position: fixed; inset: 0; z-index: 999999; display: flex; align-items: center; justify-content: center; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(8px); opacity: 1; transition: opacity 0.25s ease-out; pointer-events: none;';
    document.body.appendChild(root);
  });
}

/**
 * Renders the presentation slide at the given index into #yvoke-presentation-root.
 * Throws RangeError if slideIndex is out of range.
 */
export async function showPresentationSlide(
  page: Page,
  slideIndex: number,
  customSlide?: PresentationSlide,
): Promise<void> {
  const slide = customSlide ?? PRESENTATION_SLIDES[slideIndex];
  if (!slide) {
    throw new RangeError(
      `Invalid slide index: ${slideIndex}. Valid range is 0 to ${PRESENTATION_SLIDES.length - 1}.`,
    );
  }

  const html = renderSlideHtml(slide);

  await page.evaluate((cardHtml: string) => {
    const win = window as any;
    win.__name = win.__name || function (t: any) { return t; };

    let root = document.getElementById('yvoke-presentation-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'yvoke-presentation-root';
      root.style.cssText =
        'position: fixed; inset: 0; z-index: 999999; display: flex; align-items: center; justify-content: center; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(8px); opacity: 1; transition: opacity 0.25s ease-out; pointer-events: none;';
      document.body.appendChild(root);
    }
    root.innerHTML = cardHtml;
  }, html);
}

/**
 * Removes the presentation overlay from the DOM.
 * Safe to call when the overlay is not mounted.
 */
export async function unmountPresentationOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as any;
    win.__name = win.__name || function (t: any) { return t; };

    const root = document.getElementById('yvoke-presentation-root');
    if (!root) {
      return;
    }
    root.remove();
  });
}
