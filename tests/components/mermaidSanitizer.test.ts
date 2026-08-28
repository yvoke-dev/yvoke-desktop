import { describe, expect, it } from 'vitest';
import { sanitizeMermaid, sanitizeMermaidStages } from '../../src/renderer/src/components/mermaidSanitizer';

describe('mermaidSanitizer', () => {
  it('leaves already valid sequence diagrams unchanged', () => {
    const valid = `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Hello Bob
    B-->>A: Hello Alice`;

    const result = sanitizeMermaid(valid);
    expect(result.isModified).toBe(false);
    expect(result.sanitized).toBe(valid);
    expect(result.appliedFixes).toHaveLength(0);
  });

  it('fixes the exact problematic sequence diagram from user issue', () => {
    const problematic = `sequenceDiagram
    participant U as User
    participant WP as Web Portal (Service Catalog)
    participant DB as OIM Database
    participant AP as Approver(s)
    participant JOB as Job Server (Entra connector)
    participant ENTRA as Microsoft Entra ID

    U->>WP: Browse service catalog, add Entra group to cart
    U->>WP: Set validity/reason, submit shopping cart
    WP->>DB: Create request; determine effective approval policy
    DB->>AP: Start approval workflow; notify approvers
    AP->>DB: Approve (or self-service auto-approve)
    DB->>DB: Assign product (PersonInITShopOrg),\\ninherit group membership
    DB->>JOB: Trigger provisioning process
    JOB->>ENTRA: Add user to Entra group via Graph API
    ENTRA-->>JOB: Confirmation
    JOB->>DB: Status -> Provisioned`;

    const result = sanitizeMermaid(problematic);
    expect(result.isModified).toBe(true);

    // Semicolons replaced with commas
    expect(result.sanitized).toContain('WP->>DB: Create request, determine effective approval policy');
    expect(result.sanitized).toContain('DB->>AP: Start approval workflow, notify approvers');

    // Literal \n replaced with <br/>
    expect(result.sanitized).toContain('Assign product (PersonInITShopOrg),<br/>inherit group membership');

    // Arrow operator in label replaced with Unicode arrow
    expect(result.sanitized).toContain('JOB->>DB: Status → Provisioned');

    expect(result.appliedFixes).toContain('Replaced semicolons with commas in sequence message label');
    expect(result.appliedFixes).toContain('Replaced literal \\n with <br/>');
    expect(result.appliedFixes).toContain('Replaced arrow operator inside label with Unicode arrow');
  });

  it('quotes flowchart node labels containing parentheses', () => {
    const chart = `flowchart TD
    A[Start (Initial Step)] --> B[Process (Validation)]
    B --> C["Already Quoted (Ok)"]`;

    const result = sanitizeMermaid(chart);
    expect(result.isModified).toBe(true);
    expect(result.sanitized).toContain('A["Start (Initial Step)"]');
    expect(result.sanitized).toContain('B["Process (Validation)"]');
    expect(result.sanitized).toContain('C["Already Quoted (Ok)"]');
  });

  it('handles empty or non-string inputs safely', () => {
    expect(sanitizeMermaid('').isModified).toBe(false);
    expect(sanitizeMermaid(null as any).isModified).toBe(false);
  });

  it('quotes a flowchart node label containing a semicolon, which is a statement separator', () => {
    const result = sanitizeMermaid('flowchart TD\n  A[Do this; then that] --> B');
    expect(result.isModified).toBe(true);
    expect(result.sanitized).toContain('A["Do this; then that"]');
  });

  it('quotes a subgraph title, where a space before the bracket hid it from the node regex', () => {
    const result = sanitizeMermaid('flowchart TD\n  subgraph S1 [Group (one)]\n    A[Node]\n  end');
    expect(result.isModified).toBe(true);
    expect(result.sanitized).toContain('subgraph S1 ["Group (one)"]');
  });

  it('leaves an already-quoted label alone rather than double-quoting it', () => {
    const result = sanitizeMermaid('flowchart TD\n  C["Already Quoted (Ok)"] --> D');
    expect(result.isModified).toBe(false);
  });
});

/**
 * The staging guarantee, which is what keeps a Windows path out of the escape rewrite: quoting
 * cannot change what the reader sees, character substitution can, and the `\n` rewrite cannot be
 * told apart from content. A renderer walks these in order and stops at the first that parses.
 */
describe('sanitizeMermaidStages', () => {
  const withPath = 'sequenceDiagram\n  U->>DB: Load C:\\new\\config; then run';

  it('offers the semicolon repair before the escape rewrite', () => {
    const stages = sanitizeMermaidStages(withPath);
    expect(stages.length).toBe(2);

    // First stage fixes the actual parse error and leaves the path byte-for-byte intact.
    expect(stages[0].sanitized).toContain('Load C:\\new\\config, then run');
    expect(stages[0].sanitized).not.toContain('<br/>');
    expect(stages[0].appliedFixes).toEqual(['Replaced semicolons with commas in sequence message label']);

    // Only the last resort mangles it — and it is reached only if the first stage did not parse.
    expect(stages[1].sanitized).toContain('C:<br/>ew');
    expect(stages[1].appliedFixes).toContain('Replaced literal \\n with <br/>');
  });

  it('never rewrites a backslash at the syntactic or text level', () => {
    expect(sanitizeMermaid(withPath, 'syntactic').sanitized).toContain('C:\\new');
    expect(sanitizeMermaid(withPath, 'text').sanitized).toContain('C:\\new');
    expect(sanitizeMermaid(withPath, 'escapes').sanitized).not.toContain('C:\\new');
  });

  it('collapses stages that produce the same text, so a flowchart costs one extra attempt', () => {
    const stages = sanitizeMermaidStages('flowchart TD\n  A[Start (x)] --> B');
    expect(stages).toHaveLength(1);
    expect(stages[0].sanitized).toContain('A["Start (x)"]');
  });

  it('returns nothing to try for a diagram it cannot repair', () => {
    expect(sanitizeMermaidStages('sequenceDiagram\n  A->>B: fine')).toEqual([]);
    expect(sanitizeMermaidStages('')).toEqual([]);
  });
});
