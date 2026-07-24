import React, { useState } from 'react';
import type { AppSettings, ThinkingLevel } from '../../../shared/types';

export function SettingsView(props: {
  settings: AppSettings;
  onSave: (update: Partial<AppSettings>) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(props.settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      // onSave rejects if the main process rejects the update (e.g. a non-https serverBaseUrl);
      // keep the panel open and surface the message instead of failing silently.
      await props.onSave(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-view">
      <div className="settings-view-inner">
      <section>
        <h3>Server</h3>
        <label>
          Server base URL
          <input
            value={draft.serverBaseUrl}
            onChange={(e) => setDraft({ ...draft, serverBaseUrl: e.target.value })}
            placeholder="http://localhost:8080"
          />
        </label>
        <label>
          MCP transport
          <select
            value={draft.mcpTransport}
            onChange={(e) => setDraft({ ...draft, mcpTransport: e.target.value as 'sse' | 'http' })}
          >
            <option value="sse">SSE</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </label>
        <label>
          Server authentication
          <select
            value={draft.serverAuthMode}
            onChange={(e) => setDraft({ ...draft, serverAuthMode: e.target.value as 'dev' | 'entra' })}
          >
            <option value="dev">Dev (mock security — APP_SECURITY_MOCK)</option>
            <option value="entra">Entra ID (corporate sign-in)</option>
          </select>
        </label>
        {draft.serverAuthMode === 'entra' && (
          <>
            <label>
              Entra tenant id
              <input
                value={draft.entra.tenantId}
                onChange={(e) => setDraft({ ...draft, entra: { ...draft.entra, tenantId: e.target.value } })}
              />
            </label>
            <label>
              Entra client id (desktop public client)
              <input
                value={draft.entra.clientId}
                onChange={(e) => setDraft({ ...draft, entra: { ...draft.entra, clientId: e.target.value } })}
              />
            </label>
            <label>
              API scope
              <input
                value={draft.entra.scope}
                onChange={(e) => setDraft({ ...draft, entra: { ...draft.entra, scope: e.target.value } })}
              />
            </label>
          </>
        )}
      </section>

      <section>
        <h3>Model</h3>
        <label>
          Default model
          <select value={draft.defaultModel} onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}>
            {draft.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Default thinking level
          <select
            value={draft.defaultThinkingLevel}
            onChange={(e) => setDraft({ ...draft, defaultThinkingLevel: e.target.value as ThinkingLevel })}
          >
            {(['off', 'low', 'medium', 'high'] as ThinkingLevel[]).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section>
        <h3>Web search</h3>
        <label className="inline">
          <input
            type="checkbox"
            checked={draft.webSearch.enabled}
            onChange={(e) => setDraft({ ...draft, webSearch: { ...draft.webSearch, enabled: e.target.checked } })}
          />
          Allow web search (restricted to the domains below)
        </label>
        <label>
          Allowed domains (one per line)
          <textarea
            rows={4}
            value={draft.webSearch.allowedDomains.join('\n')}
            onChange={(e) =>
              setDraft({
                ...draft,
                webSearch: {
                  ...draft.webSearch,
                  allowedDomains: e.target.value
                    .split('\n')
                    .map((d) => d.trim())
                    .filter(Boolean),
                },
              })
            }
          />
        </label>
      </section>

      {error && <div className="banner error">{error}</div>}
      <div className="dialog-actions">
        <button onClick={props.onClose} disabled={saving}>Cancel</button>
        <button className="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="settings-note">
        Model and thinking changes apply to new turns. New conversations use the defaults; existing ones keep their
        per-conversation choice (changeable in the chat header).
      </p>
      </div>
    </div>
  );
}
