// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThreadList } from '../../src/renderer/src/components/ThreadList';
import type { ThreadMeta, ThreadSearchHit } from '../../src/shared/types';

function thread(id: string, title: string, updatedAt = '2026-08-01T10:00:00.000Z'): ThreadMeta {
  return {
    id,
    title,
    model: 'sonnet',
    thinkingLevel: 'medium',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    syncState: 'synced',
  };
}

const threads = [
  thread('t1', 'what versions of microsoft sql server'),
  thread('t2', 'New Conversation'),
  thread('t3', 'invoice questions'),
];

function renderList(
  searchContent?: (q: string) => Promise<ThreadSearchHit[]>,
  rows: ThreadMeta[] = threads,
) {
  return render(
    <ThreadList
      threads={rows}
      appVersion="1.0.1"
      activeThreadId={null}
      auth={null}
      defaultModel="sonnet"
      settingsOpen={false}
      searchContent={searchContent}
      onOpen={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onOpenSettings={() => undefined}
    />,
  );
}

function search(value: string): void {
  fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value } });
}

afterEach(() => cleanup());

describe('ThreadList search', () => {
  it('filters on the title without waiting for the content index', () => {
    renderList(() => new Promise(() => undefined)); // never resolves
    search('invoice');
    expect(screen.getByText('invoice questions')).toBeTruthy();
    expect(screen.queryByText('New Conversation')).toBeNull();
  });

  it('matches a title on every term, in any order', () => {
    renderList();
    search('sql versions');
    expect(screen.getByText('what versions of microsoft sql server')).toBeTruthy();
    expect(screen.queryByText('invoice questions')).toBeNull();
  });

  it('surfaces a thread whose messages matched, with the matching excerpt highlighted', async () => {
    const searchContent = vi.fn(async (): Promise<ThreadSearchHit[]> => [
      {
        threadId: 't2',
        matches: 1,
        messageLocalId: 'm1',
        role: 'assistant',
        snippet: '…the retention policy keeps backups for ninety days…',
      },
    ]);
    const { container } = renderList(searchContent);
    search('retention');

    await waitFor(() => expect(screen.getByText('New Conversation')).toBeTruthy());
    expect(searchContent).toHaveBeenCalledWith('retention');
    const mark = container.querySelector('.thread-snippet mark');
    expect(mark?.textContent).toBe('retention');
    // Threads that matched neither title nor content stay filtered out.
    expect(screen.queryByText('invoice questions')).toBeNull();
  });

  it('does not run a content search for a single character', async () => {
    const searchContent = vi.fn(async (): Promise<ThreadSearchHit[]> => []);
    renderList(searchContent);
    search('s');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(searchContent).not.toHaveBeenCalled();
  });

  it('drops a stale snippet when the query moves on', async () => {
    const searchContent = vi.fn(async (query: string): Promise<ThreadSearchHit[]> =>
      query === 'retention'
        ? [{ threadId: 't2', matches: 1, messageLocalId: 'm1', role: 'assistant', snippet: 'retention policy' }]
        : [],
    );
    const { container } = renderList(searchContent);
    search('retention');
    await waitFor(() => expect(container.querySelector('.thread-snippet')).toBeTruthy());

    search('invoice');
    await waitFor(() => expect(container.querySelector('.thread-snippet')).toBeNull());
    expect(screen.getByText('invoice questions')).toBeTruthy();
  });
});

describe('ThreadList grouping', () => {
  // Wednesday afternoon, so "this week" and "last week" are both non-empty whether the runtime's
  // locale starts its week on Sunday or Monday.
  const now = new Date(2026, 7, 19, 15, 0);
  const at = (day: number, hour: number): string => new Date(2026, 7, day, hour, 0).toISOString();

  const dated = [
    thread('d1', 'today thread', at(19, 9)),
    thread('d2', 'this week thread', at(18, 9)),
    thread('d3', 'last week thread', at(12, 9)),
    thread('d4', 'earlier thread', at(4, 9)),
  ];

  function labels(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.thread-group-label span:first-of-type')].map(
      (el) => el.textContent ?? '',
    );
  }

  afterEach(() => vi.useRealTimers());

  function renderDated() {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    return renderList(undefined, dated);
  }

  it('splits rows into today, this week, last week and earlier', () => {
    const { container } = renderDated();
    expect(labels(container)).toEqual(['Today', 'This Week', 'Last Week', 'Earlier']);
  });

  it('names yesterday in the row time, now that the group no longer does', () => {
    renderDated();
    expect(screen.getByText(/^Yesterday /)).toBeTruthy();
  });

  it('opens only the newest timeframe, leaving the older ones shut', () => {
    const { container } = renderDated();
    const shut = (id: string): boolean =>
      container.querySelector(id)?.hasAttribute('hidden') ?? false;
    expect(shut('#thread-group-today')).toBe(false);
    expect(shut('#thread-group-this-week')).toBe(true);
    expect(shut('#thread-group-last-week')).toBe(true);
    expect(shut('#thread-group-earlier')).toBe(true);
  });

  it('keeps a section the reader opened open once a newer one takes the top slot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    // Nothing today yet, so "This Week" leads and starts open; the reader opens "Earlier" too.
    const older = dated.filter((t) => t.id !== 'd1');
    const { container, rerender } = renderList(undefined, older);
    fireEvent.click(screen.getByRole('button', { name: /Earlier/ }));
    expect(container.querySelector('#thread-group-earlier')?.hasAttribute('hidden')).toBe(false);

    rerender(
      <ThreadList
        threads={dated}
        appVersion="1.0.1"
        activeThreadId={null}
        auth={null}
        defaultModel="sonnet"
        settingsOpen={false}
        onOpen={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(container.querySelector('#thread-group-earlier')?.hasAttribute('hidden')).toBe(false);
  });

  it('collapses a section on click and shows how many rows it hides', () => {
    const { container } = renderDated();
    const today = screen.getByRole('button', { name: /Today/ });

    fireEvent.click(today);
    expect(today.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#thread-group-today')?.hasAttribute('hidden')).toBe(true);
    expect(today.querySelector('.thread-group-count')?.textContent).toBe('1');

    fireEvent.click(today);
    expect(container.querySelector('#thread-group-today')?.hasAttribute('hidden')).toBe(false);
  });

  it('reopens a collapsed section while searching, so no match stays hidden', () => {
    const { container } = renderDated();
    fireEvent.click(screen.getByRole('button', { name: /Today/ }));

    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'today' } });
    expect(container.querySelector('#thread-group-today')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('today thread')).toBeTruthy();
  });
});
