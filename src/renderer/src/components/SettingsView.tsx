import React, { useState } from 'react';
import { DEFAULT_ORCHESTRATOR_SETTINGS } from '../../../shared/types';
import type {
  AppSettings,
  OrchestratorSettings,
  RoleModelConfig,
  ThinkingLevel,
} from '../../../shared/types';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

/** Parse a number field, keeping a cleared/garbage input at 0 rather than NaN. */
function toNumber(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Model dropdown for one role. Options come from the configured model list, plus the current value
 * when settings.json binds a role to a model that is not in it — so opening settings never silently
 * rewrites that binding to whatever happens to be first in the list.
 */
function ModelSelect(props: {
  value: string;
  models: string[];
  onChange: (value: string) => void;
}): React.JSX.Element {
  const options = props.models.includes(props.value)
    ? props.models
    : [props.value, ...props.models].filter(Boolean);
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function ThinkingSelect(props: {
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
}): React.JSX.Element {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as ThinkingLevel)}>
      {THINKING_LEVELS.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}

/** One orchestrator role: the Claude model it runs on and how hard it thinks. */
function RoleRow(props: {
  label: string;
  hint: string;
  value: RoleModelConfig;
  models: string[];
  onChange: (value: RoleModelConfig) => void;
}): React.JSX.Element {
  return (
    <div className="settings-role">
      <div className="settings-role-label">
        {props.label}
        <span className="settings-hint">{props.hint}</span>
      </div>
      <div className="settings-row">
        <label>
          Model
          <ModelSelect
            value={props.value.model}
            models={props.models}
            onChange={(model) => props.onChange({ ...props.value, model })}
          />
        </label>
        <label>
          Thinking
          <ThinkingSelect
            value={props.value.thinkingLevel}
            onChange={(thinkingLevel) => props.onChange({ ...props.value, thinkingLevel })}
          />
        </label>
      </div>
    </div>
  );
}

export function SettingsView(props: {
  settings: AppSettings;
  onSave: (update: Partial<AppSettings>) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(props.settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const orch: OrchestratorSettings = draft.orchestrator ?? DEFAULT_ORCHESTRATOR_SETTINGS;
  const updateOrch = (patch: Partial<OrchestratorSettings>): void =>
    setDraft({ ...draft, orchestrator: { ...orch, ...patch } });

  /**
   * Editing the model list must not leave `defaultModel` pointing at a model that is gone — the
   * select would render blank and save an empty default. Re-point it at the first entry instead.
   */
  const setModels = (models: string[]): void =>
    setDraft({
      ...draft,
      models,
      defaultModel: models.includes(draft.defaultModel) ? draft.defaultModel : (models[0] ?? ''),
    });

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
          Available models (one per line)
          <textarea
            rows={3}
            value={draft.models.join('\n')}
            onChange={(e) =>
              setModels(
                e.target.value
                  .split('\n')
                  .map((m) => m.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
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
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Max turns per message
          <input
            type="number"
            min={0}
            value={draft.maxTurns}
            onChange={(e) => setDraft({ ...draft, maxTurns: toNumber(e.target.value) })}
          />
          <span className="settings-hint">
            Backstop on the single-agent tool-use loop; 0 leaves the SDK default in place.
          </span>
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

      <section>
        <h3>Multi-agent orchestrator</h3>
        <p className="settings-hint">
          Applies to conversations that select a multi-agent profile. The profile decides which
          playbooks run; these settings bind each role to a Claude model and cap its budget.
        </p>
        <RoleRow
          label="Orchestrator"
          hint="Plans the turn, delegates, and writes the final answer."
          value={orch.orchestrator}
          models={draft.models}
          onChange={(v) => updateOrch({ orchestrator: v })}
        />
        <RoleRow
          label="Reviewer"
          hint="Checks the draft answer and returns an approve/reject verdict."
          value={orch.reviewer}
          models={draft.models}
          onChange={(v) => updateOrch({ reviewer: v })}
        />
        <RoleRow
          label="Specialist"
          hint="Sub-agents the orchestrator delegates research to."
          value={orch.specialist}
          models={draft.models}
          onChange={(v) => updateOrch({ specialist: v })}
        />
        <div className="settings-row">
          <label>
            Max review rounds
            <input
              type="number"
              min={0}
              value={orch.maxReviewRounds}
              onChange={(e) => updateOrch({ maxReviewRounds: toNumber(e.target.value) })}
            />
          </label>
          <label>
            Max specialist calls
            <input
              type="number"
              min={0}
              value={orch.maxSpecialistCalls}
              onChange={(e) => updateOrch({ maxSpecialistCalls: toNumber(e.target.value) })}
            />
          </label>
        </div>
        <div className="settings-row">
          <label>
            Orchestrator max turns
            <input
              type="number"
              min={0}
              value={orch.orchestratorMaxTurns}
              onChange={(e) => updateOrch({ orchestratorMaxTurns: toNumber(e.target.value) })}
            />
          </label>
          <label>
            Specialist max turns
            <input
              type="number"
              min={0}
              value={orch.specialistMaxTurns}
              onChange={(e) => updateOrch({ specialistMaxTurns: toNumber(e.target.value) })}
            />
          </label>
        </div>
        <label className="inline">
          <input
            type="checkbox"
            checked={orch.requireReview !== false}
            onChange={(e) => updateOrch({ requireReview: e.target.checked })}
          />
          Enforce review (re-prompt for a reviewer pass, and drive revisions on a non-approval)
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
