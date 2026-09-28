import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_ANSWER_PREFIX,
  CLARIFICATION_WEB_SUCCESS_MESSAGE,
  DEFAULT_KB_TOOLS,
  hasValidClarificationAnswer,
  isClarificationTool,
  MCP_PREFIX_RE,
  normalizeClarifyingInput,
  qualifyTool,
} from '../src/shared/types';

describe('Task 1.1: Shared Contracts & Fail-Safe Normalization', () => {
  describe('DEFAULT_KB_TOOLS & BUILTIN_TOOLS', () => {
    it('includes ask_clarifying_question in DEFAULT_KB_TOOLS', () => {
      expect(DEFAULT_KB_TOOLS).toContain('ask_clarifying_question');
    });

    it('leaves AskUserQuestion unprefixed as a builtin tool', () => {
      expect(qualifyTool('AskUserQuestion')).toBe('AskUserQuestion');
      expect(qualifyTool('askuserquestion')).toBe('AskUserQuestion');
    });
  });

  describe('isClarificationTool', () => {
    it('returns true for bare and MCP-prefixed clarification tools', () => {
      expect(isClarificationTool('ask_clarifying_question')).toBe(true);
      expect(isClarificationTool('AskUserQuestion')).toBe(true);
      expect(isClarificationTool('mcp__yvoke__ask_clarifying_question')).toBe(true);
      expect(isClarificationTool('mcp__oim__AskUserQuestion')).toBe(true);
      expect(isClarificationTool('mcp__custom_server__ask_clarifying_question')).toBe(true);
    });

    it('returns false for tools with suffixes or non-clarification tools', () => {
      expect(isClarificationTool('ask_clarifying_question_v2')).toBe(false);
      expect(isClarificationTool('AskUserQuestionExtra')).toBe(false);
      expect(isClarificationTool('search_corpus')).toBe(false);
      expect(isClarificationTool('WebSearch')).toBe(false);
      expect(isClarificationTool('')).toBe(false);
      expect(isClarificationTool('clarifying_question')).toBe(false);
    });
  });

  describe('normalizeClarifyingInput', () => {
    it('handles primitives by returning empty question and options', () => {
      expect(normalizeClarifyingInput(null)).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput(undefined)).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput('')).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput('hello')).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput(42)).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput(true)).toEqual({ question: '', options: [] });
    });

    it('handles flat input with string options', () => {
      const input = {
        question: 'Which environment?',
        options: ['dev', 'prod'],
      };
      expect(normalizeClarifyingInput(input)).toEqual({
        question: 'Which environment?',
        options: [{ label: 'dev' }, { label: 'prod' }],
      });
    });

    it('handles CLI nested input with object options', () => {
      const input = {
        questions: [
          {
            question: 'Which version?',
            options: [
              { label: '9.3.1', description: 'Major release 9' },
              { label: '10.0', description: 'Major release 10' },
            ],
          },
        ],
      };
      expect(normalizeClarifyingInput(input)).toEqual({
        question: 'Which version?',
        options: [
          { label: '9.3.1', description: 'Major release 9' },
          { label: '10.0', description: 'Major release 10' },
        ],
      });
    });

    it('sanitizes options: strips whitespace, prunes empty/null/undefined labels', () => {
      const input = {
        question: 'Select an option',
        options: [
          '  valid string  ',
          '',
          '   ',
          null,
          undefined,
          123,
          { label: '  valid object  ', description: '  some desc  ' },
          { label: 'no desc', description: '   ' },
          { label: '   ', description: 'empty label' },
          { description: 'missing label' },
          null,
        ],
      };
      expect(normalizeClarifyingInput(input)).toEqual({
        question: 'Select an option',
        options: [
          { label: 'valid string' },
          { label: 'valid object', description: 'some desc' },
          { label: 'no desc' },
        ],
      });
    });

    it('extracts preview when present on an option object', () => {
      const input = {
        question: 'Select an approach',
        options: [
          { label: 'Option A', description: 'Desc A', preview: 'const a = 1;' },
          { label: 'Option B', preview: '  const b = 2;  ' },
          { label: 'Option C', preview: '   ' },
          { label: 'Option D' },
        ],
      };
      expect(normalizeClarifyingInput(input)).toEqual({
        question: 'Select an approach',
        options: [
          { label: 'Option A', description: 'Desc A', preview: 'const a = 1;' },
          { label: 'Option B', preview: 'const b = 2;' },
          { label: 'Option C' },
          { label: 'Option D' },
        ],
      });
    });

    it('handles empty objects and malformed nested structures', () => {
      expect(normalizeClarifyingInput({})).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput({ questions: [] })).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput({ questions: [null] })).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput({ questions: [{}] })).toEqual({ question: '', options: [] });
    });

    it('handles header without question without producing literal undefined', () => {
      const input = {
        questions: [
          {
            header: 'Title',
          },
        ],
      };
      const result = normalizeClarifyingInput(input);
      expect(result.question).toBe('### Title');
      expect(result.question).not.toContain('undefined');
      expect(result.options).toEqual([]);
    });

    it('aggregates multiple questions and their options from CLI questions array', () => {
      const input = {
        questions: [
          {
            header: 'Environment',
            question: 'Which environment should be deployed to?',
            options: [
              { label: 'dev', description: 'Development' },
              { label: 'staging', description: 'Staging' },
            ],
          },
          {
            header: 'Confirmation',
            question: 'Proceed with migration?',
            options: [
              { label: 'yes', description: 'Run migration now' },
              { label: 'no', description: 'Abort' },
            ],
          },
        ],
      };
      expect(normalizeClarifyingInput(input)).toEqual({
        question:
          '### Environment\nWhich environment should be deployed to?\n\n### Confirmation\nProceed with migration?',
        options: [
          { label: 'dev', description: 'Environment: Development' },
          { label: 'staging', description: 'Environment: Staging' },
          { label: 'yes', description: 'Confirmation: Run migration now' },
          { label: 'no', description: 'Confirmation: Abort' },
        ],
      });
    });

    it('associates options with question header when questions.length > 1', () => {
      const input = {
        questions: [
          {
            header: 'Target',
            options: [
              { label: 'local' },
              { label: 'remote', description: 'Target: Already prefixed' },
              { label: 'cloud', description: 'AWS env' },
            ],
          },
          {
            header: 'Dry run',
            options: [
              { label: 'yes' },
            ],
          },
        ],
      };
      expect(normalizeClarifyingInput(input)).toEqual({
        question: '### Target\n\n### Dry run',
        options: [
          { label: 'local', description: 'Target' },
          { label: 'remote', description: 'Target: Already prefixed' },
          { label: 'cloud', description: 'Target: AWS env' },
          { label: 'yes', description: 'Dry run' },
        ],
      });
    });

    it('does not prepend header to options when questions.length === 1', () => {
      const input = {
        questions: [
          {
            header: 'Target',
            question: 'Pick a target',
            options: [
              { label: 'local', description: 'Local machine' },
              { label: 'remote' },
            ],
          },
        ],
      };
      expect(normalizeClarifyingInput(input)).toEqual({
        question: '### Target\nPick a target',
        options: [
          { label: 'local', description: 'Local machine' },
          { label: 'remote' },
        ],
      });
    });

    it('qualifyTool and isClarificationTool both handle server names with underscores consistently', () => {
      expect(MCP_PREFIX_RE.test('mcp__custom_server__tool')).toBe(true);
      expect(isClarificationTool('mcp__custom_server__ask_clarifying_question')).toBe(true);
      expect(isClarificationTool('mcp__custom_server__AskUserQuestion')).toBe(true);
      expect(qualifyTool('mcp__custom_server__search_corpus')).toBe('mcp__yvoke__search_corpus');
      expect(qualifyTool('mcp__custom_server__AskUserQuestion')).toBe('AskUserQuestion');
    });
  });

  describe('Task 1.1: hasValidClarificationAnswer', () => {
    it('exports expected constants', () => {
      expect(CLARIFICATION_ANSWER_PREFIX).toBe('User answered: ');
      expect(CLARIFICATION_WEB_SUCCESS_MESSAGE).toBe(
        "Clarifying question asked successfully. Waiting for user's response.",
      );
    });

    describe('Negative & Boundary Tests', () => {
      it('returns false for undefined, null, empty string, and whitespace-only strings', () => {
        expect(hasValidClarificationAnswer(undefined)).toBe(false);
        expect(hasValidClarificationAnswer(null)).toBe(false);
        expect(hasValidClarificationAnswer('')).toBe(false);
        expect(hasValidClarificationAnswer('   ')).toBe(false);
        expect(hasValidClarificationAnswer('\t\n ')).toBe(false);
      });

      it('returns false for runtime non-strings', () => {
        expect(hasValidClarificationAnswer(123 as unknown as string)).toBe(false);
        expect(hasValidClarificationAnswer({} as unknown as string)).toBe(false);
        expect(hasValidClarificationAnswer(true as unknown as string)).toBe(false);
        expect(hasValidClarificationAnswer(['User answered: prod'] as unknown as string)).toBe(false);
      });

      it('returns false for cancelled clarifications with empty answer prefix', () => {
        expect(hasValidClarificationAnswer('User answered: ')).toBe(false);
        expect(hasValidClarificationAnswer('User answered:   ')).toBe(false);
        expect(hasValidClarificationAnswer('User answered: \n \t ')).toBe(false);
      });

      it('returns false for partial / missing whitespace prefixes', () => {
        expect(hasValidClarificationAnswer('User answered:')).toBe(false);
        expect(hasValidClarificationAnswer('User answered')).toBe(false);
        expect(hasValidClarificationAnswer('user answered: prod')).toBe(false);
      });

      it('returns false for CLI validation errors and tool crashes', () => {
        expect(hasValidClarificationAnswer('InputValidationError: options must have <= 4 items')).toBe(false);
        expect(hasValidClarificationAnswer('Error: tool execution failed')).toBe(false);
        expect(hasValidClarificationAnswer('TypeError: Cannot read properties of undefined')).toBe(false);
      });

      it('returns false for policy refusal messages', () => {
        expect(hasValidClarificationAnswer('Clarifying questions cannot be asked in this execution context.')).toBe(false);
      });

      it('returns false for arbitrary non-matching prefixes', () => {
        expect(hasValidClarificationAnswer('Answer: prod')).toBe(false);
        expect(hasValidClarificationAnswer('Response: dev')).toBe(false);
        expect(hasValidClarificationAnswer('User response: prod')).toBe(false);
      });
    });

    describe('Positive Tests', () => {
      it('returns true for valid answers', () => {
        expect(hasValidClarificationAnswer('User answered: prod')).toBe(true);
        expect(hasValidClarificationAnswer('User answered: 10.0 (most recent)')).toBe(true);
        expect(hasValidClarificationAnswer('User answered: yes')).toBe(true);
      });

      it('returns true for valid multi-line answers', () => {
        expect(hasValidClarificationAnswer('User answered:\nLine 1\nLine 2')).toBe(true);
        expect(hasValidClarificationAnswer('User answered: \nLine 1\nLine 2')).toBe(true);
      });

      it('returns true for exact web success message', () => {
        expect(
          hasValidClarificationAnswer("Clarifying question asked successfully. Waiting for user's response."),
        ).toBe(true);
      });
    });
  });
});

