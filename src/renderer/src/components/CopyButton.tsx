import React, { useEffect, useRef, useState } from 'react';
import archivoBold from '@fontsource/archivo/files/archivo-latin-700-normal.woff2?inline';
import archivoRegular from '@fontsource/archivo/files/archivo-latin-400-normal.woff2?inline';
import { CheckIcon, CopyIcon, ImageIcon } from './icons';

/**
 * An SVG loaded through `<img>` renders in an isolated document that may not fetch anything —
 * the app's web font included. Mermaid sizes every node box against Archivo's metrics in the live
 * DOM, so unless the face travels inside the SVG the exported PNG re-lays its labels in a fallback
 * font and they no longer fit their boxes. `?inline` resolves these to data URLs at build time,
 * which is what makes them usable from a `file://` renderer, where fetch() is not.
 */
const ARCHIVO_FONT_FACE_CSS = [
  { src: archivoRegular, weight: 400 },
  { src: archivoBold, weight: 700 },
]
  .map(
    ({ src, weight }) =>
      `@font-face{font-family:'Archivo';font-style:normal;font-weight:${weight};src:url(${src}) format('woff2');}`,
  )
  .join('');

/**
 * Writes text to the clipboard. Electron's renderer normally has the async
 * clipboard API, but it needs a secure context and document focus, so fall back
 * to the legacy selection copy rather than silently doing nothing.
 */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy was rejected by the browser.');
  } finally {
    document.body.removeChild(area);
  }
}

/**
 * Renders an SVG element or raw SVG string to an offscreen canvas and copies
 * it as a PNG to the system clipboard (using Electron's native clipboard or browser clipboard API).
 */
export async function copySvgAsPng(container: HTMLElement | null, rawSvg: string): Promise<void> {
  const svgEl = container?.querySelector('svg');
  let svgString = '';
  let width = 800;
  let height = 600;

  if (svgEl) {
    const bbox = svgEl.getBoundingClientRect();
    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        width = parts[2];
        height = parts[3];
      }
    } else if (bbox.width > 0 && bbox.height > 0) {
      width = bbox.width;
      height = bbox.height;
    }
    const clone = svgEl.cloneNode(true) as SVGElement;
    clone.setAttribute('width', `${Math.round(width)}`);
    clone.setAttribute('height', `${Math.round(height)}`);
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    const fontStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    fontStyle.textContent = ARCHIVO_FONT_FACE_CSS;
    clone.insertBefore(fontStyle, clone.firstChild);
    svgString = new XMLSerializer().serializeToString(clone);
  } else if (rawSvg) {
    svgString = rawSvg;
    const match = /viewBox=["']([^"']+)["']/.exec(rawSvg);
    if (match) {
      const parts = match[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        width = parts[2];
        height = parts[3];
      }
    }
    if (!svgString.includes('xmlns="http://www.w3.org/2000/svg"')) {
      svgString = svgString.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (/width=["'][^"']*["']/.test(svgString)) {
      svgString = svgString.replace(/width=["'][^"']*["']/, `width="${Math.round(width)}"`);
    } else {
      svgString = svgString.replace('<svg', `<svg width="${Math.round(width)}"`);
    }
    if (/height=["'][^"']*["']/.test(svgString)) {
      svgString = svgString.replace(/height=["'][^"']*["']/, `height="${Math.round(height)}"`);
    } else {
      svgString = svgString.replace('<svg', `<svg height="${Math.round(height)}"`);
    }
    svgString = svgString.replace(/(<svg[^>]*>)/, `$1<style>${ARCHIVO_FONT_FACE_CSS}</style>`);
  } else {
    throw new Error('No diagram SVG found to copy');
  }

  return new Promise<void>((resolve, reject) => {
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    const img = new Image();

    img.onload = async () => {
      try {
        const scale = 2;
        const canvas = document.createElement('canvas');
        const finalW = Math.max(1, Math.round((width || img.naturalWidth || 800) * scale));
        const finalH = Math.max(1, Math.round((height || img.naturalHeight || 600) * scale));
        canvas.width = finalW;
        canvas.height = finalH;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas 2D context unavailable');
        }

        let bgColor = '#ffffff';
        if (typeof window !== 'undefined') {
          const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
          const computedBg = getComputedStyle(document.documentElement).getPropertyValue('--pane').trim();
          if (computedBg) {
            bgColor = computedBg;
          } else if (isDark) {
            bgColor = '#1e1e1e';
          }
        }

        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, finalW, finalH);

        const pngDataUrl = canvas.toDataURL('image/png');

        // Prefer Electron's native clipboard API when available
        const desktopApi = (window as unknown as { api?: { writeClipboardImage?: (dataUrl: string) => Promise<void> } }).api;
        if (desktopApi?.writeClipboardImage) {
          await desktopApi.writeClipboardImage(pngDataUrl);
          resolve();
          return;
        }

        // Web Clipboard API fallback
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          const pngBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
          if (pngBlob) {
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': pngBlob }),
            ]);
            resolve();
            return;
          }
        }
        throw new Error('Image clipboard copying not supported in this environment');
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = (e) => {
      reject(new Error(`Failed to load SVG into image: ${e}`));
    };

    img.src = dataUrl;
  });
}

/** Icon button that copies `text` verbatim and flips to a checkmark on success. */
export function CopyButton(props: { text: string; tip?: string }): React.JSX.Element {
  const { text, tip = 'Copy as Markdown' } = props;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await writeClipboard(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      className={`icon-button ${copied ? 'copied' : ''}`}
      data-tip={copied ? 'Copied' : tip}
      aria-label={tip}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

/** Icon button that copies an image (via an async action) and flips to a checkmark on success. */
export function CopyImageButton(props: {
  onCopy: () => Promise<void>;
  tip?: string;
  className?: string;
}): React.JSX.Element {
  const { onCopy, tip = 'Copy diagram as image', className = '' } = props;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await onCopy();
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      className={`icon-button ${copied ? 'copied' : ''} ${className}`.trim()}
      data-tip={copied ? 'Copied image' : tip}
      aria-label={tip}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon size={14} /> : <ImageIcon size={14} />}
    </button>
  );
}
