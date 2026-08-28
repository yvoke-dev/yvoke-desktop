import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import mermaid from 'mermaid';
import type { CitationRef } from '../../../shared/types';
import { rehypeCitations } from './citationRehype';
import { CopyButton, CopyImageButton, copySvgAsPng } from './CopyButton';
import { MaximizeIcon } from './icons';
import { DiagramModal } from './DiagramModal';
import { sanitizeMermaidStages } from './mermaidSanitizer';

/** Recursively extracts plain text from React nodes inside code blocks. */
function extractCodeText(node: React.ReactNode): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractCodeText).join('');
  if (React.isValidElement(node)) {
    return extractCodeText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * Mermaid bakes its palette into the SVG at render time, so it cannot follow a CSS variable —
 * it has to be re-initialised and re-rendered when the appearance changes. A diagram drawn with
 * the light palette on a dark canvas is the classic "one component missed the theme" bug.
 */
function useDarkAppearance(): boolean {
  const [dark, setDark] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches,
  );
  React.useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return !!dark;
}

function initMermaid(dark: boolean): void {
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    fontFamily: "'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    fontSize: 13,
    themeVariables: {
      fontFamily: "'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      fontSize: '13px',
    },
    flowchart: {
      useMaxWidth: false,
      nodeSpacing: 30,
      rankSpacing: 35,
      padding: 8,
    },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    journey: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    pie: { useMaxWidth: false },
    quadrantChart: { useMaxWidth: false },
    xyChart: { useMaxWidth: false },
    requirement: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
    gitGraph: { useMaxWidth: false },
    c4: { useMaxWidth: false },
    sankey: { useMaxWidth: false },
    block: { useMaxWidth: false },
    // 'strict' disables raw HTML and click-directives in untrusted diagram source
    // (defense-in-depth behind the CSP).
    securityLevel: 'strict',
  });
}

function Mermaid({ chart }: { chart: string }): React.JSX.Element {
  const [svg, setSvg] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);
  const [appliedFixes, setAppliedFixes] = React.useState<string[]>([]);
  const [isZoomOpen, setIsZoomOpen] = React.useState<boolean>(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const elementId = React.useId().replace(/:/g, '');
  const dark = useDarkAppearance();

  React.useEffect(() => {
    let active = true;

    /** Mermaid leaves the half-built node behind when it throws; it would otherwise accumulate. */
    const dropFailedNode = (id: string): void => {
      try {
        document.getElementById(id)?.remove();
      } catch { /* ignore */ }
    };

    const renderChart = async () => {
      initMermaid(dark);

      // Attempt 1: the chart exactly as the model emitted it.
      try {
        const { svg: renderedSvg } = await mermaid.render(`mermaid-${elementId}`, chart);
        if (active) {
          setSvg(renderedSvg);
          setError(null);
          setAppliedFixes([]);
        }
        return;
      } catch (firstErr) {
        dropFailedNode(`mermaid-${elementId}`);

        // Attempts 2..n: repaired variants, safest first, so a lossy repair is only reached once
        // the harmless ones have been shown not to help. Each variant needs its own element id —
        // reusing one would collide with the node a previous failed attempt just left behind.
        const stages = sanitizeMermaidStages(chart);
        for (const [index, stage] of stages.entries()) {
          if (!active) return;
          const stageId = `mermaid-repaired-${index}-${elementId}`;
          try {
            const { svg: sanitizedSvg } = await mermaid.render(stageId, stage.sanitized);
            if (active) {
              setSvg(sanitizedSvg);
              setError(null);
              setAppliedFixes(stage.appliedFixes);
            }
            return;
          } catch {
            dropFailedNode(stageId);
          }
        }

        // Nothing parsed: report the failure against the chart as written, not against a repair.
        if (active) {
          setError(firstErr instanceof Error ? firstErr.message : String(firstErr));
          setAppliedFixes([]);
        }
      }
    };
    renderChart();
    return () => {
      active = false;
    };
  }, [chart, elementId, dark]);

  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-actions">
          <CopyButton text={chart} tip="Copy Mermaid source" />
        </div>
        <pre className="mermaid-raw">{chart}</pre>
        <span className="mermaid-error-label">Mermaid render error: {error}</span>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading">Rendering diagram...</div>;
  }

  return (
    <div className="mermaid-wrapper">
      {appliedFixes.length > 0 && (
        <div
          className="mermaid-repaired-marker"
          title={`Auto-repaired diagram syntax:\n• ${appliedFixes.join('\n• ')}`}
          aria-label="Auto-repaired diagram syntax"
        >
          <span className="mermaid-repaired-icon" aria-hidden="true">✨</span>
          <span>Auto-repaired syntax</span>
        </div>
      )}
      <div className="mermaid-diagram-box">
        <div className="mermaid-actions">
          <CopyButton text={chart} tip="Copy Mermaid source" />
          <CopyImageButton onCopy={() => copySvgAsPng(containerRef.current, svg)} tip="Copy diagram as image" />
          <button
            type="button"
            className="icon-button"
            onClick={() => setIsZoomOpen(true)}
            data-tip="Zoom and inspect diagram"
            aria-label="Zoom and inspect diagram"
          >
            <MaximizeIcon size={14} />
          </button>
        </div>
        <div
          ref={containerRef}
          className="mermaid-diagram-container"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      {isZoomOpen && (
        <DiagramModal
          svg={svg}
          chart={chart}
          onClose={() => setIsZoomOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Rewrites the one construct that genuinely has to happen before parsing: `<code-execution>` is a
 * custom tag the model emits, and it becomes a blockquote, which is markdown syntax.
 *
 * Citation markers are deliberately NOT handled here any more — they are rewritten after parsing by
 * rehypeCitations. Doing it on the raw string was markdown-unaware and corrupted real content:
 * `[2](https://ex.com)` was severed with its URL leaking into the prose, and `args[1]` inside a
 * fenced block came out as a mangled link.
 */
function preprocessMarkdown(md: string): string {
  return md.replace(/<code-execution>([\s\S]*?)<\/code-execution>/g, (_m, content) => {
    return `\n\n> **Code execution**\n>\n${content.trim().split('\n').map((line: string) => `> ${line}`).join('\n')}\n\n`;
  });
}

function parseCitationHref(href: string): CitationRef {
  const body = href.slice('citation:'.length);
  const sep = body.indexOf(':');
  const kind = body.slice(0, sep);
  const value = body.slice(sep + 1);
  if (kind === 'file') return { file: value };
  if (kind === 'document') return { documentId: value };
  // A bare `[<uuid>]` marker — the current server format. Kept distinct from `chunk` rather than
  // folded into it: which table the uuid names is unknown here, and resolving it is the lookup's
  // job (McpPrompts.getSection), not the parser's.
  if (kind === 'id') return { id: value };
  return { chunkId: value };
}

export const Markdown = React.memo(function Markdown(props: {
  content: string;
  onCitation?: (ref: CitationRef) => void;
  /**
   * When true, the content is still streaming. An unterminated mermaid fence would otherwise be
   * parsed as an incomplete diagram and re-rendered on every delta (throws + DOM churn), so while
   * live we render mermaid blocks as a plain preformatted placeholder instead of mounting the
   * renderer. Finalized messages omit this and render diagrams normally.
   */
  live?: boolean;
}): React.JSX.Element {
  const { content, onCitation, live } = props;
  // Citation rewriting is a rehype plugin now, gated the same way: without an onCitation handler
  // there is nothing to click, so the markers stay plain text.
  const text = preprocessMarkdown(content);

  const markdownComponents = React.useMemo(() => ({
    pre({ children, ...rest }: any) {
      const codeChild = React.Children.toArray(children).find(
        (child): child is React.ReactElement<{ className?: string; children?: React.ReactNode }> =>
          React.isValidElement(child) &&
          child.type === 'code' &&
          String((child.props as { className?: string }).className || '').includes('language-mermaid')
      );
      if (codeChild && React.isValidElement(codeChild)) {
        const chart = String(codeChild.props.children || '').replace(/\n$/, '');
        // While streaming, defer diagram rendering — show the raw source as a placeholder.
        if (live) {
          return (
            <div className="code-block-wrapper">
              <div className="code-block-actions">
                <CopyButton text={chart} tip="Copy Mermaid source" />
              </div>
              <pre className="mermaid-raw mermaid-streaming">{chart}</pre>
            </div>
          );
        }
        return <Mermaid chart={chart} />;
      }
      const codeText = extractCodeText(children).replace(/\n$/, '');
      return (
        <div className="code-block-wrapper">
          <div className="code-block-actions">
            <CopyButton text={codeText} tip="Copy code" />
          </div>
          <pre {...rest}>{children}</pre>
        </div>
      );
    },
    a({ href, children, ...rest }: any) {
      if (onCitation && href && href.startsWith('citation:')) {
        const ref = parseCitationHref(href);
        return (
          <button type="button" className="citation-link" onClick={() => onCitation(ref)}>
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer" {...rest}>
          {children}
        </a>
      );
    },
  }), [onCitation, live]);

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={onCitation ? [rehypeKatex, rehypeCitations] : [rehypeKatex]}
        // The private citation: scheme must be listed. defaultUrlTransform allows only
        // http/https/irc/ircs/mailto/xmpp and rewrites anything else to '', which would erase
        // every citation href and leave the `a` branch above unreachable. ([N] markers are plain
        // <sup> nodes, not links, so no scheme is involved.)
        urlTransform={(url) => (url.startsWith('citation:') ? url : defaultUrlTransform(url))}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
