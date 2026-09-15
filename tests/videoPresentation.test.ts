// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  injectPresentationOverlay,
  showPresentationSlide,
  unmountPresentationOverlay,
  sanitizeHtml,
  PRESENTATION_SLIDES,
  type PresentationSlide,
} from '../scripts/video/presentation';
import type { Page } from '@playwright/test';

// Ambient declarations for jsdom-backed environment
declare const document: any;
declare const window: any;

describe('videoPresentation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('PRESENTATION_SLIDES definitions', () => {
    it('defines exactly 3 core presentation slides', () => {
      expect(PRESENTATION_SLIDES).toHaveLength(3);
    });

    it('Slide 0 defines Playbooks & Source Scoping with key topics and highlight', () => {
      const slide0 = PRESENTATION_SLIDES[0];
      expect(slide0.title).toContain('Playbooks & Source Scoping');
      const fullText = JSON.stringify(slide0);
      expect(fullText).toContain('Vendor PDFs');
      expect(fullText).toContain('Teams');
      expect(fullText).toContain('Confluence');
      expect(fullText).toContain('Support');
      expect(fullText).toContain('oim-db-history');
      expect(slide0.highlight).toBe('If unsure, use oim-full');
    });

    it('Slide 1 defines Single Agent vs Multi-Agent (OIM MAS) with roles and reviewer gate', () => {
      const slide1 = PRESENTATION_SLIDES[1];
      expect(slide1.title).toMatch(/Single Agent vs Multi-Agent|OIM MAS/);
      const fullText = JSON.stringify(slide1);
      expect(fullText).toContain('Direct query');
      expect(fullText).toContain('Lead Agent');
      expect(fullText).toContain('Specialists');
      expect(fullText).toContain('Automatic Reviewer');
      expect(fullText).toContain('hallucinations');
    });

    it('Slide 2 defines LLM Prompting & Collaboration Best Practices', () => {
      const slide2 = PRESENTATION_SLIDES[2];
      expect(slide2.title).toContain('LLM Prompting & Collaboration Best Practices');
      const fullText = JSON.stringify(slide2);
      expect(fullText).toMatch(/lead\/ops\/dev/);
      expect(fullText).toMatch(/Teams\/Confluence/);
      expect(fullText).toContain('Continue conversation');
    });
  });

  describe('sanitizeHtml', () => {
    it('escapes HTML special characters: &, <, >, ", and \'', () => {
      expect(sanitizeHtml('5 < 10 & 20 > 15')).toBe('5 &lt; 10 &amp; 20 &gt; 15');
      expect(sanitizeHtml('<script>alert("XSS")</script>')).toBe(
        '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;',
      );
      expect(sanitizeHtml("It's 'quoted'")).toBe('It&#39;s &#39;quoted&#39;');
    });
  });

  describe('injectPresentationOverlay', () => {
    it('injects #yvoke-presentation-root into DOM and is strictly idempotent', async () => {
      const mockPage = {
        evaluate: vi.fn(async (fn: any, ...args: any[]) => {
          if (typeof fn === 'function') {
            return fn(...args);
          }
          return undefined;
        }),
      } as unknown as Page;

      // First call: injects the root overlay
      await injectPresentationOverlay(mockPage);
      const roots = document.querySelectorAll('#yvoke-presentation-root');
      expect(roots.length).toBe(1);
      expect(roots[0].id).toBe('yvoke-presentation-root');

      // Second call: must remove existing and re-append, resulting in exactly 1 node
      await injectPresentationOverlay(mockPage);
      const rootsAfterSecond = document.querySelectorAll('#yvoke-presentation-root');
      expect(rootsAfterSecond.length).toBe(1);

      // Third call: still exactly 1
      await injectPresentationOverlay(mockPage);
      expect(document.querySelectorAll('#yvoke-presentation-root').length).toBe(1);
    });
  });

  describe('showPresentationSlide', () => {
    it('throws RangeError if slideIndex is out of range', async () => {
      const mockPage = {
        evaluate: vi.fn(),
      } as unknown as Page;

      await expect(showPresentationSlide(mockPage, -1)).rejects.toThrow(RangeError);
      await expect(showPresentationSlide(mockPage, 3)).rejects.toThrow(RangeError);
      await expect(showPresentationSlide(mockPage, 99)).rejects.toThrow(RangeError);
    });

    it('renders slide content into #yvoke-presentation-root', async () => {
      const mockPage = {
        evaluate: vi.fn(async (fn: any, ...args: any[]) => {
          if (typeof fn === 'function') {
            return fn(...args);
          }
          return undefined;
        }),
      } as unknown as Page;

      await injectPresentationOverlay(mockPage);
      await showPresentationSlide(mockPage, 0);

      const root = document.getElementById('yvoke-presentation-root');
      expect(root).toBeTruthy();
      expect(root.innerHTML).toContain('Playbooks &amp; Source Scoping');
      expect(root.innerHTML).toContain('If unsure, use oim-full');
      expect(root.innerHTML).toContain('Vendor PDFs');
    });

    it('sanitizes HTML special characters in slide texts', async () => {
      const mockPage = {
        evaluate: vi.fn(async (fn: any, ...args: any[]) => {
          if (typeof fn === 'function') {
            return fn(...args);
          }
          return undefined;
        }),
      } as unknown as Page;

      await injectPresentationOverlay(mockPage);

      const maliciousSlide: PresentationSlide = {
        id: 99,
        title: '<img src=x onerror=alert(1)> Title & Test',
        subtitle: '<script>alert("hack")</script>',
        sections: [
          {
            title: 'Section "One"',
            points: ['Point <1> & "quoted" item'],
          },
        ],
        highlight: 'Highlight <bold> & "special"',
      };

      await showPresentationSlide(mockPage, 0, maliciousSlide);

      const root = document.getElementById('yvoke-presentation-root');
      expect(root).toBeTruthy();
      // Should not contain raw script or img tags in DOM
      expect(root.querySelectorAll('script').length).toBe(0);
      expect(root.querySelectorAll('img').length).toBe(0);
      // Raw HTML should be escaped
      expect(root.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(root.innerHTML).toContain('&lt;script&gt;alert(');
      expect(root.innerHTML).toContain('Point &lt;1&gt; &amp;');
      expect(root.innerHTML).toContain('Highlight &lt;bold&gt; &amp;');
      expect(root.textContent).toContain('<script>alert("hack")</script>');
      expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    });
  });

  describe('unmountPresentationOverlay', () => {
    it('removes overlay from DOM cleanly', async () => {
      const mockPage = {
        evaluate: vi.fn(async (fn: any, ...args: any[]) => {
          if (typeof fn === 'function') {
            return fn(...args);
          }
          return undefined;
        }),
      } as unknown as Page;

      await injectPresentationOverlay(mockPage);
      expect(document.getElementById('yvoke-presentation-root')).toBeTruthy();

      await unmountPresentationOverlay(mockPage);
      expect(document.getElementById('yvoke-presentation-root')).toBeNull();
    });

    it('is safe to call when overlay is not mounted in DOM', async () => {
      const mockPage = {
        evaluate: vi.fn(async (fn: any, ...args: any[]) => {
          if (typeof fn === 'function') {
            return fn(...args);
          }
          return undefined;
        }),
      } as unknown as Page;

      // DOM has no overlay
      expect(document.getElementById('yvoke-presentation-root')).toBeNull();
      await expect(unmountPresentationOverlay(mockPage)).resolves.not.toThrow();
      expect(document.getElementById('yvoke-presentation-root')).toBeNull();
    });
  });
});
