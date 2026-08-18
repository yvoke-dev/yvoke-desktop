// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('saves edited maxTurns and orchestrator budgets', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Max turns per message/), { target: { value: '40' } });
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
        settings={{ ...settings, models: ['sonnet', 'opus'] }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Available models (one per line)'), {
      target: { value: 'opus\nhaiku' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ models: ['opus', 'haiku'], defaultModel: 'opus' }),
      ),
    );
  });

  it('renders the orchestrator form from defaults when settings.json omits the block', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { orchestrator: _omitted, ...withoutOrchestrator } = settings;
    render(<SettingsView settings={withoutOrchestrator} onSave={onSave} onClose={vi.fn()} />);
    expect((screen.getByLabelText('Max specialist calls') as HTMLInputElement).value).toBe('8');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 25 })));
    // An untouched form must not invent an orchestrator block the user never configured.
    expect(onSave.mock.calls[0][0].orchestrator).toBeUndefined();
  });
});
