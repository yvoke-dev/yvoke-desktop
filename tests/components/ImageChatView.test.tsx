// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ChatView } from '../../src/renderer/src/components/ChatView';
import type { LiveTurn } from '../../src/renderer/src/App';
import type {
  AppSettings,
  ChatMessage,
  ImageAttachment,
  McpPromptInfo,
  ThreadMeta,
} from '../../src/shared/types';

const THREAD: ThreadMeta = {
  id: 't1',
  title: 'Image Conversation',
  model: 'sonnet',
  thinkingLevel: 'medium',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  syncState: 'synced',
};

const IDLE: LiveTurn = { running: false, liveText: '', liveThinking: '', blocks: [] };

function testSettings(): AppSettings {
  return {
    serverBaseUrl: 'https://example.invalid',
    mcpTransport: 'http',
    serverAuthMode: 'dev',
    entra: { tenantId: '', clientId: '', scope: '' },
    models: ['sonnet'],
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'medium',
    webSearch: { enabled: false, allowedDomains: [] },
    maxTurns: 25,
  };
}

describe('ChatView Image UI & Interactions', () => {
  let onSend: Mock<(text: string, promptName?: string, images?: ImageAttachment[]) => void>;

  beforeEach(() => {
    onSend = vi.fn();
    (window as any).api = {
      validatePlaybook: vi.fn().mockResolvedValue({ plausible: true }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders attached images on user messages and opens lightbox on click', async () => {
    const sampleImage: ImageAttachment = {
      id: 'img-1',
      mediaType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      name: 'diagram.png',
      size: 2048,
    };

    const userMessage: ChatMessage = {
      localId: 'msg-1',
      role: 'user',
      content: 'Here is the diagram',
      images: [sampleImage],
      createdAt: new Date().toISOString(),
    };

    const { container } = render(
      <ChatView
        thread={THREAD}
        settings={testSettings()}
        messages={[userMessage]}
        prompts={[]}
        profiles={[]}
        liveTurn={IDLE}
        onSend={onSend}
        onInterrupt={() => undefined}
        onPatchThread={() => undefined}
        onFeedback={async () => undefined}
      />,
    );

    const imageCard = container.querySelector('.user-image-card');
    expect(imageCard).not.toBeNull();
    expect(screen.getByText('diagram.png')).not.toBeNull();

    // Click card to open lightbox
    fireEvent.click(imageCard!);

    const modal = container.querySelector('.image-lightbox-modal');
    expect(modal).not.toBeNull();
    expect(container.querySelector('.lightbox-name')?.textContent).toBe('diagram.png');
    expect(container.querySelector('.lightbox-meta')?.textContent).toBe('(2.0 KB)');

    // Verify download link
    const downloadLink = container.querySelector<HTMLAnchorElement>('.lightbox-action-btn');
    expect(downloadLink).not.toBeNull();
    expect(downloadLink?.getAttribute('download')).toBe('diagram.png');
    expect(downloadLink?.getAttribute('href')).toBe(`data:image/png;base64,${sampleImage.data}`);

    // Press Escape to close lightbox
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.image-lightbox-modal')).toBeNull();
  });

  it('exposes message thumbnails as real buttons so they are reachable by keyboard', () => {
    const sampleImage: ImageAttachment = {
      id: 'img-1',
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
      name: 'diagram.png',
    };
    const userMessage: ChatMessage = {
      localId: 'msg-1',
      role: 'user',
      content: 'Here is the diagram',
      images: [sampleImage],
      createdAt: new Date().toISOString(),
    };

    const { container } = render(
      <ChatView
        thread={THREAD}
        settings={testSettings()}
        messages={[userMessage]}
        prompts={[]}
        profiles={[]}
        liveTurn={IDLE}
        onSend={onSend}
        onInterrupt={() => undefined}
        onPatchThread={() => undefined}
        onFeedback={async () => undefined}
      />,
    );

    const card = screen.getByRole('button', { name: 'View diagram.png full size' });
    expect(card.tagName).toBe('BUTTON');

    // Enter on a focused button is a click, which is exactly what a keyboard user gets.
    fireEvent.click(card);
    expect(container.querySelector('.image-lightbox-modal')).not.toBeNull();
  });

  it('handles image paste into textarea and allows sending with images', async () => {
    const { container } = render(
      <ChatView
        thread={THREAD}
        settings={testSettings()}
        messages={[]}
        prompts={[]}
        profiles={[]}
        liveTurn={IDLE}
        onSend={onSend}
        onInterrupt={() => undefined}
        onPatchThread={() => undefined}
        onFeedback={async () => undefined}
      />,
    );

    const textarea = container.querySelector('textarea')!;
    expect(textarea).not.toBeNull();

    // Mock FileReader
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const originalFileReader = window.FileReader;
    class MockFileReader {
      onload: any = null;
      readAsDataURL() {
        setTimeout(() => {
          if (this.onload) {
            this.onload({ target: { result: `data:image/png;base64,${fakeBase64}` } });
          }
        }, 10);
      }
      get result() {
        return `data:image/png;base64,${fakeBase64}`;
      }
    }
    window.FileReader = MockFileReader as any;

    const file = new File(['fake content'], 'pasted.png', { type: 'image/png' });
    const clipboardData = {
      items: [
        {
          type: 'image/png',
          getAsFile: () => file,
        },
      ],
    };

    fireEvent.paste(textarea, { clipboardData });

    await waitFor(() => {
      expect(container.querySelector('.composer-attachments')).not.toBeNull();
      expect(container.querySelector('.attachment-pill-name')?.textContent).toBe('pasted.png');
    });

    // Send button should be enabled even if draft text is empty
    const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
    expect(sendBtn.disabled).toBe(false);

    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('', undefined, expect.arrayContaining([
        expect.objectContaining({
          name: 'pasted.png',
          mediaType: 'image/png',
          data: fakeBase64,
        }),
      ]));
    });

    // Attachments should be cleared after send
    expect(container.querySelector('.composer-attachments')).toBeNull();

    window.FileReader = originalFileReader;
  });

  it('allows removing an attachment from the composer preview strip', async () => {
    const { container } = render(
      <ChatView
        thread={THREAD}
        settings={testSettings()}
        messages={[]}
        prompts={[]}
        profiles={[]}
        liveTurn={IDLE}
        onSend={onSend}
        onInterrupt={() => undefined}
        onPatchThread={() => undefined}
        onFeedback={async () => undefined}
      />,
    );

    const textarea = container.querySelector('textarea')!;

    const fakeBase64 = 'iVBORw0KGgo=';
    const originalFileReader = window.FileReader;
    class MockFileReader {
      onload: any = null;
      readAsDataURL() {
        setTimeout(() => {
          if (this.onload) {
            this.onload({ target: { result: `data:image/png;base64,${fakeBase64}` } });
          }
        }, 10);
      }
      get result() {
        return `data:image/png;base64,${fakeBase64}`;
      }
    }
    window.FileReader = MockFileReader as any;

    const file = new File(['fake content'], 'test.png', { type: 'image/png' });
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ type: 'image/png', getAsFile: () => file }],
      },
    });

    await waitFor(() => {
      expect(container.querySelector('.attachment-pill')).not.toBeNull();
    });

    const removeBtn = container.querySelector('.attachment-pill-remove')!;
    fireEvent.click(removeBtn);

    expect(container.querySelector('.composer-attachments')).toBeNull();
    window.FileReader = originalFileReader;
  });

  it('shows error banner when unsupported file type or oversized file is attached', async () => {
    const { container } = render(
      <ChatView
        thread={THREAD}
        settings={testSettings()}
        messages={[]}
        prompts={[]}
        profiles={[]}
        liveTurn={IDLE}
        onSend={onSend}
        onInterrupt={() => undefined}
        onPatchThread={() => undefined}
        onFeedback={async () => undefined}
      />,
    );

    const textarea = container.querySelector('textarea')!;
    const unsupportedFile = new File(['content'], 'doc.pdf', { type: 'image/svg+xml' });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ type: 'image/svg+xml', getAsFile: () => unsupportedFile }],
      },
    });

    await waitFor(() => {
      expect(container.querySelector('.banner.error')).not.toBeNull();
      expect(container.textContent).toContain('Unsupported image type');
    });

    // Dismiss banner
    const dismissBtn = container.querySelector('.banner-dismiss')!;
    fireEvent.click(dismissBtn);
    expect(container.querySelector('.banner.error')).toBeNull();
  });
});
