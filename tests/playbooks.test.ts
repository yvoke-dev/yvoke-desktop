import { describe, expect, it } from 'vitest';
import {
  controlPlaybookNames,
  isUserSelectablePlaybook,
  isUserSelectableProfile,
} from '../src/shared/types';
import type { McpPromptInfo, OrchestratorProfile } from '../src/shared/types';

function playbook(name: string, targetAgent?: string, prototype?: boolean): McpPromptInfo {
  return { name, title: name, description: '', arguments: [], targetAgent, prototype };
}

/** The two profiles the server actually serves, both driving the same control pair. */
const profiles: OrchestratorProfile[] = [
  {
    name: 'OIM',
    orchestratorPlaybook: 'oim-orchestrator',
    reviewerPlaybook: 'oim-orchestrator-reviewer',
    specialistPlaybooks: ['oim-getting-started'],
  },
  {
    name: 'OIM Browsing',
    orchestratorPlaybook: 'oim-orchestrator',
    reviewerPlaybook: 'oim-orchestrator-reviewer',
    specialistPlaybooks: ['oim-getting-started-browsing'],
  },
];

describe('playbook visibility', () => {
  const control = controlPlaybookNames(profiles);

  it('collects each profile’s control pair, deduplicated across profiles', () => {
    expect([...control].sort()).toEqual(['oim-orchestrator', 'oim-orchestrator-reviewer']);
  });

  it('shows specialist playbooks', () => {
    expect(isUserSelectablePlaybook(playbook('oim-getting-started', 'specialist'), control)).toBe(true);
    expect(isUserSelectablePlaybook(playbook('oim-full', 'specialist'), control)).toBe(true);
  });

  it('hides the orchestrator and reviewer a profile names', () => {
    expect(isUserSelectablePlaybook(playbook('oim-orchestrator', 'orchestrator'), control)).toBe(false);
    expect(isUserSelectablePlaybook(playbook('oim-orchestrator-reviewer', 'reviewer'), control)).toBe(false);
  });

  // The case that prompted the fix: the eval harness's judge is a reviewer that no profile
  // references, so filtering on profile membership alone left it sitting in the picker.
  it('hides a reviewer that no profile references', () => {
    expect(isUserSelectablePlaybook(playbook('oim-eval-reviewer', 'reviewer'), control)).toBe(false);
  });

  // Belt and braces: a server that omits the metadata is still covered for its profile's own pair.
  it('still hides a profile’s control pair when the server sends no role', () => {
    expect(isUserSelectablePlaybook(playbook('oim-orchestrator'), control)).toBe(false);
    expect(isUserSelectablePlaybook(playbook('oim-orchestrator-reviewer'), control)).toBe(false);
  });

  // Failing closed here would leave an empty picker against an older server.
  it('shows an unlabelled playbook no profile claims', () => {
    expect(isUserSelectablePlaybook(playbook('oim-customers'), control)).toBe(true);
  });

  it('hides control roles even with no profiles loaded at all', () => {
    const none = controlPlaybookNames([]);
    expect(isUserSelectablePlaybook(playbook('oim-eval-reviewer', 'reviewer'), none)).toBe(false);
    expect(isUserSelectablePlaybook(playbook('oim-orchestrator', 'orchestrator'), none)).toBe(false);
    expect(isUserSelectablePlaybook(playbook('oim-getting-started', 'specialist'), none)).toBe(true);
  });

  it('hides prototype playbooks by default when showPrototypes is false or omitted', () => {
    const protoPlaybook = playbook('oim-getting-started-browsing', 'specialist', true);
    expect(isUserSelectablePlaybook(protoPlaybook, control)).toBe(false);
    expect(isUserSelectablePlaybook(protoPlaybook, control, false)).toBe(false);
  });

  it('shows prototype playbooks when showPrototypes is true', () => {
    const protoPlaybook = playbook('oim-getting-started-browsing', 'specialist', true);
    expect(isUserSelectablePlaybook(protoPlaybook, control, true)).toBe(true);
  });

  it('still hides orchestrator and reviewer playbooks even when showPrototypes is true', () => {
    const protoOrch = playbook('oim-orchestrator', 'orchestrator', true);
    const protoRev = playbook('oim-orchestrator-reviewer', 'reviewer', true);
    expect(isUserSelectablePlaybook(protoOrch, control, true)).toBe(false);
    expect(isUserSelectablePlaybook(protoRev, control, true)).toBe(false);
  });
});

describe('isUserSelectableProfile', () => {
  function profile(name: string, prototype?: boolean): OrchestratorProfile {
    return {
      name,
      orchestratorPlaybook: 'oim-orchestrator',
      reviewerPlaybook: 'oim-orchestrator-reviewer',
      specialistPlaybooks: [],
      prototype,
    };
  }

  it('offers an ordinary profile whatever the setting says', () => {
    expect(isUserSelectableProfile(profile('OIM'))).toBe(true);
    expect(isUserSelectableProfile(profile('OIM'), false)).toBe(true);
    expect(isUserSelectableProfile(profile('OIM'), true)).toBe(true);
  });

  it('hides a prototype profile by default and when showPrototypes is false', () => {
    expect(isUserSelectableProfile(profile('OIM Browsing', true))).toBe(false);
    expect(isUserSelectableProfile(profile('OIM Browsing', true), false)).toBe(false);
  });

  it('shows a prototype profile when showPrototypes is true', () => {
    expect(isUserSelectableProfile(profile('OIM Browsing', true), true)).toBe(true);
  });

  // Dropping the value the picker is currently displaying makes the select fall back to
  // "Single agent" while the thread is still in orchestrator mode — the control would then
  // misreport how the next question is answered, and nothing but re-picking would fix it.
  it('never hides the profile the thread is already bound to', () => {
    expect(isUserSelectableProfile(profile('OIM Browsing', true), false, 'OIM Browsing')).toBe(true);
  });

  it('withdraws that exemption once the thread selects something else', () => {
    expect(isUserSelectableProfile(profile('OIM Browsing', true), false, 'OIM')).toBe(false);
  });

  // An older server sends no flag at all. Reading absent as "prototype" would empty the picker
  // against every deployment that has not shipped the field yet.
  it('treats an absent flag as not a prototype', () => {
    expect(isUserSelectableProfile(profile('OIM', undefined), false)).toBe(true);
  });
});
