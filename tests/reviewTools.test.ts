import { describe, expect, it } from 'vitest';
import { isCitationOnlyVerdict, type ReviewVerdict } from '../src/shared/types';
import {
  formatVerdictSummary,
  REVIEW_SERVER_NAME,
  REVIEW_SUBMIT_TOOL,
  submitReviewCall,
} from '../src/main/agent/reviewTools';
import { buildReviewServer } from '../src/main/agent/reviewServer';

/**
 * Unit tests for `submit_review` (`reviewTools.ts` & `reviewServer.ts`) — ported from
 * `SubmitReviewToolTest.java` in `yvoke-web`.
 */
describe('submitReviewCall (SubmitReviewToolTest parity)', () => {
  it('exposes canonical review server and tool names', () => {
    expect(REVIEW_SERVER_NAME).toBe('review');
    expect(REVIEW_SUBMIT_TOOL).toBe('mcp__review__submit_review');
  });

  it('approvedTrue_capturesApprovedVerdict_returnsRecorded', () => {
    const holder: (ReviewVerdict | null)[] = [null];
    const out = submitReviewCall(
      '{"approved":true,"feedback":"looks good"}',
      (v) => {
        holder[0] = v;
      },
    );

    expect(out).toEqual({ text: 'Verdict recorded.' });
    expect(holder[0]).not.toBeNull();
    expect(holder[0]?.approved).toBe(true);
    expect(holder[0]?.feedback).toBe('looks good');
    expect(holder[0]?.unsupportedClaims).toEqual([]);
    expect(holder[0]?.citationFixes).toEqual([]);
  });

  it('approvedFalse_capturesRejectionWithClaimsAndCitationFixes', () => {
    const holder: (ReviewVerdict | null)[] = [null];
    submitReviewCall(
      JSON.stringify({
        approved: false,
        feedback: 'missing citation and wrong source',
        unsupported_claims: ['claim 1', 'claim 2'],
        citation_fixes: ['swap [2] to [1] on the SAP claim'],
      }),
      (v) => {
        holder[0] = v;
      },
    );

    expect(holder[0]?.approved).toBe(false);
    expect(holder[0]?.feedback).toBe('missing citation and wrong source');
    expect(holder[0]?.unsupportedClaims).toEqual(['claim 1', 'claim 2']);
    expect(holder[0]?.citationFixes).toEqual(['swap [2] to [1] on the SAP claim']);
  });

  it('approvedMissing_defaultsToFalse', () => {
    const holder: (ReviewVerdict | null)[] = [null];
    submitReviewCall({ feedback: 'n/a' }, (v) => {
      holder[0] = v;
    });

    expect(holder[0]?.approved).toBe(false);
    expect(holder[0]?.feedback).toBe('n/a');
  });

  it('explicitNullUnsupportedClaimsAndCitationFixes_coercedToEmptyList', () => {
    const holder: (ReviewVerdict | null)[] = [null];
    submitReviewCall(
      '{"approved":false,"feedback":"x","unsupported_claims":null,"citation_fixes":null}',
      (v) => {
        holder[0] = v;
      },
    );

    expect(holder[0]?.unsupportedClaims).toEqual([]);
    expect(holder[0]?.citationFixes).toEqual([]);
  });

  it('malformedJson_returnsParseError_doesNotDeliver', () => {
    const holder: (ReviewVerdict | null)[] = [null];
    const out = submitReviewCall('garbage{', (v) => {
      holder[0] = v;
    });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^Error parsing arguments:/);
    expect(holder[0]).toBeNull();
  });

  it('rejects non-object inputs without invoking callback', () => {
    const holder: (ReviewVerdict | null)[] = [null];
    const out = submitReviewCall(null, (v) => {
      holder[0] = v;
    });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^Error parsing arguments:/);
    expect(holder[0]).toBeNull();
  });
});

describe('isCitationOnlyVerdict (Verdict.isCitationOnly parity)', () => {
  it('returns true only when citationFixes is non-empty and unsupportedClaims is empty', () => {
    expect(
      isCitationOnlyVerdict({
        approved: false,
        feedback: 'fix ref',
        citationFixes: ['swap [2] to [1]'],
        unsupportedClaims: [],
      }),
    ).toBe(true);
  });

  it('returns false when both lists are empty (prose-only rejection)', () => {
    expect(
      isCitationOnlyVerdict({
        approved: false,
        feedback: 'needs more detail',
        citationFixes: [],
        unsupportedClaims: [],
      }),
    ).toBe(false);
  });

  it('returns false when unsupportedClaims is non-empty even if citationFixes is also present', () => {
    expect(
      isCitationOnlyVerdict({
        approved: false,
        feedback: 'mixed',
        citationFixes: ['swap [2] to [1]'],
        unsupportedClaims: ['invented endpoint'],
      }),
    ).toBe(false);
  });

  it('returns false for null or undefined verdict', () => {
    expect(isCitationOnlyVerdict(null)).toBe(false);
    expect(isCitationOnlyVerdict(undefined)).toBe(false);
  });
});

describe('formatVerdictSummary', () => {
  it('formats an approved verdict with feedback', () => {
    const text = formatVerdictSummary({
      approved: true,
      feedback: 'All claims grounded in supplied chunks.',
    });
    expect(text).toBe('APPROVED\nAll claims grounded in supplied chunks.');
  });

  it('formats a rejected verdict with citationFixes and unsupportedClaims sections', () => {
    const text = formatVerdictSummary({
      approved: false,
      feedback: 'One wrong citation and one ungrounded statement.',
      citationFixes: ['Swap [2] to [1] on the LDAP sync interval'],
      unsupportedClaims: ['Claim that OIM supports GraphQL natively'],
    });
    expect(text).toContain('REJECTED\nOne wrong citation and one ungrounded statement.');
    expect(text).toContain('Citation fixes:\n- Swap [2] to [1] on the LDAP sync interval');
    expect(text).toContain('Unsupported claims:\n- Claim that OIM supports GraphQL natively');
  });
});

describe('buildReviewServer', () => {
  it('creates an in-process SDK MCP server named review', () => {
    const verdicts: ReviewVerdict[] = [];
    const server = buildReviewServer((v) => verdicts.push(v));
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('review');
    expect(server.instance).toBeDefined();
  });
});
