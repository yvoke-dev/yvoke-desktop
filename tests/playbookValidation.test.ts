import { describe, expect, it } from 'vitest';
import {
  buildValidatorSystemPrompt,
  parseValidation,
} from '../src/main/agent/playbookValidation';
import type { McpPromptInfo } from '../src/shared/types';

function playbook(name: string, title = name, description = ''): McpPromptInfo {
  return { name, title, description, arguments: [] };
}

const PLAYBOOKS = [
  playbook('oim-getting-started', 'Getting started', 'Onboarding and end-user questions.'),
  playbook('oim-schema', 'Schema', 'Table and column definitions.'),
  playbook('oim-customers', 'Customers', 'Customer deployments and versions.'),
];

const SELECTED = 'oim-getting-started';

describe('buildValidatorSystemPrompt', () => {
  it('lists every candidate as name | title | description', () => {
    const prompt = buildValidatorSystemPrompt(PLAYBOOKS, SELECTED);
    expect(prompt).toContain('oim-schema | Schema | Table and column definitions.');
    expect(prompt).toContain('oim-customers | Customers | Customer deployments and versions.');
  });

  it('names the selected playbook and asks for raw JSON', () => {
    const prompt = buildValidatorSystemPrompt(PLAYBOOKS, SELECTED);
    expect(prompt).toContain(`Selected Playbook Name:\n${SELECTED}`);
    expect(prompt).toContain('"suggestedPlaybookName"');
  });
});

describe('parseValidation', () => {
  it('passes a plausible verdict through', () => {
    const raw = '{"plausible": true, "reason": "", "suggestedPlaybookName": null}';
    expect(parseValidation(raw, PLAYBOOKS, SELECTED)).toEqual({ plausible: true });
  });

  it('returns the reason and the suggestion, with its display title resolved', () => {
    const raw = JSON.stringify({
      plausible: false,
      reason: 'The question is about table columns.',
      suggestedPlaybookName: 'oim-schema',
    });
    expect(parseValidation(raw, PLAYBOOKS, SELECTED)).toEqual({
      plausible: false,
      reason: 'The question is about table columns.',
      suggestedPlaybookName: 'oim-schema',
      suggestedPlaybookTitle: 'Schema',
    });
  });

  // The prompt forbids fences; models add them anyway, and the web strips them server-side too.
  it('reads a verdict wrapped in a markdown fence or trailing prose', () => {
    const fenced = '```json\n{"plausible": false, "reason": "Wrong area.", "suggestedPlaybookName": "oim-schema"}\n```';
    expect(parseValidation(fenced, PLAYBOOKS, SELECTED).suggestedPlaybookName).toBe('oim-schema');
    const chatty = 'Here is my verdict:\n{"plausible": false, "reason": "Wrong area.", "suggestedPlaybookName": "oim-schema"}\nHope that helps.';
    expect(parseValidation(chatty, PLAYBOOKS, SELECTED).reason).toBe('Wrong area.');
  });

  // The hallucination guard: if the model suggests a playbook not on the list, fail open.
  it('passes when a suggestion names a playbook that is not on the list', () => {
    const raw = JSON.stringify({
      plausible: false,
      reason: 'Try something else.',
      suggestedPlaybookName: 'oim-invented',
    });
    expect(parseValidation(raw, PLAYBOOKS, SELECTED)).toEqual({ plausible: true });
  });

  // If the model suggests the already-selected playbook (by name or title), treat it as passing.
  it('passes when a suggestion names the already-selected playbook by name', () => {
    const raw = JSON.stringify({
      plausible: false,
      reason: 'This is actually fine.',
      suggestedPlaybookName: SELECTED,
    });
    expect(parseValidation(raw, PLAYBOOKS, SELECTED)).toEqual({ plausible: true });
  });

  it('passes when a suggestion names the already-selected playbook by title', () => {
    const raw = JSON.stringify({
      plausible: false,
      reason: 'This is actually fine.',
      suggestedPlaybookName: 'Getting started',
    });
    expect(parseValidation(raw, PLAYBOOKS, SELECTED)).toEqual({ plausible: true });
  });

  it('accepts a suggestion matching by title', () => {
    const raw = JSON.stringify({
      plausible: false,
      reason: 'Table question.',
      suggestedPlaybookName: 'Schema',
    });
    expect(parseValidation(raw, PLAYBOOKS, SELECTED)).toEqual({
      plausible: false,
      reason: 'Table question.',
      suggestedPlaybookName: 'oim-schema',
      suggestedPlaybookTitle: 'Schema',
    });
  });

  it('accepts a suggestion whose case does not match the list', () => {
    const raw = JSON.stringify({ plausible: false, reason: 'x', suggestedPlaybookName: 'OIM-Schema' });
    expect(parseValidation(raw, PLAYBOOKS, SELECTED).suggestedPlaybookName).toBe('oim-schema');
  });

  // Fail open, in every shape the model can fail in.
  it.each([
    ['prose instead of JSON', 'I think the playbook is fine, honestly.'],
    ['an empty reply', ''],
    ['broken JSON', '{"plausible": false, "reason":'],
    ['a non-boolean verdict', '{"plausible": "no", "reason": "Wrong.", "suggestedPlaybookName": "oim-schema"}'],
    ['a rejection with nothing to show', '{"plausible": false, "reason": "  ", "suggestedPlaybookName": null}'],
  ])('passes on %s', (_label, raw) => {
    expect(parseValidation(raw, PLAYBOOKS, SELECTED)).toEqual({ plausible: true });
  });
});
