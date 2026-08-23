import React, { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';

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
