/**
 * In-process MCP server exposing `submit_review` (`mcp__review__submit_review`) to the reviewer
 * agent session, ported from `SubmitReviewTool.java` in `yvoke-web`.
 */
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ReviewVerdict } from '../../shared/types';
import {
  REVIEW_SERVER_NAME,
  SUBMIT_ANSWER_DESCRIPTION,
  SUBMIT_REVIEW_DESCRIPTION,
  submitAnswerCall,
  submitReviewCall,
} from './reviewTools';

/**
 * Build a per-review-turn in-process MCP server that captures the reviewer's structured verdict
 * via `onVerdict`.
 */
export function buildReviewServer(onVerdict: (verdict: ReviewVerdict) => void): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: REVIEW_SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Review verdict submission server. Call submit_review exactly once as your final action after validating the candidate answer against the supplied evidence.',
    tools: [
      tool(
        'submit_review',
        SUBMIT_REVIEW_DESCRIPTION,
        {
          approved: z
            .boolean()
            .describe('true if the answer is fully grounded in the supplied evidence.'),
          feedback: z
            .string()
            .describe('Concise reasoning; on rejection, what must be fixed.'),
          unsupported_claims: z
            .array(z.string())
            .nullable()
            .optional()
            .describe(
              'Claims with NOTHING behind them in the supplied evidence. Use this only when no supplied source supports the claim — fixing one may require new research.',
            ),
          citation_fixes: z
            .array(z.string())
            .nullable()
            .optional()
            .describe(
              "Defects repairable from the evidence already supplied: a claim attached to the wrong source, an uncited claim a supplied source does support, or a duplicated reference entry. State the repair concretely, e.g. 'swap [5] to [4] on the SAP HCM structural profile claim'. These need no new research, so listing one here rather than under unsupported_claims is what stops the orchestrator re-running a search it does not need.",
            ),
        },
        async (args): Promise<CallToolResult> => {
          const res = submitReviewCall(args, onVerdict);
          return {
            content: [{ type: 'text', text: res.text }],
            ...(res.isError ? { isError: true } : {}),
          };
        },
      ),
    ],
  });
}

/**
 * Build the in-process MCP server mounted on the Orchestrator session so the lead agent submits its
 * candidate answer via `mcp__review__submit_answer({ answer })`.
 */
export function buildSubmitAnswerServer(
  onSubmitAnswer: (answer: string) => Promise<{ text: string; isError?: boolean }>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: REVIEW_SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Candidate answer submission server. Call submit_answer with your complete Markdown answer once ready.',
    tools: [
      tool(
        'submit_answer',
        SUBMIT_ANSWER_DESCRIPTION,
        {
          answer: z
            .string()
            .describe('The complete, cited Markdown answer to deliver to the user after review.'),
        },
        async (args): Promise<CallToolResult> => {
          const res = await submitAnswerCall(args, onSubmitAnswer);
          return {
            content: [{ type: 'text', text: res.text }],
            ...(res.isError ? { isError: true } : {}),
          };
        },
      ),
    ],
  });
}
