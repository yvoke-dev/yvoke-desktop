import { describe, expect, it } from 'vitest';
import { THINKING_BUDGETS, thinkingBudget } from '../src/main/agent/thinking';

describe('thinking level mapping', () => {
  it('maps every level to a budget, ascending', () => {
    expect(thinkingBudget('off')).toBe(0);
    expect(THINKING_BUDGETS.off).toBeLessThan(THINKING_BUDGETS.low);
    expect(THINKING_BUDGETS.low).toBeLessThan(THINKING_BUDGETS.medium);
    expect(THINKING_BUDGETS.medium).toBeLessThan(THINKING_BUDGETS.high);
  });
});
