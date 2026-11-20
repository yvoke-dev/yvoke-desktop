// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

describe('ThreadList account footer', () => {
  it('renders clickable .footer-account-btn with dual Yvoke + Claude status rows, preserves .account-chip and .account-mode containing "dev" in dev mode, and calls onOpenAccounts', () => {
    const onOpenAccounts = vi.fn();
    const { container } = render(
      <ThreadList
        threads={threads}
        appVersion="1.3.1"
        activeThreadId={null}
        auth={{ claude: 'ok', claudeAccount: 'claude@corp.com', server: { mode: 'dev', signedIn: true } }}
        settingsOpen={false}
        onOpen={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
        onOpenSettings={() => undefined}
        onOpenAccounts={onOpenAccounts}
      />,
    );

    const accountBtn = container.querySelector('button.footer-account-btn') as HTMLButtonElement | null;
    expect(accountBtn).not.toBeNull();
    expect(accountBtn!.type).toBe('button');

    // E2E compatibility selectors inside footer-account-btn
    const accountChip = accountBtn!.querySelector('.account-chip');
    const accountMode = accountBtn!.querySelector('.account-mode');
    expect(accountChip).not.toBeNull();
    expect(accountMode).not.toBeNull();
    expect(accountMode!.textContent).toContain('dev');

    // Dual Yvoke + Claude status rows with ok status dots
    const rows = accountBtn!.querySelectorAll('.account-status-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Yvoke');
    expect(rows[0].querySelector('.account-status-dot.is-ok')).not.toBeNull();
    expect(rows[1].textContent).toContain('Claude');
    expect(rows[1].textContent).toContain('claude@corp.com');
    expect(rows[1].querySelector('.account-status-dot.is-ok')).not.toBeNull();

    // No sign-out button in dev mode
    expect(container.querySelector('[data-tip="Sign out of Yvoke"]')).toBeNull();

    fireEvent.click(accountBtn!);
    expect(onOpenAccounts).toHaveBeenCalledTimes(1);
  });

  it('shows warning/ok status dots and Entra account email, and renders only the Settings action button with zero sign-out buttons in the footer', () => {
    const { container, rerender } = render(
      <ThreadList
        threads={threads}
        appVersion="1.3.1"
        activeThreadId={null}
        auth={{ claude: 'missing', server: { mode: 'entra', signedIn: false } }}
        settingsOpen={false}
        onOpen={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
        onOpenSettings={() => undefined}
        onOpenAccounts={() => undefined}
      />,
    );

    const footer = container.querySelector('.thread-list-footer') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(container.querySelectorAll('.account-status-dot.is-warn')).toHaveLength(2);
    expect(within(footer).queryByRole('button', { name: /sign out/i })).toBeNull();

    // Signed in to both Entra and Claude -> ok status dots, account email shown, still zero sign-out buttons
    rerender(
      <ThreadList
        threads={threads}
        appVersion="1.3.1"
        activeThreadId={null}
        auth={{
          claude: 'ok',
          claudeAccount: 'claude@corp.com',
          server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' },
        }}
        settingsOpen={false}
        onOpen={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
        onOpenSettings={() => undefined}
        onOpenAccounts={() => undefined}
      />,
    );

    expect(container.querySelectorAll('.account-status-dot.is-ok')).toHaveLength(2);
    expect(container.querySelectorAll('.account-status-dot.is-warn')).toHaveLength(0);
    expect(footer.textContent).toContain('alice@corp.com');
    expect(footer.textContent).toContain('claude@corp.com');
    expect(within(footer).queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(container.querySelector('[data-tip="Sign out of Yvoke"]')).toBeNull();

    const footerActionButtons = container.querySelectorAll('.footer-actions button');
    expect(footerActionButtons).toHaveLength(1);
    expect(footerActionButtons[0].getAttribute('aria-label')).toBe('Settings');
  });
});

describe('ThreadList row layout', () => {
  it('renders only title, delete button, and timestamp for a synced row even with non-default model and orchestratorProfile, with zero inline styles', () => {
    const syncedRow: ThreadMeta = {
      ...thread('synced-1', 'Quarterly architecture review'),
      model: 'opus',
      orchestratorProfile: 'oim',
      syncState: 'synced',
    };

    const { container } = renderList(undefined, [syncedRow]);

    const item = container.querySelector('.thread-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(Array.from(item.children).map((el) => el.className)).toEqual(['thread-content']);

    const content = item.querySelector('.thread-content') as HTMLElement;
    expect(Array.from(content.children).map((el) => el.className)).toEqual([
      'thread-header',
      'thread-meta',
    ]);

    const header = content.querySelector('.thread-header') as HTMLElement;
    expect(Array.from(header.children).map((el) => el.className)).toEqual([
      'thread-title',
      'icon-button thread-delete',
    ]);
    expect(header.children).toHaveLength(2);
    expect(header.querySelector('.thread-title')?.textContent).toBe(syncedRow.title);
    expect(container.querySelectorAll('.model-badge')).toHaveLength(0);

    const meta = content.querySelector('.thread-meta') as HTMLElement;
    expect(meta.children).toHaveLength(1);
    expect(meta.children[0].tagName).toBe('SPAN');
    expect(meta.children[0].textContent?.trim().length).toBeGreaterThan(0);
    expect(meta.querySelector('.sync-dot')).toBeNull();
    expect(meta.textContent).not.toContain('multi-agent');

    expect(item.textContent?.toLowerCase()).not.toContain('opus');
    expect(item.textContent?.toLowerCase()).not.toContain('multi-agent');
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it.each(['pending', 'error'] as const)(
    'shows snippet and %s .sync-dot while omitting .model-badge and multi-agent marker during search',
    async (syncState) => {
      const unsyncedRow: ThreadMeta = {
        ...thread(`unsynced-${syncState}`, 'Database migration notes'),
        model: 'opus',
        orchestratorProfile: 'oim',
        syncState,
      };
      const searchContent = vi.fn(async (): Promise<ThreadSearchHit[]> => [
        {
          threadId: unsyncedRow.id,
          matches: 1,
          messageLocalId: 'm1',
          role: 'assistant',
          snippet: '…backup retention schedule keeps snapshots for ninety days…',
        },
      ]);

      const { container } = renderList(searchContent, [unsyncedRow]);
      search('snapshots');
      await waitFor(() => expect(container.querySelector('.thread-snippet')).toBeTruthy());

      const item = container.querySelector('.thread-item') as HTMLElement;
      expect(item).not.toBeNull();
      expect(Array.from(item.children).map((el) => el.className)).toEqual(['thread-content']);

      const content = item.querySelector('.thread-content') as HTMLElement;
      expect(Array.from(content.children).map((el) => el.className)).toEqual([
        'thread-header',
        'thread-snippet',
        'thread-meta',
      ]);

      const header = content.querySelector('.thread-header') as HTMLElement;
      expect(Array.from(header.children).map((el) => el.className)).toEqual([
        'thread-title',
        'icon-button thread-delete',
      ]);
      expect(header.querySelector('.thread-title')?.textContent).toBe(unsyncedRow.title);
      expect(container.querySelectorAll('.model-badge')).toHaveLength(0);

      const meta = content.querySelector('.thread-meta') as HTMLElement;
      expect(meta.children).toHaveLength(2);
      expect(meta.children[0].tagName).toBe('SPAN');
      expect(meta.children[0].textContent?.trim().length).toBeGreaterThan(0);
      expect(meta.children[1].className).toBe(`sync-dot ${syncState}`);
      expect(meta.querySelector(`.sync-dot.${syncState}`)).not.toBeNull();
      expect(meta.textContent).not.toContain('multi-agent');
      expect(item.textContent?.toLowerCase()).not.toContain('opus');
      expect(item.textContent?.toLowerCase()).not.toContain('multi-agent');
    },
  );

  it('stops click propagation on .thread-delete inside .thread-header for both cancelled and confirmed deletes', () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');

    try {
      const { container } = render(
        <ThreadList
          threads={[thread('del-1', 'Conversation to delete')]}
          appVersion="1.3.1"
          activeThreadId={null}
          auth={null}
          settingsOpen={false}
          onOpen={onOpen}
          onCreate={() => undefined}
          onDelete={onDelete}
          onOpenSettings={() => undefined}
        />,
      );

      const deleteBtn = container.querySelector(
        '.thread-content > .thread-header > .thread-delete',
      ) as HTMLButtonElement;
      expect(deleteBtn).not.toBeNull();

      // Cancelled confirm -> neither onDelete nor onOpen fires
      confirmSpy.mockReturnValueOnce(false);
      fireEvent.click(deleteBtn);
      expect(onDelete).toHaveBeenCalledTimes(0);
      expect(onOpen).toHaveBeenCalledTimes(0);

      // Confirmed -> onDelete fires with thread id, onOpen never fires
      confirmSpy.mockReturnValueOnce(true);
      fireEvent.click(deleteBtn);
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith('del-1');
      expect(onOpen).toHaveBeenCalledTimes(0);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('gives .thread-delete type="button" and aria-label="Delete conversation" and prevents Enter/Space keyDown on it from invoking onOpen while keeping .thread-item keyboard activation intact', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <ThreadList
        threads={[thread('kbd-1', 'Keyboard accessible row')]}
        appVersion="1.3.1"
        activeThreadId={null}
        auth={null}
        settingsOpen={false}
        onOpen={onOpen}
        onCreate={() => undefined}
        onDelete={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const deleteBtn = screen.getByRole('button', {
      name: 'Delete conversation',
    }) as HTMLButtonElement;
    expect(deleteBtn.getAttribute('type')).toBe('button');
    expect(deleteBtn.getAttribute('aria-label')).toBe('Delete conversation');

    fireEvent.keyDown(deleteBtn, { key: 'Enter' });
    fireEvent.keyDown(deleteBtn, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(0);

    // Pressing Enter / Space directly on the row itself still opens the conversation
    const row = container.querySelector('.thread-item') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenNthCalledWith(1, 'kbd-1');
    expect(onOpen).toHaveBeenNthCalledWith(2, 'kbd-1');
  });
});
