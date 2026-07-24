import type { ThinkingLevel } from '../../shared/types';

/**
 * Thinking_Level → maxThinkingTokens budget. `null` means "SDK default".
 * Values calibrated during the Wave-0 spike: 0 disables thinking; the tiers
 * mirror Claude Code's think / think-hard / ultrathink budgets.
 */
export const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  low: 4096,
  medium: 10_000,
  high: 31_999,
};

export function thinkingBudget(level: ThinkingLevel): number {
  return THINKING_BUDGETS[level];
}
