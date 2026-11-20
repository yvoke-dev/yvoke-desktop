// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  areSettingsEqual,
  SETTINGS_PANES,
  SettingsView,
} from '../../src/renderer/src/components/SettingsView';
import type { ClaudeSignInController } from '../../src/renderer/src/components/ClaudeSignInControls';
import type { ServerSignInController } from '../../src/renderer/src/components/ServerSignInControls';
import type { AppSettings, AuthVerificationResponse } from '../../src/shared/types';

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

let originalApi: unknown;

beforeEach(() => {
  originalApi = (window as unknown as { api?: unknown }).api;
});

afterEach(() => {
  (window as unknown as { api?: unknown }).api = originalApi;
  cleanup();
});

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

  it('renders friendly versioned display names for models in Default model selector and role cards', async () => {
    render(
      <SettingsView
        settings={{ ...settings, models: ['sonnet', 'opus', 'haiku'], defaultModel: 'sonnet' }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    openPane('Models');
    expect(screen.getByRole('button', { name: 'Sonnet 5.5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Opus 5.5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Haiku 5.5' })).toBeTruthy();
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
    fireEvent.click(within(group).getByRole('button', { name: 'Sonnet 5.5' }));
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

  describe('About pane & Diagnostics', () => {
    it('renders "Open Logs Folder" button in the About / Diagnostics section', () => {
      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');
      expect(screen.getByText('Diagnostics')).toBeTruthy();
      const btn = screen.getByRole('button', { name: 'Open Logs Folder' });
      expect(btn).toBeTruthy();
      expect(btn.classList.contains('open-logs-btn')).toBe(true);
    });

    it('calls window.api.openLogsFolder() when the button is clicked', async () => {
      const openLogsFolder = vi.fn().mockResolvedValue(undefined);
      (window as unknown as { api: unknown }).api = { openLogsFolder };
      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');
      fireEvent.click(screen.getByRole('button', { name: 'Open Logs Folder' }));
      expect(openLogsFolder).toHaveBeenCalledTimes(1);
    });

    it('handles openLogsFolder rejection gracefully and displays an error message', async () => {
      const openLogsFolder = vi.fn().mockRejectedValue(new Error('Failed to open logs directory'));
      (window as unknown as { api: unknown }).api = { openLogsFolder };
      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');
      fireEvent.click(screen.getByRole('button', { name: 'Open Logs Folder' }));
      await waitFor(() =>
        expect(screen.getByText(/Failed to open logs directory/)).toBeTruthy(),
      );
      expect(openLogsFolder).toHaveBeenCalledTimes(1);
    });
  });

  describe('Wave 3: Login Verification & Credential Checking', () => {
    it('Test 3.4: Strictly on-demand - verifyAuth is NOT called on mount or pane switch', () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'ok', account: 'srv@test.com' },
        claude: { status: 'ok', account: 'claude@test.com' },
      });
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      expect(verifyAuth).not.toHaveBeenCalled();

      openPane('Models');
      expect(verifyAuth).not.toHaveBeenCalled();

      openPane('Accounts');
      expect(verifyAuth).not.toHaveBeenCalled();

      // "Check Credentials" button is present in Accounts pane
      expect(screen.getByRole('button', { name: 'Check Credentials' })).toBeTruthy();
    });

    it('Test 3.2: Double-click / in-flight debounce - verifyAuth invoked once and button disabled while verifying', async () => {
      let resolveVerify!: (val: AuthVerificationResponse) => void;
      const verifyPromise = new Promise<AuthVerificationResponse>((resolve) => {
        resolveVerify = resolve;
      });
      const verifyAuth = vi.fn().mockReturnValue(verifyPromise);
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('Accounts');

      const checkBtn = screen.getByRole('button', { name: 'Check Credentials' });
      expect((checkBtn as HTMLButtonElement).disabled).toBe(false);

      // First click initiates verification
      fireEvent.click(checkBtn);
      expect(verifyAuth).toHaveBeenCalledTimes(1);
      expect((checkBtn as HTMLButtonElement).disabled).toBe(true);
      expect(checkBtn.textContent).toBe('Verifying credentials…');

      // Second click while in-flight is debounced/ignored
      fireEvent.click(checkBtn);
      expect(verifyAuth).toHaveBeenCalledTimes(1);

      // Resolve in-flight verification
      resolveVerify({
        server: { status: 'ok', account: 'admin@corp.com' },
        claude: { status: 'ok', account: 'dev@corp.com' },
      });

      await waitFor(() => {
        expect((checkBtn as HTMLButtonElement).disabled).toBe(false);
        expect(checkBtn.textContent).toBe('Check Credentials');
      });
    });

    // The old version of this test asserted only that console.error was not called. React 19
    // does not warn on setState-after-unmount, so it passed with or without the guards it
    // claimed to pin. What actually matters is that unmounting mid-flight is harmless and that
    // a later resolution cannot resurrect the pane.
    it('Test 3.1: React 19 unmount mid-flight - resolving later is harmless', async () => {
      let resolveVerify!: (val: AuthVerificationResponse) => void;
      const verifyPromise = new Promise<AuthVerificationResponse>((resolve) => {
        resolveVerify = resolve;
      });
      const verifyAuth = vi.fn().mockReturnValue(verifyPromise);
      (window as unknown as { api: unknown }).api = { verifyAuth };

      const { unmount } = render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('Accounts');

      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      expect(verifyAuth).toHaveBeenCalledTimes(1);

      unmount();
      resolveVerify({
        server: { status: 'ok', account: 'admin@corp.com' },
        claude: { status: 'ok', account: 'dev@corp.com' },
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(screen.queryAllByText('✓ Verified')).toHaveLength(0);
      expect(document.body.textContent).not.toContain('admin@corp.com');
    });

    // The probe runs against SAVED settings in main, but the row is labelled from the draft.
    // A badge must never outlive the configuration it describes.
    it('drops a stale verdict when the server configuration is edited', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'ok', account: 'dev-mode (mock security)' },
        claude: { status: 'ok', account: 'claude@corp.com' },
      });
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'dev' }}
          auth={{ claude: 'ok', server: { mode: 'dev', signedIn: true } }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified').length).toBe(2));

      // Switch the mode without saving; main has still only ever verified dev mode.
      openPane('Server');
      const modeGroup = screen.getByRole('group', { name: 'Server authentication' });
      fireEvent.click(within(modeGroup).getByRole('button', { name: 'Entra ID' }));
      openPane('Accounts');

      expect(screen.queryAllByText('✓ Verified')).toHaveLength(0);
      expect(document.body.textContent).not.toContain('dev-mode (mock security)');
    });

    it('drops a stale verdict when the server address is edited', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'ok', account: 'admin@corp.com' },
        claude: { status: 'ok', account: 'claude@corp.com' },
      });
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('Accounts');
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified').length).toBe(2));

      openPane('Server');
      fireEvent.change(screen.getByLabelText('Server base URL'), {
        target: { value: 'https://other.example' },
      });
      openPane('Accounts');

      expect(screen.queryAllByText('✓ Verified')).toHaveLength(0);
    });

    it('Test 3.3: IPC transport rejection - error surfaced in banner without crashing', async () => {
      const verifyAuth = vi.fn().mockRejectedValue(new Error('IPC transport failed'));
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('Accounts');

      const checkBtn = screen.getByRole('button', { name: 'Check Credentials' });
      fireEvent.click(checkBtn);

      await waitFor(() => {
        expect(screen.getByText(/IPC transport failed/)).toBeTruthy();
      });

      // Button returns to enabled state
      expect((checkBtn as HTMLButtonElement).disabled).toBe(false);
      expect(checkBtn.textContent).toBe('Check Credentials');
    });

    it('renders verified checkmarks (✓ Verified) on success with account info', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'ok', account: 'srv-admin@corp.com' },
        claude: { status: 'ok', account: 'claude-user@corp.com' },
      });
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('Accounts');

      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));

      await waitFor(() => {
        const verifiedBadges = screen.getAllByText('✓ Verified');
        expect(verifiedBadges.length).toBe(2);
        for (const badge of verifiedBadges) {
          expect(badge.className).toContain('cred-badge');
          expect(badge.className).toContain('verified');
        }
      });

      expect(screen.getByText(/srv-admin@corp\.com/)).toBeTruthy();
      expect(screen.getByText(/claude-user@corp\.com/)).toBeTruthy();
    });

    it('renders failure alerts with inline "Sign in to Yvoke" button in Entra mode and handles sign-in', async () => {
      const verifyAuth = vi
        .fn()
        .mockResolvedValueOnce({
          server: { status: 'expired', message: 'Token expired' },
          claude: { status: 'rate_limited', message: 'Rate limit exceeded' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'signed-in@corp.com' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        });
      const serverSignIn = vi.fn().mockResolvedValue({ status: 'signed_in', account: 'signed-in@corp.com' });
      const cancelServerSignIn = vi.fn().mockResolvedValue(true);
      const onAuthChange = vi.fn();
      (window as unknown as { api: unknown }).api = { verifyAuth, serverSignIn, cancelServerSignIn };

      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');

      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));

      await waitFor(() => {
        expect(screen.getByText(/✗ Token expired/)).toBeTruthy();
        expect(screen.getByText(/⚠ Rate limit exceeded/)).toBeTruthy();
      });

      // Server expired status has error class, Claude rate_limited has warning class
      const serverBadge = screen.getByText(/Token expired/);
      expect(serverBadge.className).toContain('cred-badge');
      expect(serverBadge.className).toContain('error');

      const claudeBadge = screen.getByText(/Rate limit exceeded/);
      expect(claudeBadge.className).toContain('cred-badge');
      expect(claudeBadge.className).toContain('warning');

      // Inline "Sign in to Yvoke" button is rendered in Entra mode
      const signInBtn = screen.getByRole('button', { name: 'Sign in to Yvoke' });
      expect(signInBtn).toBeTruthy();
      expect(signInBtn.className).toContain('cred-inline-btn');

      // Click inline sign in
      fireEvent.click(signInBtn);

      await waitFor(() => {
        expect(serverSignIn).toHaveBeenCalledTimes(1);
        expect(onAuthChange).toHaveBeenCalledTimes(1);
      });
    });


    it('offers no inline Sign in to Yvoke when the saved mode is the dev token', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'expired', message: 'Token expired' },
        claude: { status: 'ok', account: 'claude@corp.com' },
      });
      (window as unknown as { api: unknown }).api = {
        verifyAuth,
        serverSignIn: vi.fn(),
        cancelServerSignIn: vi.fn(),
      };

      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{ claude: 'ok', server: { mode: 'dev', signedIn: true } }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Token expired/)).toBeTruthy());

      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();
    });

    it('renders failure alerts with ⚠ for unreachable server and ✗ for missing claude credentials', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'unreachable', message: 'Server connection refused' },
        claude: { status: 'missing', message: 'No Claude credentials found' },
      });
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'dev' }}
          auth={{ claude: 'missing', server: { mode: 'dev', signedIn: true } }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');

      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));

      await waitFor(() => {
        expect(screen.getByText(/⚠ Server connection refused/)).toBeTruthy();
        expect(screen.getByText(/✗ No Claude credentials found/)).toBeTruthy();
      });

      // Server unreachable status has warning class, Claude missing has error class
      const serverBadge = screen.getByText(/Server connection refused/);
      expect(serverBadge.className).toContain('cred-badge');
      expect(serverBadge.className).toContain('warning');

      const claudeBadge = screen.getByText(/No Claude credentials found/);
      expect(claudeBadge.className).toContain('cred-badge');
      expect(claudeBadge.className).toContain('error');

      // In Dev token mode, Server inline "Sign in to Yvoke" button is NOT rendered while Claude account offers "Sign in to Claude"
      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy();
    });

    it('does not render .settings-connection card', () => {
      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      expect(document.querySelector('.settings-connection')).toBeNull();
    });

    it('positions ✓ Verified badge after account text (anti-tautology badge placement)', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'ok', account: 'srv-admin@corp.com' },
        claude: { status: 'ok', account: 'claude-user@corp.com' },
      });
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('Accounts');

      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));

      await waitFor(() => {
        expect(screen.getAllByText('✓ Verified')).toHaveLength(2);
      });

      const serverDd = screen.getByText(/srv-admin@corp\.com/).closest('dd');
      const claudeDd = screen.getByText(/claude-user@corp\.com/).closest('dd');

      expect(serverDd).not.toBeNull();
      expect(claudeDd).not.toBeNull();

      const serverText = serverDd!.textContent!;
      const claudeText = claudeDd!.textContent!;

      expect(serverText.indexOf('srv-admin@corp.com')).toBeLessThan(serverText.indexOf('✓ Verified'));
      expect(claudeText.indexOf('claude-user@corp.com')).toBeLessThan(claudeText.indexOf('✓ Verified'));
    });

    it('does not call checkForUpdates on mount or navigation', () => {
      const checkForUpdates = vi.fn().mockResolvedValue({ status: 'latest', currentVersion: '1.2.0' });
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      render(<SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />);
      expect(checkForUpdates).not.toHaveBeenCalled();

      openPane('Appearance');
      expect(checkForUpdates).not.toHaveBeenCalled();

      openPane('About');
      expect(checkForUpdates).not.toHaveBeenCalled();
    });

    it('handles Check for Updates button click, disabled state, and latest version badge', async () => {
      let resolveUpdate!: (val: any) => void;
      const checkPromise = new Promise((resolve) => {
        resolveUpdate = resolve;
      });
      const checkForUpdates = vi.fn().mockReturnValue(checkPromise);
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      render(<SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');

      const checkBtn = screen.getByRole('button', { name: 'Check for Updates' });
      fireEvent.click(checkBtn);

      expect(checkBtn.textContent).toBe('Checking…');
      expect((checkBtn as HTMLButtonElement).disabled).toBe(true);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);

      // Concurrent click does not trigger second call
      fireEvent.click(checkBtn);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);

      resolveUpdate({ status: 'latest', currentVersion: '1.2.0', latestVersion: '1.2.0' });

      await waitFor(() => {
        expect(screen.getByText('Latest version')).toBeTruthy();
      });

      const badge = screen.getByText('Latest version');
      expect(badge.className).toContain('cred-badge');
      expect(badge.className).toContain('verified');
      expect(checkBtn.textContent).toBe('Check for Updates');
      expect((checkBtn as HTMLButtonElement).disabled).toBe(false);
    });

    it('renders update_available warning badge linking to release URL', async () => {
      const checkForUpdates = vi.fn().mockResolvedValue({
        status: 'update_available',
        currentVersion: '1.2.0',
        latestVersion: '1.3.3',
        releaseUrl: 'https://github.com/yvoke-dev/yvoke-desktop/releases/tag/v1.3.3',
      });
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      render(<SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');

      fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

      await waitFor(() => {
        expect(screen.getByText('Latest version is 1.3.3')).toBeTruthy();
      });

      const badge = screen.getByText('Latest version is 1.3.3') as HTMLAnchorElement;
      expect(badge.className).toContain('cred-badge');
      expect(badge.className).toContain('warning');
      expect(badge.className).toContain('update-badge');
      expect(badge.href).toBe('https://github.com/yvoke-dev/yvoke-desktop/releases/tag/v1.3.3');
      expect(badge.target).toBe('_blank');
    });

    it('renders error badge on update check failure or rate limit', async () => {
      const checkForUpdates = vi.fn().mockResolvedValue({
        status: 'rate_limited',
        currentVersion: '1.2.0',
        message: 'Rate limit reached',
      });
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      render(<SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');

      fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

      await waitFor(() => {
        expect(screen.getByText('Rate limit reached')).toBeTruthy();
      });

      const badge = screen.getByText('Rate limit reached');
      expect(badge.className).toContain('cred-badge');
      expect(badge.className).toContain('error');
    });

    it('renders generic error badge when update check returns status: error with custom message', async () => {
      const checkForUpdates = vi.fn().mockResolvedValue({
        status: 'error',
        currentVersion: '1.2.0',
        message: 'Server returned HTTP 500',
      });
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      render(<SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');

      fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

      await waitFor(() => {
        expect(screen.getByText('Server returned HTTP 500')).toBeTruthy();
      });

      const badge = screen.getByText('Server returned HTTP 500');
      expect(badge.className).toContain('cred-badge');
      expect(badge.className).toContain('error');
      expect(badge.getAttribute('title')).toBe('Server returned HTTP 500');
    });

    it('renders fallback "Check failed" when status: error has no message', async () => {
      const checkForUpdates = vi.fn().mockResolvedValue({
        status: 'error',
        currentVersion: '1.2.0',
      });
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      render(<SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');

      fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

      await waitFor(() => {
        expect(screen.getByText('Check failed')).toBeTruthy();
      });

      const badge = screen.getByText('Check failed');
      expect(badge.className).toContain('cred-badge');
      expect(badge.className).toContain('error');
    });

    it('handles window.api.checkForUpdates rejection gracefully, displays error, and re-enables button', async () => {
      let rejectUpdate!: (err: Error) => void;
      const checkPromise = new Promise((_, reject) => {
        rejectUpdate = reject;
      });
      const checkForUpdates = vi.fn().mockReturnValue(checkPromise);
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      render(<SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');

      const checkBtn = screen.getByRole('button', { name: 'Check for Updates' });
      fireEvent.click(checkBtn);

      expect((checkBtn as HTMLButtonElement).disabled).toBe(true);
      expect(checkBtn.textContent).toBe('Checking…');

      rejectUpdate(new Error('Network disconnected'));

      await waitFor(() => {
        expect(screen.getByText('Network disconnected')).toBeTruthy();
      });

      const badge = screen.getByText('Network disconnected');
      expect(badge.className).toContain('cred-badge');
      expect(badge.className).toContain('error');
      expect((checkBtn as HTMLButtonElement).disabled).toBe(false);
      expect(checkBtn.textContent).toBe('Check for Updates');
    });

    it('safely handles mid-flight unmount without errors', async () => {
      let resolveUpdate!: (val: any) => void;
      const checkPromise = new Promise((resolve) => {
        resolveUpdate = resolve;
      });
      const checkForUpdates = vi.fn().mockReturnValue(checkPromise);
      (window as unknown as { api: unknown }).api = { checkForUpdates };

      const { unmount } = render(
        <SettingsView settings={settings} appVersion="1.2.0" onSave={vi.fn()} onClose={vi.fn()} />,
      );
      openPane('About');

      fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));
      expect(checkForUpdates).toHaveBeenCalledTimes(1);

      unmount();
      expect(() => {
        resolveUpdate({ status: 'latest', currentVersion: '1.2.0' });
      }).not.toThrow();
    });
  });

  describe('playbooks excluded from validation', () => {
    it('renders empty state note when playbookValidationExcludedPlaybooks is empty', () => {
      render(
        <SettingsView
          settings={{ ...settings, playbookValidationExcludedPlaybooks: [] }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Agents');
      expect(
        screen.getByText('None configured; all playbooks are preflighted before sending.'),
      ).toBeTruthy();
      expect(
        screen.getByText(
          'Set per deployment and shipped with the app — so this list is shown rather than edited, and an update arrives with the next release.',
        ),
      ).toBeTruthy();
    });

    it('renders empty state note resiliently when playbookValidationExcludedPlaybooks is undefined', () => {
      const undefinedSettings = { ...settings };
      delete (undefinedSettings as any).playbookValidationExcludedPlaybooks;
      render(
        <SettingsView
          settings={undefinedSettings}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Agents');
      expect(
        screen.getByText('None configured; all playbooks are preflighted before sending.'),
      ).toBeTruthy();
      expect(
        screen.getByText(
          'Set per deployment and shipped with the app — so this list is shown rather than edited, and an update arrives with the next release.',
        ),
      ).toBeTruthy();
    });

    it('renders code chips when playbookValidationExcludedPlaybooks is populated', () => {
      render(
        <SettingsView
          settings={{
            ...settings,
            playbookValidationExcludedPlaybooks: ['general-chat', 'triage-playbook'],
          }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Agents');
      expect(
        screen.queryByText('None configured; all playbooks are preflighted before sending.'),
      ).toBeNull();
      expect(screen.getByText('general-chat')).toBeTruthy();
      expect(screen.getByText('triage-playbook')).toBeTruthy();
      const codeElements = screen
        .getByText('Playbooks excluded from check')
        .closest('.settings-field')!
        .querySelectorAll('ul.settings-domain-list code');
      expect(codeElements.length).toBe(2);
      expect(codeElements[0].textContent).toBe('general-chat');
      expect(codeElements[1].textContent).toBe('triage-playbook');
    });

    it('enforces read-only immobility with no input, button, or edit controls in the excluded section', () => {
      render(
        <SettingsView
          settings={{
            ...settings,
            playbookValidationExcludedPlaybooks: ['general-chat'],
          }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Agents');
      const excludedSection = screen
        .getByText('Playbooks excluded from check')
        .closest('.settings-field')!;
      expect(excludedSection.querySelectorAll('input, button, select, textarea').length).toBe(0);
    });

    it('omits playbookValidationExcludedPlaybooks from onSave payload', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <SettingsView
          settings={{
            ...settings,
            playbookValidationExcludedPlaybooks: ['general-chat'],
          }}
          onSave={onSave}
          onClose={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const payload = onSave.mock.calls[0][0];
      expect('playbookValidationExcludedPlaybooks' in payload).toBe(false);
    });
  });

  describe('Wave 2: Claude account inline sign-in & prevSuccessCountRef guard', () => {
    function makeClaudeController(
      overrides: Partial<ClaudeSignInController> = {},
    ): ClaudeSignInController {
      return {
        signingIn: false,
        cancelling: false,
        copyingUrl: false,
        copiedUrl: false,
        altBrowserOpen: false,
        codeDraft: '',
        submittingCode: false,
        error: null,
        successCount: 0,
        startSignIn: vi.fn(async () => undefined),
        cancelSignIn: vi.fn(async () => undefined),
        toggleAltBrowser: vi.fn(),
        copySignInUrl: vi.fn(async () => undefined),
        setCodeDraft: vi.fn(),
        submitAuthCode: vi.fn(async () => undefined),
        ...overrides,
      };
    }

    it('renders Sign in to Claude strictly when missing or expired, never on ok/rate_limited/unreachable/error, and never renders a Claude sign-out button', async () => {
      const verifyAuth = vi
        .fn()
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'expired', message: 'Claude token expired' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'rate_limited', message: 'Rate limited' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'unreachable', message: 'Offline' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'error', message: 'Unexpected CLI error' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        });
      (window as unknown as { api: unknown }).api = { verifyAuth };

      const { rerender } = render(
        <SettingsView
          settings={settings}
          auth={{ claude: 'missing', server: { mode: 'dev', signedIn: true } }}
          claudeSignIn={makeClaudeController()}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');

      // Pre-verification with auth.claude === 'missing' offers Sign in to Claude
      expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();

      // Pre-verification with auth.claude === 'ok' hides Sign in to Claude
      rerender(
        <SettingsView
          settings={settings}
          auth={{ claude: 'ok', claudeAccount: 'claude@corp.com', server: { mode: 'dev', signedIn: true } }}
          claudeSignIn={makeClaudeController()}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
      expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();

      // 1. verification.claude.status === 'expired' -> shows Sign in to Claude
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Claude token expired/)).toBeTruthy());
      expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy();

      // 2. verification.claude.status === 'rate_limited' -> NO Sign in to Claude
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Rate limited/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();

      // 3. verification.claude.status === 'unreachable' -> NO Sign in to Claude
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Offline/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();

      // 4. verification.claude.status === 'error' -> NO Sign in to Claude
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Unexpected CLI error/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();

      // 5. verification.claude.status === 'ok' -> NO Sign in to Claude and NO Sign out
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified')).toHaveLength(2));
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
      expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    });

    it('disambiguates Sign in to Yvoke / Settings Close from Sign in to Claude / Cancel sign-in and disables sibling credential actions while signingIn is active', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'expired', message: 'Entra token expired' },
        claude: { status: 'expired', message: 'Claude session expired' },
      });
      (window as unknown as { api: unknown }).api = {
        verifyAuth,
        serverSignIn: vi.fn(),
        cancelServerSignIn: vi.fn(),
      };
      const onClose = vi.fn();
      const cancelSignIn = vi.fn(async () => undefined);

      const { rerender } = render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
          claudeSignIn={makeClaudeController()}
          onSave={vi.fn()}
          onClose={onClose}
        />,
      );
      openPane('Accounts');
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Claude session expired/)).toBeTruthy());

      // Both Sign in to Yvoke (Entra) and Sign in to Claude coexist with distinct accessible names
      expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy();

      // While Claude signingIn is true: Check Credentials and Sign in to Yvoke are disabled, and Close vs Cancel sign-in are distinct
      rerender(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
          claudeSignIn={makeClaudeController({ signingIn: true, cancelSignIn })}
          onSave={vi.fn()}
          onClose={onClose}
        />,
      );

      expect((screen.getByRole('button', { name: 'Check Credentials' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      expect(cancelSignIn).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('prevSuccessCountRef guard: calls verifyAuth and onAuthChange 0 times on mount when successCount >= 1, 0 verifyAuth calls when verification is null, and 1 verifyAuth call when verification is non-null', async () => {
      const verifyAuth = vi
        .fn()
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'expired', message: 'Claude expired' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'ok', account: 'fresh@corp.com' },
        });
      (window as unknown as { api: unknown }).api = { verifyAuth };
      const onAuthChange = vi.fn();

      // 1. Mount when successCount is ALREADY 2 -> 0 verifyAuth calls and 0 onAuthChange calls!
      const { rerender } = render(
        <SettingsView
          settings={settings}
          auth={{ claude: 'missing', server: { mode: 'dev', signedIn: true } }}
          claudeSignIn={makeClaudeController({ successCount: 2 })}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');
      expect(verifyAuth).toHaveBeenCalledTimes(0);
      expect(onAuthChange).toHaveBeenCalledTimes(0);

      // 2. Increment successCount (2 -> 3) while mounted with verification === null -> calls onAuthChange 1x, verifyAuth 0x
      rerender(
        <SettingsView
          settings={settings}
          auth={{ claude: 'ok', claudeAccount: 'fresh@corp.com', server: { mode: 'dev', signedIn: true } }}
          claudeSignIn={makeClaudeController({ successCount: 3 })}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(onAuthChange).toHaveBeenCalledTimes(1);
      expect(verifyAuth).toHaveBeenCalledTimes(0);

      // 3. Run Check Credentials so verification !== null (shows 'Claude expired')
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Claude expired/)).toBeTruthy());
      expect(verifyAuth).toHaveBeenCalledTimes(1);

      // 4. Increment successCount (3 -> 4) while mounted with verification !== null -> clears stale badge, calls onAuthChange (+1) & verifyAuth (+1)
      rerender(
        <SettingsView
          settings={settings}
          auth={{ claude: 'ok', claudeAccount: 'fresh@corp.com', server: { mode: 'dev', signedIn: true } }}
          claudeSignIn={makeClaudeController({ successCount: 4 })}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(onAuthChange).toHaveBeenCalledTimes(2);
      await waitFor(() => {
        expect(verifyAuth).toHaveBeenCalledTimes(2);
        expect(screen.getAllByText('✓ Verified')).toHaveLength(2);
      });
      expect(screen.queryByText(/Claude expired/)).toBeNull();
    });

    it('hides ClaudeSignInControls when a stale claudeSignIn.error exists alongside ok/rate_limited/unreachable/error verdicts, and calls clearError() when verifyAuth confirms claude ok', async () => {
      const verifyAuth = vi
        .fn()
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'rate_limited', message: 'Rate limited' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'srv@corp.com' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        });
      (window as unknown as { api: unknown }).api = { verifyAuth };
      const clearError = vi.fn();
      const staleErrorCtrl = makeClaudeController({
        error: 'Stale error from earlier login attempt',
        clearError,
      });

      render(
        <SettingsView
          settings={settings}
          auth={{ claude: 'ok', claudeAccount: 'claude@corp.com', server: { mode: 'dev', signedIn: true } }}
          claudeSignIn={staleErrorCtrl}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');

      // Pre-verification with auth.claude === 'ok': neither Sign in to Claude nor stale error is shown
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
      expect(screen.queryByText('Stale error from earlier login attempt')).toBeNull();

      // 1st Check Credentials -> rate_limited: still hides Sign in to Claude and stale error
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Rate limited/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
      expect(screen.queryByText('Stale error from earlier login attempt')).toBeNull();
      expect(clearError).not.toHaveBeenCalled();

      // 2nd Check Credentials -> claude ok: hides Sign in to Claude AND invokes clearError()
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified')).toHaveLength(2));
      expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
      expect(screen.queryByText('Stale error from earlier login attempt')).toBeNull();
      expect(clearError).toHaveBeenCalledTimes(1);
    });
  });

  describe('Wave 6: Accounts pane, slim About pane, paneRequest & dirty-aware footer', () => {
    function makeServerController(
      overrides: Partial<ServerSignInController> = {},
    ): ServerSignInController {
      return {
        signingIn: false,
        cancelling: false,
        error: null,
        successCount: 0,
        startSignIn: vi.fn(async () => undefined),
        cancelSignIn: vi.fn(async () => undefined),
        clearError: vi.fn(),
        ...overrides,
      };
    }

    it('exports SETTINGS_PANES with Accounts right after Server', () => {
      expect(SETTINGS_PANES).toEqual([
        'Server',
        'Accounts',
        'Models',
        'Agents',
        'Web search',
        'Appearance',
        'Advanced',
        'About',
      ]);
    });

    it('areSettingsEqual normalizes whitespace, arrays, and optional default fields while catching real edits', () => {
      const base: AppSettings = { ...settings };
      // Identical copy is equal
      expect(areSettingsEqual(base, { ...base })).toBe(true);
      // Whitespace-only differences normalize to equal
      expect(
        areSettingsEqual(base, {
          ...base,
          serverBaseUrl: `  ${base.serverBaseUrl}  `,
          entra: { clientId: ' c ', tenantId: ' t ', scope: ' s ' },
          defaultModel: ' sonnet ',
          models: [' sonnet '],
        }),
      ).toBe(true);
      // Absent optional booleans default to true (playbookValidationEnabled, imageDescriptionsEnabled) / false (showPrototypePlaybooks)
      expect(
        areSettingsEqual(base, {
          ...base,
          playbookValidationEnabled: true,
          imageDescriptionsEnabled: true,
          showPrototypePlaybooks: false,
        }),
      ).toBe(true);
      // Real edits are detected
      expect(areSettingsEqual(base, { ...base, serverBaseUrl: 'https://other.example/' })).toBe(false);
      expect(areSettingsEqual(base, { ...base, maxTurns: 30 })).toBe(false);
      expect(areSettingsEqual(base, { ...base, models: ['sonnet', 'opus'] })).toBe(false);
      expect(areSettingsEqual(base, { ...base, showPrototypePlaybooks: true })).toBe(false);
      expect(areSettingsEqual(base, { ...base, webSearch: { ...base.webSearch, enabled: true } })).toBe(false);
      expect(
        areSettingsEqual(base, {
          ...base,
          appearance: { theme: 'dark', density: 'comfortable', answerTextSize: 14, traceExpanded: false },
        }),
      ).toBe(false);
    });

    it('shows Close button on clean Accounts and About panes, and shows dirty-draft notice + Cancel/Save when draft is modified', () => {
      const onClose = vi.fn();
      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={onClose} />);

      // Clean Accounts pane -> single Close button, no Cancel/Save
      openPane('Accounts');
      expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

      // Clean About pane -> single Close button, no Cancel/Save
      openPane('About');
      expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

      // Modify a setting in Models, then revisit Accounts and About -> dirty notice + Cancel + Save
      openPane('Models');
      fireEvent.change(screen.getByLabelText('Max turns per message'), { target: { value: '42' } });

      openPane('Accounts');
      expect(screen.getByText('You have unsaved changes in other settings panes.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

      openPane('About');
      expect(screen.getByText('You have unsaved changes in other settings panes.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    });

    it('switches active pane via paneRequest without discarding dirty draft edits', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <SettingsView settings={settings} onSave={onSave} onClose={vi.fn()} />,
      );

      openPane('Models');
      fireEvent.change(screen.getByLabelText('Max turns per message'), { target: { value: '55' } });

      // Incoming paneRequest switches to Accounts while preserving draft
      rerender(
        <SettingsView
          settings={settings}
          paneRequest={{ pane: 'Accounts', seq: 1 }}
          onSave={onSave}
          onClose={vi.fn()}
        />,
      );

      expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy();
      expect(screen.getByText('You have unsaved changes in other settings panes.')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 55 })));
    });

    it('gates Accounts Yvoke row strictly on saved props.auth.server.mode (never draft.serverAuthMode)', () => {
      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'dev' }}
          auth={{ claude: 'ok', server: { mode: 'dev', signedIn: true } }}
          serverSignIn={makeServerController()}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      // Edit draft.serverAuthMode to 'entra' without saving
      const modeGroup = screen.getByRole('group', { name: 'Server authentication' });
      fireEvent.click(within(modeGroup).getByRole('button', { name: 'Entra ID' }));

      openPane('Accounts');
      // Still shows Dev mode and NO Sign in to Yvoke button because saved auth.server.mode is 'dev'
      expect(screen.getByText('Dev mode')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    });

    it('shows upfront Sign in to Yvoke when Entra signed out, hides on unreachable/rate_limited/error/ok, shows inline Entra Sign out only (never Claude), and uses plain Signed in / Not signed in copy', async () => {
      const verifyAuth = vi
        .fn()
        .mockResolvedValueOnce({
          server: { status: 'unreachable', message: 'Server offline' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        })
        .mockResolvedValueOnce({
          server: { status: 'rate_limited', message: 'Too many requests' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        })
        .mockResolvedValueOnce({
          server: { status: 'error', message: 'Unexpected error' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'alice@corp.com' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        });
      (window as unknown as { api: unknown }).api = { verifyAuth };
      const onSignOut = vi.fn();
      const clearError = vi.fn();

      const { rerender } = render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{ claude: 'missing', server: { mode: 'entra', signedIn: false } }}
          serverSignIn={makeServerController({ clearError })}
          onSignOut={onSignOut}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');

      // Plain "Not signed in" copy (no old "Detected from Claude Code")
      expect(screen.getAllByText('Not signed in')).toHaveLength(2);
      expect(document.body.textContent).not.toContain('Detected from Claude Code');
      expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();

      // Verification: unreachable / rate_limited / error hide Sign in to Yvoke
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Server offline/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Too many requests/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Unexpected error/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();

      // Verification: server ok invokes serverSignIn.clearError()
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified')).toHaveLength(2));
      expect(clearError).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();

      // Signed-in Entra shows plain Signed in + exactly 1 Sign out button (for Entra only, never Claude)
      rerender(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{
            claude: 'ok',
            claudeAccount: 'claude@corp.com',
            server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' },
          }}
          serverSignIn={makeServerController({ clearError })}
          onSignOut={onSignOut}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      const signOutBtns = screen.getAllByRole('button', { name: 'Sign out' });
      expect(signOutBtns).toHaveLength(1);
      fireEvent.click(signOutBtns[0]);
      expect(onSignOut).toHaveBeenCalledTimes(1);
    });

    it('prevServerSuccessCountRef guard: 0 verifyAuth on mount when successCount >= 1, 0 when verification is null, 1 when verification is non-null', async () => {
      const verifyAuth = vi
        .fn()
        .mockResolvedValueOnce({
          server: { status: 'expired', message: 'Entra expired' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        })
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'alice@corp.com' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        });
      (window as unknown as { api: unknown }).api = { verifyAuth };
      const onAuthChange = vi.fn();

      const { rerender } = render(
        <SettingsView
          settings={settings}
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
          serverSignIn={makeServerController({ successCount: 2 })}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');
      expect(verifyAuth).toHaveBeenCalledTimes(0);
      expect(onAuthChange).toHaveBeenCalledTimes(0);

      // Increment successCount while verification === null -> 0 verifyAuth calls
      rerender(
        <SettingsView
          settings={settings}
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: true } }}
          serverSignIn={makeServerController({ successCount: 3 })}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(onAuthChange).toHaveBeenCalledTimes(1);
      expect(verifyAuth).toHaveBeenCalledTimes(0);

      // Verify once so verification !== null
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Entra expired/)).toBeTruthy());
      expect(verifyAuth).toHaveBeenCalledTimes(1);

      // Increment successCount while verification !== null -> re-verifies once
      rerender(
        <SettingsView
          settings={settings}
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' } }}
          serverSignIn={makeServerController({ successCount: 4 })}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => {
        expect(verifyAuth).toHaveBeenCalledTimes(2);
        expect(screen.getAllByText('✓ Verified')).toHaveLength(2);
      });
    });

    it('renders slim About pane with Version, Check for Updates, .about-url Server, and Open Logs Folder without credential rows', () => {
      const { container } = render(
        <SettingsView
          settings={settings}
          appVersion="1.3.1"
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: true } }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('About');

      expect(screen.getByText('v1.3.1')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Check for Updates' })).toBeTruthy();
      const serverUrlDd = container.querySelector('dd.about-url');
      expect(serverUrlDd).not.toBeNull();
      expect(serverUrlDd!.textContent).toBe('https://app.example/');
      expect(screen.getByRole('button', { name: 'Open Logs Folder' })).toBeTruthy();

      // Credential controls moved to Accounts
      expect(screen.queryByRole('button', { name: 'Check Credentials' })).toBeNull();
      expect(screen.queryByText('Yvoke account')).toBeNull();
      expect(screen.queryByText('Claude account')).toBeNull();
    });

    it('clears stale verification verdict on Entra sign-out (true -> false) so Sign in to Yvoke reappears, and drops late in-flight verifyAuth resolutions', async () => {
      let resolveSecondVerify!: (val: AuthVerificationResponse) => void;
      const verifyAuth = vi
        .fn()
        .mockResolvedValueOnce({
          server: { status: 'ok', account: 'alice@corp.com' },
          claude: { status: 'ok', account: 'claude@corp.com' },
        })
        .mockImplementationOnce(
          () =>
            new Promise<AuthVerificationResponse>((resolve) => {
              resolveSecondVerify = resolve;
            }),
        );
      (window as unknown as { api: unknown }).api = { verifyAuth };
      const onSignOut = vi.fn();

      const { rerender } = render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{
            claude: 'ok',
            claudeAccount: 'claude@corp.com',
            server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' },
          }}
          serverSignIn={makeServerController()}
          onSignOut={onSignOut}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');

      // 1. Verify while signed in -> ✓ Verified shown, Sign in to Yvoke hidden
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified')).toHaveLength(2));
      expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();

      // 2. Sign out completes (props.auth.server.signedIn flips true -> false) -> stale ✓ Verified cleared & Sign in to Yvoke rendered!
      rerender(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{
            claude: 'ok',
            claudeAccount: 'claude@corp.com',
            server: { mode: 'entra', signedIn: false },
          }}
          serverSignIn={makeServerController()}
          onSignOut={onSignOut}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryAllByText('✓ Verified')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();

      // 3. Re-sign in, start an in-flight verifyAuth, then sign out BEFORE it resolves -> late resolution is discarded!
      rerender(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{
            claude: 'ok',
            claudeAccount: 'claude@corp.com',
            server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' },
          }}
          serverSignIn={makeServerController()}
          onSignOut={onSignOut}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      expect(verifyAuth).toHaveBeenCalledTimes(2);

      rerender(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{
            claude: 'ok',
            claudeAccount: 'claude@corp.com',
            server: { mode: 'entra', signedIn: false },
          }}
          serverSignIn={makeServerController()}
          onSignOut={onSignOut}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      resolveSecondVerify({
        server: { status: 'ok', account: 'stale@corp.com' },
        claude: { status: 'ok', account: 'claude@corp.com' },
      });
      await new Promise((r) => setTimeout(r, 15));

      expect(screen.queryAllByText('✓ Verified')).toHaveLength(0);
      expect(document.body.textContent).not.toContain('stale@corp.com');
      expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Check Credentials' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it('omits inline Sign out button in Accounts pane when onSignOut callback is not provided', () => {
      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{
            claude: 'ok',
            server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' },
          }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('Accounts');
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    });
  });
});
