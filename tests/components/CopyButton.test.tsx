// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopyButton } from '../../src/renderer/src/components/CopyButton';

/** The copy control next to the feedback buttons: it copies the raw Markdown, and says so. */

afterEach(() => cleanup());

describe('CopyButton', () => {
  it('writes the text verbatim to the clipboard and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<CopyButton text={'# Title\n\n- one\n- two'} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Title\n\n- one\n- two'));
    await waitFor(() => expect(screen.getByRole('button').getAttribute('data-tip')).toBe('Copied'));
  });

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;

    render(<CopyButton text="plain" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'));
    await waitFor(() => expect(screen.getByRole('button').getAttribute('data-tip')).toBe('Copied'));
    // The scratch textarea must not linger in the DOM.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('stays uncopied when both paths fail', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false);

    render(<CopyButton text="plain" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByRole('button').getAttribute('data-tip')).toBe('Copy as Markdown'));
  });
});
