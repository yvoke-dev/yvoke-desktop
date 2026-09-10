// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsView } from '../../src/renderer/src/components/SettingsView';
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

      openPane('About');
      expect(verifyAuth).not.toHaveBeenCalled();

      // "Check Credentials" button is present in About pane
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
      openPane('About');

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
      openPane('About');

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
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('About');
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified').length).toBe(2));

      // Switch the mode without saving; main has still only ever verified dev mode.
      openPane('Server');
      const modeGroup = screen.getByRole('group', { name: 'Server authentication' });
      fireEvent.click(within(modeGroup).getByRole('button', { name: 'Entra ID' }));
      openPane('About');

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
      openPane('About');
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getAllByText('✓ Verified').length).toBe(2));

      openPane('Server');
      fireEvent.change(screen.getByLabelText('Server base URL'), {
        target: { value: 'https://other.example' },
      });
      openPane('About');

      expect(screen.queryAllByText('✓ Verified')).toHaveLength(0);
    });

    it('Test 3.3: IPC transport rejection - error surfaced in banner without crashing', async () => {
      const verifyAuth = vi.fn().mockRejectedValue(new Error('IPC transport failed'));
      (window as unknown as { api: unknown }).api = { verifyAuth };

      render(<SettingsView settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
      openPane('About');

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
      openPane('About');

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

    it('renders failure alerts with inline "Sign in" button in Entra mode and handles sign-in', async () => {
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
      const serverSignIn = vi.fn().mockResolvedValue('new-token');
      const onAuthChange = vi.fn();
      (window as unknown as { api: unknown }).api = { verifyAuth, serverSignIn };

      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
          onAuthChange={onAuthChange}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('About');

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

      // Inline "Sign in" button is rendered in Entra mode
      const signInBtn = screen.getByRole('button', { name: 'Sign in' });
      expect(signInBtn).toBeTruthy();
      expect(signInBtn.className).toContain('cred-inline-btn');

      // Click inline sign in
      fireEvent.click(signInBtn);

      await waitFor(() => {
        expect(serverSignIn).toHaveBeenCalledTimes(1);
        expect(onAuthChange).toHaveBeenCalledTimes(1);
      });
    });


    it('offers no inline Sign in when the saved mode is the dev token', async () => {
      const verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'expired', message: 'Token expired' },
        claude: { status: 'ok', account: 'claude@corp.com' },
      });
      (window as unknown as { api: unknown }).api = { verifyAuth, serverSignIn: vi.fn() };

      render(
        <SettingsView
          settings={{ ...settings, serverAuthMode: 'entra' }}
          auth={{ claude: 'ok', server: { mode: 'dev', signedIn: true } }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('About');
      fireEvent.click(screen.getByRole('button', { name: 'Check Credentials' }));
      await waitFor(() => expect(screen.getByText(/Token expired/)).toBeTruthy());

      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
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
          onSave={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      openPane('About');

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

      // In Dev token mode, inline "Sign in" button is NOT rendered
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    });
  });
});
