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
  it('lets a second allowed domain be typed on a new line', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    openPane('Web search');
    const box = screen.getByLabelText('Allowed domains') as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: 'docs.example.com' } });
    fireEvent.change(box, { target: { value: 'docs.example.com\n' } });
    expect(box.value).toBe('docs.example.com\n');

    fireEvent.change(box, { target: { value: 'docs.example.com\nlearn.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          webSearch: expect.objectContaining({
            allowedDomains: ['docs.example.com', 'learn.example.com'],
          }),
        }),
      ),
    );
  });

  it('drops blank and whitespace-only lines when saving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    openPane('Web search');
    fireEvent.change(screen.getByLabelText('Allowed domains'), {
      target: { value: '  docs.example.com  \n\n   \nlearn.example.com\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          webSearch: expect.objectContaining({
            allowedDomains: ['docs.example.com', 'learn.example.com'],
          }),
        }),
      ),
    );
  });
});
