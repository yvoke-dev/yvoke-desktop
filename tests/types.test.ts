import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_ANSWER_PREFIX,
  CLARIFICATION_WEB_SUCCESS_MESSAGE,
  DEFAULT_KB_TOOLS,
  isClarificationTool,
  MCP_PREFIX_RE,
  normalizeClarifyingInput,
  qualifyTool,
  REHYDRATED_TOOL_RESULT_PLACEHOLDER,
  clarificationAnswer,
  clarificationState,
  isValidSystemPromptName,
  type ToolCallInfo,
  type ValidSystemPromptName,
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
    it('exports expected clarification constants', () => {
      expect(CLARIFICATION_ANSWER_PREFIX).toBe('User answered: ');
      expect(CLARIFICATION_WEB_SUCCESS_MESSAGE).toBe(
        "Clarifying question asked successfully. Waiting for user's response.",
      );
    });
  });

  describe('Task 3.1: Rehydration Placeholder & Unified State Helper', () => {
    describe('REHYDRATED_TOOL_RESULT_PLACEHOLDER', () => {
      it('equals expected placeholder text', () => {
        expect(REHYDRATED_TOOL_RESULT_PLACEHOLDER).toBe('Completed (details logged locally)');
      });
    });

    describe('clarificationAnswer', () => {
      it('extracts trimmed answer from User answered: <answer>', () => {
        expect(clarificationAnswer('User answered: prod')).toBe('prod');
        expect(clarificationAnswer('User answered:  10.0 (most recent)  ')).toBe('10.0 (most recent)');
        expect(clarificationAnswer('User answered: yes')).toBe('yes');
      });

      it('extracts multi-line answer from User answered: <lines>', () => {
        expect(clarificationAnswer('User answered: Line 1\nLine 2')).toBe('Line 1\nLine 2');
        expect(clarificationAnswer('User answered: \nLine 1\nLine 2')).toBe('Line 1\nLine 2');
      });

      it('returns "Answered (response saved in history)" for web success and rehydrated placeholder', () => {
        expect(clarificationAnswer(CLARIFICATION_WEB_SUCCESS_MESSAGE)).toBe(
          'Answered (response saved in history)',
        );
        expect(clarificationAnswer(REHYDRATED_TOOL_RESULT_PLACEHOLDER)).toBe(
          'Answered (response saved in history)',
        );
      });

      it('returns undefined for empty answers, missing space, errors, and non-strings', () => {
        expect(clarificationAnswer(undefined)).toBeUndefined();
        expect(clarificationAnswer(null)).toBeUndefined();
        expect(clarificationAnswer('')).toBeUndefined();
        expect(clarificationAnswer('   ')).toBeUndefined();
        expect(clarificationAnswer(123)).toBeUndefined();
        expect(clarificationAnswer({})).toBeUndefined();
        expect(clarificationAnswer('User answered: ')).toBeUndefined();
        expect(clarificationAnswer('User answered:   ')).toBeUndefined();
        expect(clarificationAnswer('User answered:')).toBeUndefined();
        expect(clarificationAnswer('user answered: prod')).toBeUndefined();
        expect(clarificationAnswer('InputValidationError: options must have <= 4 items')).toBeUndefined();
        expect(clarificationAnswer('Error: tool execution failed')).toBeUndefined();
      });
    });

    describe('clarificationState', () => {
      it('returns "pending" when call.result === undefined', () => {
        const call: ToolCallInfo = { id: 'call-1', name: 'AskUserQuestion', input: {} };
        expect(clarificationState(call)).toBe('pending');
        expect(clarificationState({ ...call, result: undefined })).toBe('pending');
      });

      it('returns "answered" when clarificationAnswer(call.result) !== undefined', () => {
        const call1: ToolCallInfo = { id: 'call-1', name: 'AskUserQuestion', input: {}, result: 'User answered: yes' };
        expect(clarificationState(call1)).toBe('answered');

        const call2: ToolCallInfo = {
          id: 'call-2',
          name: 'ask_clarifying_question',
          input: {},
          result: REHYDRATED_TOOL_RESULT_PLACEHOLDER,
        };
        expect(clarificationState(call2)).toBe('answered');

        const call3: ToolCallInfo = {
          id: 'call-3',
          name: 'AskUserQuestion',
          input: {},
          result: CLARIFICATION_WEB_SUCCESS_MESSAGE,
        };
        expect(clarificationState(call3)).toBe('answered');
      });

      it('returns "failed" otherwise', () => {
        const call1: ToolCallInfo = {
          id: 'call-1',
          name: 'AskUserQuestion',
          input: {},
          result: 'User answered: ',
        };
        expect(clarificationState(call1)).toBe('failed');

        const call2: ToolCallInfo = {
          id: 'call-2',
          name: 'AskUserQuestion',
          input: {},
          result: 'Error: aborted',
        };
        expect(clarificationState(call2)).toBe('failed');

        const call3: ToolCallInfo = {
          id: 'call-3',
          name: 'AskUserQuestion',
          input: {},
          result: '',
        };
        expect(clarificationState(call3)).toBe('failed');
      });
    });
  });

  describe('isValidSystemPromptName', () => {
    it('accepts valid identifier and slug names', () => {
      expect(isValidSystemPromptName('default-chat')).toBe(true);
      expect(isValidSystemPromptName('custom_prompt_1')).toBe(true);
      expect(isValidSystemPromptName('oim.specialist-v1')).toBe(true);
      expect(isValidSystemPromptName('MyPrompt-123')).toBe(true);
    });

    it('rejects path traversal, separators, query/hash, spaces, and empty names', () => {
      expect(isValidSystemPromptName('')).toBe(false);
      expect(isValidSystemPromptName('   ')).toBe(false);
      expect(isValidSystemPromptName(null)).toBe(false);
      expect(isValidSystemPromptName(undefined)).toBe(false);
      expect(isValidSystemPromptName(123)).toBe(false);
      expect(isValidSystemPromptName('.')).toBe(false);
      expect(isValidSystemPromptName('.hidden')).toBe(false);
      expect(isValidSystemPromptName('trailing.')).toBe(false);
      expect(isValidSystemPromptName('../../conversations')).toBe(false);
      expect(isValidSystemPromptName('foo/bar')).toBe(false);
      expect(isValidSystemPromptName('foo\\bar')).toBe(false);
      expect(isValidSystemPromptName('prompt?query=1')).toBe(false);
      expect(isValidSystemPromptName('prompt#hash')).toBe(false);
      expect(isValidSystemPromptName('prompt with spaces')).toBe(false);
      expect(isValidSystemPromptName('  default-chat  ')).toBe(false);
      expect(isValidSystemPromptName('a'.repeat(256))).toBe(false);
    });

    it('narrows to ValidSystemPromptName on success and rejects unvalidated strings at compile time', () => {
      const candidate: string = 'custom-prompt';
      if (isValidSystemPromptName(candidate)) {
        const validated: ValidSystemPromptName = candidate;
        expect(validated).toBe('custom-prompt');
      } else {
        const stillString: string = candidate;
        expect(stillString).toBe('custom-prompt');
      }

      // @ts-expect-error Raw string must not be assignable to ValidSystemPromptName without runtime validation
      const rawPrompt: ValidSystemPromptName = 'unvalidated-raw-string';
      expect(rawPrompt).toBe('unvalidated-raw-string');
    });
  });
});

