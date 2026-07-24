import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import mermaid from 'mermaid';
import type { CitationRef } from '../../../shared/types';
import { rehypeCitations } from './citationRehype';

// Initialize mermaid once
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  // 'strict' disables raw HTML and click-directives in untrusted diagram source
  // (defense-in-depth behind the CSP).
  securityLevel: 'strict',
});

function Mermaid({ chart }: { chart: string }): React.JSX.Element {
  const [svg, setSvg] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);
  const elementId = React.useId().replace(/:/g, '');

  React.useEffect(() => {
    let active = true;
    const renderChart = async () => {
      try {
        const { svg: renderedSvg } = await mermaid.render(`mermaid-${elementId}`, chart);
        if (active) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
        try {
          const badEl = document.getElementById(`mermaid-${elementId}`);
          if (badEl) badEl.remove();
        } catch { /* ignore */ }
      }
    };
    renderChart();
    return () => {
      active = false;
    };
  }, [chart, elementId]);

  if (error) {
    return (
      <div className="mermaid-error">
        <pre className="mermaid-raw">{chart}</pre>
        <span className="mermaid-error-label">⚠️ Mermaid render error: {error}</span>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading">Rendering diagram...</div>;
  }

  return <div className="mermaid-diagram-container" dangerouslySetInnerHTML={{ __html: svg }} />;
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
    return `\n\n> ⚙️ **Code Execution**\n>\n${content.trim().split('\n').map((line: string) => `> ${line}`).join('\n')}\n\n`;
  });
}

function parseCitationHref(href: string): CitationRef {
  const body = href.slice('citation:'.length);
  const sep = body.indexOf(':');
  const kind = body.slice(0, sep);
  const value = body.slice(sep + 1);
  if (kind === 'file') return { file: value };
  if (kind === 'document') return { documentId: value };
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
          return <pre className="mermaid-raw mermaid-streaming">{chart}</pre>;
        }
        return <Mermaid chart={chart} />;
      }
      return <pre {...rest}>{children}</pre>;
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
