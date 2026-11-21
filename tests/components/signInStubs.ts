import { vi } from 'vitest';
import type { ClaudeSignInController } from '../../src/renderer/src/components/ClaudeSignInControls';
import type { ServerSignInController } from '../../src/renderer/src/components/ServerSignInControls';

export function makeClaudeSignInStub(
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
    clearError: vi.fn(),
    ...overrides,
  };
}

export function makeServerSignInStub(
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
