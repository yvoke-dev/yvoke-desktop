import React, { useEffect, useState } from 'react';
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
  const [showContext, setShowContext] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Collapse again whenever a different citation is opened, so one expansion does not persist into
  // the next click.
  useEffect(() => setShowContext(false), [state.text, state.citedId]);

  const section = state.text ? parseSection(state.text) : null;

  /*
   * A citation is the claim "THIS passage supports this sentence", so the passage it names is the
   * whole of what the panel owes the reader.
   *
   * `get_section` returns much more than that — its own description promises an agent that "a
   * chunk_id returns the whole section containing that chunk, not just the chunk", which is the
   * right contract for an agent expanding a search hit and the wrong one here. Measured on one real
   * answer, a 1,357-character cited passage arrived inside 220 passages and 314,064 characters.
   *
   * So the cited passage is what is shown, and the rest of the section is kept behind a disclosure
   * rather than dropped: it is genuinely useful for reading a passage in context, but it is NOT
   * evidence. None of it was in front of the model when it wrote the claim — search_corpus returns
   * chunks one at a time — and showing it inline invites confirming a claim from text the model
   * never read. That is the same failure the server's reviewer playbook cites as its reason for
   * giving up get_section entirely.
   *
   * This includes the sibling parts of a `(part N/M)` split. Such a passage does end mid-content,
   * but the model that cited it saw it end there too — if the claim leans on what the cut removed,
   * that is a real weakness in the citation, and padding the passage back out would hide it.
   */
  const cited = section?.passages.find((p) => isCited(p, state.citedId));
  const context = cited ? (section?.passages ?? []).filter((p) => p !== cited) : [];
  // No id, or an id that names nothing in what came back (a document-level citation): fall back to
  // rendering the section whole rather than showing nothing.
  const shown = cited ? [cited] : (section?.passages ?? []);

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
              {section.heading && <div className="citation-section-heading">{section.heading}</div>}
              {section.meta && <div className="citation-section-meta">{section.meta}</div>}

              {shown.map((passage, i) => (
                <div key={passage.id ?? i} className={cited ? 'citation-passage cited' : 'citation-passage'}>
                  <Markdown content={passage.text} />
                </div>
              ))}

              {context.length > 0 && (
                <>
                  <button
                    type="button"
                    className="citation-context-toggle"
                    aria-expanded={showContext}
                    onClick={() => setShowContext((v) => !v)}
                  >
                    {showContext ? 'Hide' : 'Show'} surrounding section ({context.length} more{' '}
                    {context.length === 1 ? 'passage' : 'passages'})
                  </button>
                  {showContext && (
                    <div className="citation-context">
                      {/* Labelled, because this is the one part of the panel that is not evidence. */}
                      <div className="citation-context-note">
                        Context only — not part of the cited source.
                      </div>
                      {context.map((passage, i) => (
                        <div key={passage.id ?? `ctx-${i}`} className="citation-passage">
                          <Markdown content={passage.text} />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
