import React, { useState } from 'react';
import { DEFAULT_APPEARANCE, DEFAULT_ORCHESTRATOR_SETTINGS } from '../../../shared/types';
import type {
  AppearanceSettings,
  AppSettings,
  AuthStatus,
  Density,
  OrchestratorSettings,
  RoleModelConfig,
  ThemePreference,
  ThinkingLevel,
} from '../../../shared/types';
import { CloseIcon, MonitorIcon, MoonIcon, SunIcon } from './icons';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

/** Three role columns share the pane width, so the thinking segments get abbreviated labels
 *  rather than an ellipsis in the middle of "medium". */
const THINKING_SHORT: Record<ThinkingLevel, string> = { off: 'off', low: 'low', medium: 'med', high: 'high' };

/** The panes of the settings spine, in nav order. `Advanced` and `About` sit below the divider. */
const PANES = ['Server', 'Models', 'Agents', 'Web search', 'Appearance', 'Advanced', 'About'] as const;
type Pane = (typeof PANES)[number];
const SECONDARY_PANES: Pane[] = ['Advanced', 'About'];

/** Host for the connection card. The field is edited character by character, so a partially
 *  typed URL is the normal case, not an error state. */
function hostOf(base: string): string {
  if (!base.trim()) return 'Not configured';
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** Parse a number field, keeping a cleared/garbage input at 0 rather than NaN. */
function toNumber(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** One domain per line, blanks and stray whitespace dropped. */
function parseDomains(text: string): string[] {
  return text
    .split('\n')
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * Entries that will not behave the way an operator expects. This warns rather than rejects: the
 * allow-list is per-deployment and an intranet host really can be a single label, so the editor
 * should not refuse a save. It flags the two shapes that quietly do the wrong thing — a bare TLD,
 * which matches every site under it, and an entry carrying a path or query, whose extra parts are
 * discarded so the whole domain is allowed rather than just that page.
 */
function suspectDomains(domains: string[]): string[] {
  return domains.filter((d) => {
    const host = d.replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/^\./, '');
    if (/[/?#\s]/.test(host.replace(/\/$/, ''))) return true;
    return !host.replace(/\.$/, '').includes('.');
  });
}

/**
 * A set of mutually exclusive choices rendered as one object rather than a dropdown. Used
 * wherever the options are few and worth comparing at a glance — models, thinking levels,
 * density — which is most of this screen.
 */
function Seg<T extends string>(props: {
  label: string;
  value: T;
  /** `tip` is only for options whose label had to be abbreviated to fit; it spells the value out. */
  options: { value: T; label: string; tip?: string }[];
  wide?: boolean;
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className={`seg ${props.wide ? 'seg-wide' : ''}`} role="group" aria-label={props.label}>
      {props.options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`seg-opt ${opt.value === props.value ? 'selected' : ''}`}
          aria-pressed={opt.value === props.value}
          aria-label={opt.tip ?? opt.label}
          data-tip={opt.tip}
          onClick={() => props.onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One orchestrator role, as a column. Stacked vertically these four numbers and three roles read
 * as unrelated fields; side by side they read as the comparison they actually are.
 */
function RoleCard(props: {
  label: string;
  hint: string;
  value: RoleModelConfig;
  models: string[];
  onChange: (value: RoleModelConfig) => void;
}): React.JSX.Element {
  // A settings.json can bind a role to a model that is not in the list; keep it selectable
  // rather than silently rewriting the binding to whichever model happens to be first.
  const models = props.models.includes(props.value.model)
    ? props.models
    : [props.value.model, ...props.models].filter(Boolean);
  return (
    <div className="role-card">
      <h4>{props.label}</h4>
      <p>{props.hint}</p>
      <div className="role-control-label">Model</div>
      <div className="role-control">
        <Seg
          label={`${props.label} model`}
          value={props.value.model}
          options={models.map((m) => ({ value: m, label: m }))}
          onChange={(model) => props.onChange({ ...props.value, model })}
        />
      </div>
      <div className="role-control-label">Thinking</div>
      <div className="role-control">
        <Seg
          label={`${props.label} thinking`}
          value={props.value.thinkingLevel}
          options={THINKING_LEVELS.map((l) => ({ value: l, label: THINKING_SHORT[l], tip: l }))}
          onChange={(thinkingLevel) => props.onChange({ ...props.value, thinkingLevel })}
        />
      </div>
    </div>
  );
}

/** A budget cap with the consequence of raising it written underneath. */
function CapSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  hint: string;
  /** Cost drivers take the accent; safety ceilings stay neutral so they don't read as a dial. */
  kind: 'cost-driver' | 'safety-cap';
  onChange: (value: number) => void;
}): React.JSX.Element {
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <div className="cap-field">
      <div className="cap-head">
        <span className="cap-name">{props.label}</span>
        <span className="cap-value">{props.value}</span>
      </div>
      <input
        type="range"
        className={props.kind}
        aria-label={props.label}
        min={props.min}
        max={props.max}
        value={props.value}
        style={{ ['--fill' as string]: `${Math.max(0, Math.min(100, pct))}%` }}
        onChange={(e) => props.onChange(toNumber(e.target.value))}
      />
      <div className="settings-hint">{props.hint}</div>
    </div>
  );
}

/**
 * Worst case for one orchestrated turn, in model calls.
 *
 * Bare numbers with no units and no consequence are unsettable — nobody can choose between "8"
 * and "12" specialist calls without knowing what the ceiling costs. Each review round re-runs the
 * whole shape (plan → delegate → review), so the ceiling is rounds × (orchestrator + specialists
 * + reviewer). Calls, not currency: the app has no per-model price table, and a made-up dollar
 * figure would be worse than none.
 */
function worstCase(orch: OrchestratorSettings): {
  total: number;
  orchestrator: number;
  reviewer: number;
  specialist: number;
} {
  const rounds = Math.max(1, orch.maxReviewRounds + 1);
  const specialist = rounds * Math.max(0, orch.maxSpecialistCalls);
  return {
    orchestrator: rounds,
    reviewer: rounds,
    specialist,
    total: rounds * 2 + specialist,
  };
}

function ModelChips(props: {
  models: string[];
  defaultModel: string;
  onChange: (models: string[]) => void;
}): React.JSX.Element {
  const [pending, setPending] = useState('');
  const add = (): void => {
    const name = pending.trim();
    if (!name || props.models.includes(name)) {
      setPending('');
      return;
    }
    props.onChange([...props.models, name]);
    setPending('');
  };
  return (
    <div className="chip-list">
      {props.models.map((m) => (
        <span key={m} className={`model-chip ${m === props.defaultModel ? 'is-default' : ''}`}>
          {m}
          <button
            type="button"
            className="chip-remove"
            data-tip={`Remove ${m}`}
            aria-label={`Remove ${m}`}
            onClick={() => props.onChange(props.models.filter((x) => x !== m))}
          >
            <CloseIcon size={11} />
          </button>
        </span>
      ))}
      <input
        className="chip-add"
        value={pending}
        aria-label="Add a model"
        placeholder="Add a model…"
        onChange={(e) => setPending(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

function ThemeChoice(props: {
  value: ThemePreference;
  current: ThemePreference;
  label: string;
  icon: React.JSX.Element;
  isDefault?: boolean;
  onSelect: (value: ThemePreference) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`theme-choice ${props.current === props.value ? 'selected' : ''}`}
      aria-pressed={props.current === props.value}
      onClick={() => props.onSelect(props.value)}
    >
      {props.value === 'system' ? (
        // Half of each theme, so "System" reads as "whichever the OS is" rather than as a
        // third palette of its own.
        <div className="theme-preview">
          <div className="tp-half tp-light">
            <div className="tp-side" />
            <div className="tp-body">
              <div className="tp-line" />
              <div className="tp-line" />
              <div className="tp-accent" />
            </div>
          </div>
          <div className="tp-half tp-dark">
            <div className="tp-side" />
            <div className="tp-body">
              <div className="tp-line" />
              <div className="tp-line" />
              <div className="tp-accent" />
            </div>
          </div>
        </div>
      ) : (
        <div className={`theme-preview tp-${props.value}`}>
          <div className="tp-side" />
          <div className="tp-body">
            <div className="tp-line" />
            <div className="tp-line" />
            <div className="tp-accent" />
          </div>
        </div>
      )}
      <span className="theme-choice-label">
        {props.icon}
        {props.label}
        {props.isDefault && <span className="theme-choice-default">Default</span>}
      </span>
    </button>
  );
}

export function SettingsView(props: {
  settings: AppSettings;
  appVersion?: string;
  auth?: AuthStatus | null;
  serverReachable?: boolean;
  onSave: (update: Partial<AppSettings>) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(props.settings);
  const [pane, setPane] = useState<Pane>('Server');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The allowed-domains editor renders raw text rather than `draft.webSearch.allowedDomains`
   * joined back together: parsing on every keystroke drops the empty trailing line the moment
   * Enter is pressed, so the newline never survives the round trip and a second domain cannot
   * be typed. The parsed list is kept in `draft` alongside it, so save is unaffected.
   */
  const [domainsText, setDomainsText] = useState(props.settings.webSearch.allowedDomains.join('\n'));

  const orch: OrchestratorSettings = draft.orchestrator ?? DEFAULT_ORCHESTRATOR_SETTINGS;
  const updateOrch = (patch: Partial<OrchestratorSettings>): void =>
    setDraft({ ...draft, orchestrator: { ...orch, ...patch } });

  const appearance: AppearanceSettings = draft.appearance ?? DEFAULT_APPEARANCE;
  const updateAppearance = (patch: Partial<AppearanceSettings>): void =>
    setDraft({ ...draft, appearance: { ...appearance, ...patch } });

  /**
   * Editing the model list must not leave `defaultModel` pointing at a model that is gone — the
   * control would render with nothing selected and save an empty default. Re-point it instead.
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

  const caps = worstCase(orch);
  const signedIn = props.auth?.server.signedIn ?? false;
  const reachable = props.serverReachable ?? true;

  return (
    <div className="settings-view">
      <nav className="settings-nav">
        <div className="settings-nav-label">Settings</div>
        {PANES.map((name) => (
          <React.Fragment key={name}>
            {name === SECONDARY_PANES[0] && <div className="settings-nav-divider" />}
            <button
              type="button"
              className={`nav-pane ${pane === name ? 'active' : ''} ${
                SECONDARY_PANES.includes(name) ? 'secondary-pane' : ''
              }`}
              aria-current={pane === name ? 'page' : undefined}
              onClick={() => setPane(name)}
            >
              {name}
            </button>
          </React.Fragment>
        ))}
        <div className="settings-connection">
          <div className="settings-connection-label">Connection</div>
          <div className="settings-connection-host">
            <span className={`status-dot ${reachable && signedIn ? '' : 'off'}`} />
            {hostOf(draft.serverBaseUrl)}
          </div>
          <div className="settings-connection-detail">
            {draft.serverAuthMode === 'entra' ? 'Entra' : 'Dev token'} ·{' '}
            {!reachable ? 'unreachable' : signedIn ? 'signed in' : 'not signed in'}
          </div>
        </div>
      </nav>

      <div className="settings-main">
        <div className="settings-pane">
          {pane === 'Server' && (
            <>
              <div className="settings-pane-head">
                <h2>Server</h2>
                <p>
                  Where the knowledge-base tools and conversation storage live. <code>/mcp</code> and{' '}
                  <code>/api/chat/v1</code> are derived from this base URL.
                </p>
              </div>
              <label className="settings-field">
                <span className="settings-field-label">Server base URL</span>
                <input
                  aria-label="Server base URL"
                  value={draft.serverBaseUrl}
                  placeholder="https://app.yvoke.dev/"
                  onChange={(e) => setDraft({ ...draft, serverBaseUrl: e.target.value })}
                />
                <span className="settings-hint">
                  Must be https — http is allowed only for localhost, so an Entra bearer is never
                  sent in the clear.
                </span>
              </label>
              <div className="settings-field">
                <span className="settings-field-label">MCP transport</span>
                <Seg
                  label="MCP transport"
                  wide
                  value={draft.mcpTransport}
                  options={[
                    { value: 'http', label: 'Streamable HTTP' },
                    { value: 'sse', label: 'SSE' },
                  ]}
                  onChange={(mcpTransport) => setDraft({ ...draft, mcpTransport })}
                />
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Server authentication</span>
                <Seg
                  label="Server authentication"
                  wide
                  value={draft.serverAuthMode}
                  options={[
                    { value: 'entra', label: 'Entra ID' },
                    { value: 'dev', label: 'Dev token' },
                  ]}
                  onChange={(serverAuthMode) => setDraft({ ...draft, serverAuthMode })}
                />
                <span className="settings-hint">
                  {draft.serverAuthMode === 'entra'
                    ? 'Corporate sign-in in your browser (MSAL PKCE). Tenant and client ids are under Advanced.'
                    : 'Sends a static token — only works against a server running APP_SECURITY_MOCK=true.'}
                </span>
              </div>
            </>
          )}

          {pane === 'Models' && (
            <>
              <div className="settings-pane-head">
                <h2>Models</h2>
                <p>
                  Which Claude models a conversation can run on, and what a new conversation starts
                  with. Existing conversations keep their own choice.
                </p>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Available models</span>
                <ModelChips models={draft.models} defaultModel={draft.defaultModel} onChange={setModels} />
                <span className="settings-hint">
                  Model aliases as the Agent SDK accepts them (<code>sonnet</code>, <code>opus</code>,{' '}
                  <code>haiku</code>, or a full model id). Enter adds one.
                </span>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Default model</span>
                {draft.models.length > 0 ? (
                  <Seg
                    label="Default model"
                    wide
                    value={draft.defaultModel}
                    options={draft.models.map((m) => ({ value: m, label: m }))}
                    onChange={(defaultModel) => setDraft({ ...draft, defaultModel })}
                  />
                ) : (
                  <span className="settings-hint">Add a model above first.</span>
                )}
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Default thinking level</span>
                <Seg
                  label="Default thinking level"
                  wide
                  value={draft.defaultThinkingLevel}
                  options={THINKING_LEVELS.map((l) => ({ value: l, label: l }))}
                  onChange={(defaultThinkingLevel) => setDraft({ ...draft, defaultThinkingLevel })}
                />
              </div>
              <label className="settings-field">
                <span className="settings-field-label">Max turns per message</span>
                <input
                  aria-label="Max turns per message"
                  type="number"
                  min={0}
                  value={draft.maxTurns}
                  onChange={(e) => setDraft({ ...draft, maxTurns: toNumber(e.target.value) })}
                />
                <span className="settings-hint">
                  Backstop on the single-agent tool-use loop; 0 leaves the SDK default in place.
                </span>
              </label>
            </>
          )}

          {pane === 'Agents' && (
            <>
              <div className="settings-pane-head">
                <h2>Agents</h2>
                <p>
                  How a conversation runs: one agent under the playbook you pick, or a multi-agent
                  profile with specialists and a reviewer.
                </p>
              </div>

              <div className="settings-section-label">Single agent</div>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={draft.playbookValidationEnabled !== false}
                  onChange={(e) => setDraft({ ...draft, playbookValidationEnabled: e.target.checked })}
                />
                <span className="check-field-text">
                  <span className="check-field-name">Check the playbook before sending</span>
                  <span className="settings-hint">
                    When a message carries a playbook, ask the model first whether it is the right
                    one for the question, and offer a better match before the turn runs. Adds a few
                    seconds to that message; a failed check never blocks it.
                  </span>
                </span>
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={Boolean(draft.showPrototypePlaybooks)}
                  onChange={(e) => setDraft({ ...draft, showPrototypePlaybooks: e.target.checked })}
                />
                <span className="check-field-text">
                  <span className="check-field-name">Show prototypes</span>
                  <span className="settings-hint">
                    Show experimental and prototype playbooks in the playbook picker and slash menu,
                    and experimental multi-agent profiles in the profile picker. Hidden by default;
                    a profile a conversation already uses stays listed either way.
                  </span>
                </span>
              </label>

              <div className="settings-section-label">Multi-agent orchestrator</div>
              <p className="settings-hint settings-section-note">
                Applies to conversations that select a multi-agent profile. The profile decides
                which playbooks run; these settings bind each role to a model and cap its budget.
              </p>

              <div className="worst-case">
                <div>
                  <div className="settings-connection-label">Worst case per turn</div>
                  <div className="worst-case-figure">{caps.total} model calls</div>
                </div>
                <div
                  className="worst-case-bar"
                  role="img"
                  aria-label={`${caps.orchestrator} orchestrator, ${caps.reviewer} reviewer and ${caps.specialist} specialist calls`}
                >
                  <span
                    className="seg-orchestrator"
                    style={{ width: `${(caps.orchestrator / caps.total) * 100}%` }}
                  />
                  <span
                    className="seg-reviewer"
                    style={{ width: `${(caps.reviewer / caps.total) * 100}%` }}
                  />
                  <span
                    className="seg-specialist"
                    style={{ width: `${(caps.specialist / caps.total) * 100}%` }}
                  />
                </div>
                <div className="worst-case-legend">
                  Orchestrator · Reviewer · Specialists
                  <br />
                  {caps.orchestrator} · {caps.reviewer} · {caps.specialist} at the ceiling
                </div>
              </div>

              <div className="role-grid">
                <RoleCard
                  label="Orchestrator"
                  hint="Plans the turn, delegates to specialists, and writes the final answer."
                  value={orch.orchestrator}
                  models={draft.models}
                  onChange={(v) => updateOrch({ orchestrator: v })}
                />
                <RoleCard
                  label="Reviewer"
                  hint="Checks the draft against its sources and returns an approve / reject verdict."
                  value={orch.reviewer}
                  models={draft.models}
                  onChange={(v) => updateOrch({ reviewer: v })}
                />
                <RoleCard
                  label="Specialist"
                  hint="Sub-agents the orchestrator delegates research to. Runs most of the calls."
                  value={orch.specialist}
                  models={draft.models}
                  onChange={(v) => updateOrch({ specialist: v })}
                />
              </div>

              <div className="settings-section-label">Budget caps</div>
              <div className="settings-row">
                <CapSlider
                  label="Max review rounds"
                  kind="cost-driver"
                  min={0}
                  max={5}
                  value={orch.maxReviewRounds}
                  hint="Revisions driven after a non-approving verdict. 0 reviews once and never revises."
                  onChange={(maxReviewRounds) => updateOrch({ maxReviewRounds })}
                />
                <CapSlider
                  label="Max specialist calls"
                  kind="cost-driver"
                  min={0}
                  max={25}
                  value={orch.maxSpecialistCalls}
                  hint="Largest single driver of cost and latency."
                  onChange={(maxSpecialistCalls) => updateOrch({ maxSpecialistCalls })}
                />
                <CapSlider
                  label="Orchestrator max turns"
                  kind="safety-cap"
                  min={0}
                  max={120}
                  value={orch.orchestratorMaxTurns}
                  hint="Safety ceiling on the agentic loop, not a target."
                  onChange={(orchestratorMaxTurns) => updateOrch({ orchestratorMaxTurns })}
                />
                <CapSlider
                  label="Specialist max turns"
                  kind="safety-cap"
                  min={0}
                  max={60}
                  value={orch.specialistMaxTurns}
                  hint="Safety ceiling per specialist sub-agent."
                  onChange={(specialistMaxTurns) => updateOrch({ specialistMaxTurns })}
                />
              </div>

              <label className="check-field">
                <input
                  type="checkbox"
                  checked={orch.requireReview !== false}
                  onChange={(e) => updateOrch({ requireReview: e.target.checked })}
                />
                <span className="check-field-text">
                  <span className="check-field-name">Enforce review</span>
                  <span className="settings-hint">
                    Re-prompt for a reviewer pass when the orchestrator skips one, and drive
                    revisions on a non-approval.
                  </span>
                </span>
              </label>
            </>
          )}

          {pane === 'Web search' && (
            <>
              <div className="settings-pane-head">
                <h2>Web search</h2>
                <p>
                  Off by default. When enabled, the agent may search the web and open whole pages
                  from it — but only within the domains listed here. Everything else stays inside
                  the knowledge base.
                </p>
              </div>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={draft.webSearch.enabled}
                  onChange={(e) =>
                    setDraft({ ...draft, webSearch: { ...draft.webSearch, enabled: e.target.checked } })
                  }
                />
                <span className="check-field-text">
                  <span className="check-field-name">Allow web search and page fetching</span>
                  <span className="settings-hint">
                    Both are restricted to the allow-list below; with the list empty, both are
                    refused. A permitted page is read in full, so its text reaches the assistant the
                    same way the knowledge base does.
                  </span>
                </span>
              </label>
              <label className="settings-field">
                <span className="settings-field-label">Allowed domains (one per line)</span>
                <textarea
                  aria-label="Allowed domains"
                  rows={6}
                  value={domainsText}
                  onChange={(e) => {
                    setDomainsText(e.target.value);
                    setDraft({
                      ...draft,
                      webSearch: { ...draft.webSearch, allowedDomains: parseDomains(e.target.value) },
                    });
                  }}
                />
                <span className="settings-hint">
                  Subdomains are included: <code>example.com</code> also permits{' '}
                  <code>docs.example.com</code>. A protocol, port, path or leading <code>*.</code> is
                  ignored.
                </span>
              </label>
              {suspectDomains(draft.webSearch.allowedDomains).length > 0 && (
                <p className="settings-hint settings-domain-warning" role="status">
                  Check these entries — they may be broader than they look:{' '}
                  {suspectDomains(draft.webSearch.allowedDomains).join(', ')}. An entry with no dot
                  covers that host and everything under it, so a bare top-level domain such as{' '}
                  <code>com</code> permits every site under it; a path is discarded, so the whole
                  domain is permitted rather than the one page.
                </p>
              )}
            </>
          )}

          {pane === 'Appearance' && (
            <>
              <div className="settings-pane-head">
                <h2>Appearance</h2>
                <p>Yvoke follows your system theme unless you pick one here.</p>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Theme</span>
                <div className="theme-choices">
                  <ThemeChoice
                    value="light"
                    current={appearance.theme}
                    label="Light"
                    icon={<SunIcon size={13} />}
                    onSelect={(theme) => updateAppearance({ theme })}
                  />
                  <ThemeChoice
                    value="dark"
                    current={appearance.theme}
                    label="Dark"
                    icon={<MoonIcon size={13} />}
                    onSelect={(theme) => updateAppearance({ theme })}
                  />
                  <ThemeChoice
                    value="system"
                    current={appearance.theme}
                    label="System"
                    icon={<MonitorIcon size={13} />}
                    isDefault
                    onSelect={(theme) => updateAppearance({ theme })}
                  />
                </div>
                <span className="settings-hint">
                  System keeps following the OS while the window is open, including a scheduled
                  switch, and takes the native window frame with it.
                </span>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Interface density</span>
                <Seg<Density>
                  label="Interface density"
                  wide
                  value={appearance.density}
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                  onChange={(density) => updateAppearance({ density })}
                />
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Answer text size</span>
                <Seg
                  label="Answer text size"
                  wide
                  value={String(appearance.answerTextSize)}
                  options={[
                    { value: '13', label: '13px' },
                    { value: '14', label: '14px' },
                    { value: '15', label: '15px' },
                  ]}
                  onChange={(size) => updateAppearance({ answerTextSize: Number(size) })}
                />
              </div>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={appearance.traceExpanded}
                  onChange={(e) => updateAppearance({ traceExpanded: e.target.checked })}
                />
                <span className="check-field-text">
                  <span className="check-field-name">Show the trace expanded by default</span>
                  <span className="settings-hint">
                    Off keeps a finished answer's reasoning and tool calls behind one line.
                  </span>
                </span>
              </label>
              <div className="settings-field">
                <span className="settings-field-label">Reduce motion</span>
                <span className="settings-hint">
                  Follows the system setting — no separate control. Turn it on in your OS
                  accessibility settings and animations here stop.
                </span>
              </div>
            </>
          )}

          {pane === 'Advanced' && (
            <>
              <div className="settings-pane-head">
                <h2>Advanced</h2>
                <p>
                  Identity registration for the corporate sign-in. Set once per install; changing it
                  invalidates the cached token.
                </p>
              </div>
              {draft.serverAuthMode === 'entra' ? (
                <>
                  <label className="settings-field">
                    <span className="settings-field-label">Entra tenant id</span>
                    <input
                      aria-label="Entra tenant id"
                      value={draft.entra.tenantId}
                      onChange={(e) => setDraft({ ...draft, entra: { ...draft.entra, tenantId: e.target.value } })}
                    />
                  </label>
                  <label className="settings-field">
                    <span className="settings-field-label">Entra client id</span>
                    <input
                      aria-label="Entra client id"
                      value={draft.entra.clientId}
                      onChange={(e) => setDraft({ ...draft, entra: { ...draft.entra, clientId: e.target.value } })}
                    />
                    <span className="settings-hint">The desktop public-client registration.</span>
                  </label>
                  <label className="settings-field">
                    <span className="settings-field-label">API scope</span>
                    <input
                      aria-label="API scope"
                      value={draft.entra.scope}
                      onChange={(e) => setDraft({ ...draft, entra: { ...draft.entra, scope: e.target.value } })}
                    />
                  </label>
                </>
              ) : (
                <p className="settings-note">
                  Server authentication is set to Dev token, so no Entra registration is used. Switch
                  it under Server to configure one.
                </p>
              )}
            </>
          )}

          {pane === 'About' && (
            <>
              <div className="settings-pane-head">
                <h2>About</h2>
                <p>Yvoke Desktop runs the agent loop locally against the Claude Agent SDK.</p>
              </div>
              <dl className="about-grid">
                <dt>Version</dt>
                <dd>{props.appVersion ? `v${props.appVersion}` : '—'}</dd>
                <dt>Server</dt>
                <dd>{draft.serverBaseUrl || 'Not configured'}</dd>
                <dt>Server sign-in</dt>
                <dd>
                  {draft.serverAuthMode === 'entra' ? 'Microsoft Entra' : 'Dev token'} ·{' '}
                  {signedIn ? (props.auth?.server.account ?? 'signed in') : 'not signed in'}
                </dd>
                <dt>Claude account</dt>
                <dd>
                  {props.auth?.claudeAccount ??
                    (props.auth?.claude === 'missing'
                      ? 'No Claude Code credentials found'
                      : 'Detected from Claude Code')}
                </dd>
              </dl>
            </>
          )}

          {error && <div className="banner error">{error}</div>}
        </div>

        <div className="settings-footer">
          <p className="settings-note">
            Model and thinking changes apply to new turns. New conversations use these defaults;
            existing ones keep their per-conversation choice, changeable in the composer.
          </p>
          <div className="dialog-actions">
            <button onClick={props.onClose} disabled={saving}>
              Cancel
            </button>
            <button className="primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
