import React, { useEffect } from 'react';
import { Markdown } from './Markdown';

export interface CitationState {
  loading: boolean;
  text?: string;
  error?: string;
}

/**
 * The section markdown carries invisible raw HTML (per-topic `<a id>` anchors and
 * `<!-- … -->` comments). react-markdown doesn't render HTML, so strip them to avoid
 * leaking literal tags into the popup.
 */
/**
 * Some DB extracts contain markdown table cells with embedded line breaks (bare `\r`
 * or `\n` inside a Description cell — e.g. a bulleted list). CommonMark treats all of
 * `\r`, `\n`, `\r\n` as line endings, so micromark/remark-gfm sees the cell as
 * multi-line, terminates the table, and dumps the remaining rows as raw `| … |` text.
 * Rejoin any table row that a wrapped cell left open (no trailing `|`) into one line.
 */
function joinWrappedTableRows(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*\|/.test(line) && !/\|\s*$/.test(line)) {
      while (i + 1 < lines.length && !/\|\s*$/.test(line)) {
        i++;
        line = line.replace(/\s+$/, '') + ' ' + lines[i].replace(/^\s+/, '');
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

function cleanSection(md: string): string {
  const normalized = md.replace(/\r\n?/g, '\n');
  return joinWrappedTableRows(normalized)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s+id="[^"]*"\s*\/?>(\s*<\/a>)?/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function CitationModal(props: { state: CitationState; onClose: () => void }): React.JSX.Element {
  const { state, onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="citation-overlay" onClick={onClose}>
      <div className="citation-modal" onClick={(e) => e.stopPropagation()}>
        <div className="citation-modal-header">
          <span className="citation-modal-title">Citation Source</span>
          <button className="icon-button" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="citation-modal-body">
          {state.loading && <div className="citation-loading">Loading source content…</div>}
          {state.error && <div className="banner error">{state.error}</div>}
          {state.text && <Markdown content={cleanSection(state.text)} />}
        </div>
      </div>
    </div>
  );
}
