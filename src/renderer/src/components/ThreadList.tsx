import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthStatus, ThreadMeta, ThreadSearchHit } from '../../../shared/types';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  LockIcon,
  LogOutIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
} from './icons';

/** Buckets the sidebar groups rows into, newest first. */
type Bucket = 'Today' | 'This Week' | 'Last Week' | 'Earlier';

const BUCKETS: Bucket[] = ['Today', 'This Week', 'Last Week', 'Earlier'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The same wall-clock day shifted by `days` — DST-safe, which raw millisecond arithmetic isn't. */
function shiftDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * First weekday of the locale's week, counted the way Date#getDay() counts (0 = Sunday), so a
 * week breaks where the reader expects it to. Runtimes without week info fall back to ISO Monday.
 */
function localeWeekStart(): number {
  try {
    const locale = new Intl.Locale(new Intl.DateTimeFormat().resolvedOptions().locale) as unknown as {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    // Week info counts 1-7 with 7 = Sunday; Date#getDay() counts 0-6 with 0 = Sunday.
    if (typeof firstDay === 'number') return firstDay % 7;
  } catch {
    // Older runtime with no week info — the fallback below covers it.
  }
  return 1;
}

function startOfWeek(d: Date, weekStart: number): number {
  const day = new Date(startOfDay(d));
  return shiftDays(day.getTime(), -((day.getDay() - weekStart + 7) % 7));
}

function bucketFor(iso: string, now: Date, weekStart: number): Bucket {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Earlier';
  const day = startOfDay(then);
  // Calendar weeks, not rolling 7-day windows: on a Monday, "this week" is one row, not seven.
  if (day >= startOfDay(now)) return 'Today';
  const thisWeek = startOfWeek(now, weekStart);
  if (day >= thisWeek) return 'This Week';
  if (day >= shiftDays(thisWeek, -7)) return 'Last Week';
  return 'Earlier';
}

const HHMM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/**
 * Time as the row's only metadata. Precision falls off with age the way a reader's interest
 * does: minutes today, a named yesterday, weekday + time within the week, a date beyond it.
 */
function timeLabel(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) {
    const mins = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }
  if (days === 1) return `Yesterday ${then.toLocaleTimeString([], HHMM)}`;
  if (days < 7) {
    return `${then.toLocaleDateString([], { weekday: 'short' })} ${then.toLocaleTimeString([], HHMM)}`;
  }
  return then.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Stable id per section, so the header can point `aria-controls` at its own rows. */
function groupId(bucket: Bucket): string {
  return `thread-group-${bucket.toLowerCase().replace(/\s+/g, '-')}`;
}

/** Whitespace-separated terms, all of which must be present for a row to match. */
function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/** Wraps every occurrence of a search term in <mark>, so a snippet shows *why* it matched. */
export function highlight(text: string, terms: string[]): React.ReactNode {
  if (terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'ig');
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    // split() with a capture group puts the matches at the odd indices.
    i % 2 === 1 ? <mark key={i}>{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Debounce before the content query goes over IPC — a keystroke shouldn't cost a scan. */
const SEARCH_DEBOUNCE_MS = 120;
/** A single character matches nearly every conversation; content search starts at two. */
const MIN_CONTENT_QUERY = 2;

export function ThreadList(props: {
  threads: ThreadMeta[];
  appVersion: string;
  activeThreadId: string | null;
  auth: AuthStatus | null;
  /** Rows only show a model badge when they deviate from this. */
  defaultModel: string;
  settingsOpen: boolean;
  /** Looks up message-content matches in the local index; titles are filtered here. */
  searchContent?: (query: string) => Promise<ThreadSearchHit[]>;
  onOpen: (threadId: string) => void;
  onCreate: () => void;
  onDelete: (threadId: string) => void;
  onOpenSettings: () => void;
  onSignOut?: () => void;
}): React.JSX.Element {
  const {
    threads,
    appVersion,
    activeThreadId,
    auth,
    defaultModel,
    settingsOpen,
    searchContent,
    onOpen,
    onCreate,
    onDelete,
    onOpenSettings,
    onSignOut,
  } = props;
  const [query, setQuery] = useState('');
  /** Content matches for `hitsQuery`; titles filter instantly below, without waiting for these. */
  const [hits, setHits] = useState<{ query: string; byThread: Map<string, ThreadSearchHit> }>({
    query: '',
    byThread: new Map(),
  });
  const searchSeq = useRef(0);

  const terms = useMemo(() => queryTerms(query.trim()), [query]);

  useEffect(() => {
    const q = query.trim();
    if (!searchContent || q.length < MIN_CONTENT_QUERY) {
      setHits({ query: q, byThread: new Map() });
      return;
    }
    // Sequence guard: a slow response for an older query must not overwrite a newer one.
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void searchContent(q)
        .then((found) => {
          if (seq !== searchSeq.current) return;
          setHits({ query: q, byThread: new Map(found.map((h) => [h.threadId, h])) });
        })
        .catch(() => {
          if (seq === searchSeq.current) setHits({ query: q, byThread: new Map() });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchContent]);

  // Content hits are only shown for the query they were fetched for, so a stale snippet never
  // sits under a row while the next keystroke's results are in flight.
  const contentHits = useMemo(
    () => (hits.query === query.trim() ? hits.byThread : new Map<string, ThreadSearchHit>()),
    [hits, query],
  );

  // One `now` per render, so every row in a pass agrees on which day it is.
  const groups = useMemo(() => {
    const now = new Date();
    // Every term must appear in the title — identical to the old substring test for a
    // single-word query, and it lets "sql versions" match "what versions of … sql …".
    const matching = terms.length
      ? threads.filter((t) => {
          const title = t.title.toLowerCase();
          return terms.every((term) => title.includes(term)) || contentHits.has(t.id);
        })
      : threads;
    const weekStart = localeWeekStart();
    return BUCKETS.map((bucket) => ({
      bucket,
      rows: matching
        .filter((t) => bucketFor(t.updatedAt, now, weekStart) === bucket)
        .map((thread) => ({ thread, time: timeLabel(thread.updatedAt, now) })),
    })).filter((g) => g.rows.length > 0);
  }, [threads, terms, contentHits]);

  /**
   * Only the newest timeframe is open to begin with — the rest are one click away rather than a
   * scroll away. This holds the sections the reader has since decided otherwise about, so a
   * choice survives the default moving on (a first thread today makes Today the top section).
   */
  const [overrides, setOverrides] = useState<ReadonlyMap<Bucket, boolean>>(() => new Map());
  const topBucket = groups[0]?.bucket;
  const isOpen = (bucket: Bucket): boolean => overrides.get(bucket) ?? bucket === topBucket;
  const toggleBucket = (bucket: Bucket): void =>
    setOverrides((prev) => new Map(prev).set(bucket, !isOpen(bucket)));
  // A search spans every section, so a shut one would silently swallow matches while typing.
  const searching = terms.length > 0;

  return (
    <aside className="thread-list">
      <div className="thread-list-header">
        <span className="app-title">YVOKE</span>
        <button className="primary small" onClick={onCreate} data-tip="New conversation">
          <PlusIcon size={12} />
          New
        </button>
      </div>

      <div className="thread-search">
        <label className="search-field">
          <SearchIcon size={13} />
          <input
            type="text"
            value={query}
            placeholder="Search conversations"
            aria-label="Search conversations"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              data-tip="Clear search"
              onClick={() => setQuery('')}
            >
              <CloseIcon size={12} />
            </button>
          )}
        </label>
      </div>

      <div className="sidebar-rule" />

      <nav className="threads">
        {groups.map(({ bucket, rows }) => {
          const shut = !searching && !isOpen(bucket);
          return (
            <div className="thread-group" key={bucket}>
              <button
                type="button"
                className="thread-group-label"
                aria-expanded={!shut}
                aria-controls={groupId(bucket)}
                onClick={() => toggleBucket(bucket)}
              >
                {shut ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
                <span>{bucket}</span>
                {/* The count only earns its place when the rows it stands in for are hidden. */}
                {shut && <span className="thread-group-count">{rows.length}</span>}
              </button>
              <div id={groupId(bucket)} hidden={shut}>
                {rows.map(({ thread, time }) => (
                  <div
                    key={thread.id}
                    role="button"
                    tabIndex={0}
                    className={`thread-item ${thread.id === activeThreadId && !settingsOpen ? 'active' : ''}`}
                    onClick={() => onOpen(thread.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen(thread.id);
                      }
                    }}
                  >
                    <div className="thread-content">
                      <div className="thread-title" data-tip={thread.title}>
                        {thread.title}
                      </div>
                      {contentHits.get(thread.id) && (
                        <div className="thread-snippet" title={contentHits.get(thread.id)?.snippet}>
                          {highlight(contentHits.get(thread.id)!.snippet, terms)}
                        </div>
                      )}
                      <div className="thread-meta">
                        <span>{time}</span>
                        {thread.orchestratorProfile && <span>· multi-agent</span>}
                        {thread.syncState !== 'synced' && (
                          <span
                            className={`sync-dot ${thread.syncState}`}
                            data-tip={thread.syncState === 'pending' ? 'Waiting to sync' : 'Sync failed'}
                          >
                            ●
                          </span>
                        )}
                      </div>
                    </div>
                    {/* The model is the same on nearly every row — it only earns space when it isn't. */}
                    {thread.model && thread.model !== defaultModel && (
                      <span className="model-badge" data-tip={`Model: ${thread.model}`}>
                        {thread.model}
                      </span>
                    )}
                    <button
                      className="icon-button thread-delete"
                      data-tip="Delete conversation"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${thread.title}"? This removes it from the server too.`)) {
                          onDelete(thread.id);
                        }
                      }}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {threads.length === 0 && <div className="thread-empty">No conversations yet.</div>}
        {threads.length > 0 && groups.length === 0 && (
          <div className="thread-empty">No conversation matches “{query.trim()}”.</div>
        )}
      </nav>

      <div className="thread-list-footer">
        <div className="footer-info">
          <div className="account-chip" data-tip={auth?.claudeAccount ?? auth?.server.account ?? ''}>
            {auth?.claudeAccount ?? (auth?.server.signedIn ? auth.server.account : 'Not signed in')}
          </div>
          <div className="footer-sub-meta">
            {auth && (
              <span
                className="account-mode"
                data-tip={
                  auth.server.mode === 'dev'
                    ? 'Server running with mock security (APP_SECURITY_MOCK)'
                    : 'Authenticated via Microsoft Entra'
                }
              >
                <LockIcon size={10} />
                {auth.server.mode === 'dev' ? 'dev' : 'Entra'}
              </span>
            )}
            {appVersion && <span className="app-version">· v{appVersion}</span>}
          </div>
        </div>
        <div className="footer-actions">
          {auth?.server.signedIn && auth.server.mode === 'entra' && onSignOut && (
            <button className="icon-button" data-tip="Sign out of Entra" onClick={onSignOut}>
              <LogOutIcon size={16} />
            </button>
          )}
          <button className="icon-button" data-tip="Settings" onClick={onOpenSettings}>
            <SettingsIcon size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
