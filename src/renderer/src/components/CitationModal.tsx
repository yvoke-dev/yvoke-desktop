import React, { useEffect } from 'react';
import { Markdown } from './Markdown';
import { CloseIcon } from './icons';
import { isCited, parseSection } from './sectionView';

export interface CitationState {
  loading: boolean;
  text?: string;
  error?: string;
  /**
   * The id the user clicked, when it identifies a passage — a bare `[<uuid>]` marker or the older
   * `[chunk_id=…]` form. A document-level or `[file=…]` citation leaves it unset.
   */
  citedId?: string;
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

  const section = state.text ? parseSection(state.text) : null;

  /*
   * A citation is the claim "THIS passage supports this sentence", so the passage it names is the
   * whole of what the panel owes the reader — and the only thing shown here.
   *
   * `get_section` returns much more than that. Its own description promises an agent that "a
   * chunk_id returns the whole section containing that chunk, not just the chunk", which is the
   * right contract for an agent expanding a search hit and the wrong one for this panel. Measured
   * on one real answer, a 1,357-character cited passage arrived inside 220 passages and 314,064
   * characters.
   *
   * The rest of the section used to be offered behind a labelled disclosure. It was dropped on
   * purpose rather than lost: none of it was in front of the model when it wrote the claim —
   * search_corpus returns chunks one at a time — so offering it invites confirming a claim from
   * text the model never read, and a "context only" label makes that safe to SHOW without making
   * it evidence. Reading a passage in context is a real need, but it is not this panel's, and it
   * is not worth loading a third of a megabyte per click to serve. The server's reviewer playbook
   * gives up get_section for the same reason.
   *
   * This includes the sibling parts of a `(part N/M)` split. Such a passage does end mid-content,
   * but the model that cited it saw it end there too — if the claim leans on what the cut removed,
   * that is a real weakness in the citation, and padding the passage back out would hide it.
   */
  const cited = section?.passages.find((p) => isCited(p, state.citedId));
  // No id, or an id that names nothing in what came back (a document-level citation): fall back to
  // rendering the section whole rather than showing nothing.
  const shown = cited ? [cited] : (section?.passages ?? []);

  const headingLower = section?.heading?.trim().toLowerCase();
  const isHeadingRedundant = Boolean(
    headingLower &&
      (headingLower === 'full document' ||
        Boolean(section?.documentTitle && headingLower === section.documentTitle.trim().toLowerCase()) ||
        Boolean(
          shown[0]?.text &&
            shown[0].text.trimStart().startsWith('#') &&
            /^\s*#+\s+(.+)$/m.exec(shown[0].text)?.[1]?.trim().toLowerCase() === headingLower,
        )),
  );

  return (
    <div className="citation-overlay" onClick={onClose}>
      <div className="citation-modal" onClick={(e) => e.stopPropagation()}>
        <div className="citation-modal-header">
          <span className="citation-modal-title">Citation source</span>
          <button className="icon-button" data-tip="Close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>
        <div className="citation-modal-body">
          {state.loading && <div className="citation-loading">Loading source content…</div>}
          {state.error && <div className="banner error">{state.error}</div>}
          {section && (
            <>
              {section.heading && !isHeadingRedundant && (
                <div className="citation-section-heading">{section.heading}</div>
              )}
              {section.meta && <div className="citation-section-meta">{section.meta}</div>}

              {shown.map((passage, i) => (
                <div key={passage.id ?? i} className="citation-passage">
                  <Markdown content={passage.text} />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
