// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsView } from '../../src/renderer/src/components/SettingsView';
import type { AppSettings } from '../../src/shared/types';

const settings: AppSettings = {
  serverBaseUrl: 'https://app.example/',
  mcpTransport: 'http',
  serverAuthMode: 'entra',
  entra: { clientId: 'c', tenantId: 't', scope: 's' },
  models: ['sonnet'],
  defaultModel: 'sonnet',
  defaultThinkingLevel: 'medium',
  webSearch: { enabled: false, allowedDomains: [] },
  maxTurns: 25,
  orchestrator: {
    orchestrator: { model: 'opus', thinkingLevel: 'high' },
    reviewer: { model: 'opus', thinkingLevel: 'high' },
    specialist: { model: 'sonnet', thinkingLevel: 'medium' },
    maxReviewRounds: 2,
    maxSpecialistCalls: 8,
    orchestratorMaxTurns: 60,
    specialistMaxTurns: 20,
  },
};

/** The panes are a spine now: a field only exists once its pane is open. */
function openPane(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

afterEach(() => cleanup());

describe('SettingsView', () => {
  it('surfaces a rejected save as an inline error and does not close', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('serverBaseUrl must use https'));
    const onClose = vi.fn();
    render(<SettingsView settings={settings} onSave={onSave} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/must use https/)).toBeTruthy());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('passes the current settings to onSave', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ serverBaseUrl: 'https://app.example/' })),
    );
  });

  // Save lives in the footer, outside the panes, so edits made in one pane have to survive
  // navigating to another before submitting.
  it('keeps edits from every pane when saving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);

    openPane('Models');
    fireEvent.change(screen.getByLabelText('Max turns per message'), { target: { value: '40' } });

    openPane('Agents');
    fireEvent.change(screen.getByLabelText('Max review rounds'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Specialist max turns'), { target: { value: '15' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTurns: 40,
          orchestrator: expect.objectContaining({ maxReviewRounds: 3, specialistMaxTurns: 15 }),
        }),
      ),
    );
  });

  it('re-points defaultModel when the models list no longer contains it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        settings={{ ...settings, models: ['sonnet', 'opus'], defaultModel: 'sonnet' }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    openPane('Models');
    fireEvent.click(screen.getByRole('button', { name: 'Remove sonnet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ models: ['opus'], defaultModel: 'opus' }),
      ),
    );
  });

  it('adds a model from the chip input', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    openPane('Models');
    const input = screen.getByLabelText('Add a model');
    fireEvent.change(input, { target: { value: 'haiku' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ models: ['sonnet', 'haiku'] })),
    );
  });

  it('renders the orchestrator form from defaults when settings.json omits the block', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { orchestrator: _omitted, ...withoutOrchestrator } = settings;
    render(<SettingsView settings={withoutOrchestrator} onSave={onSave} onClose={vi.fn()} />);
    openPane('Agents');
    expect((screen.getByLabelText('Max specialist calls') as HTMLInputElement).value).toBe('8');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 25 })));
    // An untouched form must not invent an orchestrator block the user never configured.
    expect(onSave.mock.calls[0][0].orchestrator).toBeUndefined();
  });

  // The ceiling is what makes the caps settable: rounds × (orchestrator + specialists + reviewer).
  it('projects the worst-case call count from the caps', () => {
    render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
    openPane('Agents');
    // 3 rounds × (1 orchestrator + 8 specialists + 1 reviewer)
    expect(screen.getByText('30 model calls')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Max specialist calls'), { target: { value: '4' } });
    expect(screen.getByText('18 model calls')).toBeTruthy();
  });

  it('saves a theme choice under Appearance', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    openPane('Appearance');
    fireEvent.click(screen.getByRole('button', { name: /Dark/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ appearance: expect.objectContaining({ theme: 'dark' }) }),
      ),
    );
  });

  it('binds an orchestrator role to a model through its segmented control', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        settings={{ ...settings, models: ['sonnet', 'opus'] }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    openPane('Agents');
    const group = screen.getByRole('group', { name: 'Reviewer model' });
    fireEvent.click(within(group).getByRole('button', { name: 'sonnet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          orchestrator: expect.objectContaining({
            reviewer: expect.objectContaining({ model: 'sonnet' }),
          }),
        }),
      ),
    );
  });
  // Parsing the textarea on every keystroke used to strip the empty trailing line as soon as
  // Enter was pressed, so the newline never survived and only one domain could ever be typed.
  it('shows the allow-list as read-only deployment configuration', () => {
    // The list ships with the app, so there is nothing to type. It is displayed rather than
    // edited, and the editor that used to be here is deliberately gone: a Save that froze a copy
    // of the list into the user's profile is what stopped a release from ever adding a domain.
    const configured = {
      ...settings,
      webSearch: { enabled: true, allowedDomains: ['support.example.com', 'www.example.com/community/'] },
    };
    render(<SettingsView settings={configured} onSave={vi.fn()} onClose={vi.fn()} />);
    openPane('Web search');
    expect(screen.queryByLabelText('Allowed domains')).toBeNull();
    expect(screen.getByText('support.example.com')).toBeTruthy();
    // A path-scoped entry is shown as written, since the path is what makes it narrower.
    expect(screen.getByText('www.example.com/community/')).toBeTruthy();
  });

  it('keeps the enable switch a real preference', async () => {
    // `enabled` is the one thing in this pane the user owns. The draft it saves still CARRIES the
    // domain list — the editor cannot help that, it sends the whole settings object — so the
    // guarantee that a Save never freezes a copy of the list into the profile belongs to
    // `SettingsStore.set`, and is asserted in tests/settings.test.ts, not here.
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    openPane('Web search');
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow web search/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const sent = onSave.mock.calls[0][0] as { webSearch: { enabled: boolean } };
    expect(sent.webSearch.enabled).toBe(!settings.webSearch.enabled);
  });

  // One checkbox governs prototype playbooks AND prototype multi-agent profiles, so its copy has
  // to say both — a label naming only playbooks is why the profile half of the feature reads as
  // broken rather than as off.
  it('saves showPrototypePlaybooks toggle in Agents pane, and says it covers profiles too', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    openPane('Agents');
    const toggle = screen.getByLabelText(/Show prototypes/);
    expect(toggle.closest('label')?.textContent).toMatch(/profile/i);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          showPrototypePlaybooks: true,
        }),
      ),
    );
  });
});
