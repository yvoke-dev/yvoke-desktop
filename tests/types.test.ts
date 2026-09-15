import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KB_TOOLS,
  isClarificationTool,
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

    it('handles empty objects and malformed nested structures', () => {
      expect(normalizeClarifyingInput({})).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput({ questions: [] })).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput({ questions: [null] })).toEqual({ question: '', options: [] });
      expect(normalizeClarifyingInput({ questions: [{}] })).toEqual({ question: '', options: [] });
    });
  });
});
