import { describe, expect, it } from 'vitest';
import {
  COMPUTE_SERVER_NAME,
  COMPUTE_TOOL_PREFIX,
  COMPUTE_TOOLS,
  DEFAULT_TIMEOUT_MS,
  MAX_CODE_LENGTH,
  MAX_OUTPUT_LENGTH,
  MAX_TIMEOUT_MS,
  executeCode,
  formatExecuteCodeOutput,
  isComputeTool,
} from '../src/main/agent/computeTools';
import { buildComputeServer } from '../src/main/agent/computeServer';

describe('COMPUTE_TOOLS & constants', () => {
  it('exposes only mcp__compute__execute_code and expected resource bounds', () => {
    expect(COMPUTE_SERVER_NAME).toBe('compute');
    expect(COMPUTE_TOOL_PREFIX).toBe('mcp__compute__');
    expect(COMPUTE_TOOLS).toEqual(['mcp__compute__execute_code']);
    expect(MAX_CODE_LENGTH).toBe(10_000);
    expect(DEFAULT_TIMEOUT_MS).toBe(1_000);
    expect(MAX_TIMEOUT_MS).toBe(2_000);
    expect(MAX_OUTPUT_LENGTH).toBe(32_000);
  });
});

describe('isComputeTool', () => {
  it('matches execute_code and legacy compute tool names bare or MCP-prefixed (case-insensitive, trimmed)', () => {
    for (const name of [
      'execute_code',
      'EXECUTE_CODE',
      '  execute_code  ',
      'mcp__compute__execute_code',
      'mcp__compute__calculate',
      'mcp__compute__anything',
      'calculate',
      'CALCULATE',
      'statistics',
      'date_diff',
      'mcp__yvoke__execute_code',
      'mcp__yvoke__calculate',
      'mcp__yvoke__statistics',
      'mcp__yvoke__date_diff',
      'mcp__oim__calculate',
    ]) {
      expect(isComputeTool(name), `expected isComputeTool("${name}") to be true`).toBe(true);
    }
  });

  it('returns false for non-compute tools and substring lookalikes', () => {
    for (const name of [
      '',
      '   ',
      'search_corpus',
      'mcp__yvoke__search_corpus',
      'WebSearch',
      'ToolSearch',
      'Bash',
      'calculate_tax',
      'execute_code_v2',
      'my_statistics',
      'date_diff_days',
    ]) {
      expect(isComputeTool(name), `expected isComputeTool("${name}") to be false`).toBe(false);
    }
  });
});

describe('executeCode — positive evaluation', () => {
  it('evaluates arithmetic, Math.*, and BigInt expressions', () => {
    expect(executeCode('1 + 2 * 3')).toEqual({ result: '7', stdout: '' });
    expect(executeCode('(1200 * 1.19) / 12')).toEqual({ result: '119', stdout: '' });
    expect(executeCode('Math.sqrt(16) + Math.pow(2, 8)')).toEqual({ result: '260', stdout: '' });
    expect(executeCode('10n ** 20n')).toEqual({ result: '100000000000000000000n', stdout: '' });
  });

  it('evaluates statistical reductions, Date/Intl, Map/Set/Array/JSON, and special numbers', () => {
    const statsCode = `
      const vals = [2, 4, 4, 4, 5, 5, 7, 9];
      const count = vals.length;
      const sum = vals.reduce((a, b) => a + b, 0);
      const mean = sum / count;
      const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (count - 1);
      ({ count, sum, mean, stdev: Number(Math.sqrt(variance).toFixed(3)) })
    `;
    expect(JSON.parse(executeCode(statsCode).result)).toEqual({
      count: 8,
      sum: 40,
      mean: 5,
      stdev: 2.138,
    });

    const dateCode = `(new Date('2024-01-08T00:00:00Z') - new Date('2024-01-01T00:00:00Z')) / 86400000`;
    expect(executeCode(dateCode).result).toBe('7');

    const intlCode = `new Intl.NumberFormat('en-US').format(1234567)`;
    expect(executeCode(intlCode).result).toBe('1,234,567');

    const collectionsCode = `({ set: new Set([1, 2, 2]), map: new Map([['a', 10]]), re: /abc/gi, date: new Date('2024-01-01T00:00:00.000Z') })`;
    expect(JSON.parse(executeCode(collectionsCode).result)).toEqual({
      set: [1, 2],
      map: { a: 10 },
      re: '/abc/gi',
      date: '2024-01-01T00:00:00.000Z',
    });

    expect(executeCode('NaN').result).toBe('NaN');
    expect(executeCode('Infinity').result).toBe('Infinity');
    expect(executeCode('-Infinity').result).toBe('-Infinity');
    expect(executeCode('undefined').result).toBe('');
  });

  it('serializes circular object graphs safely as [Circular]', () => {
    const res = executeCode('const a = { name: "node" }; a.self = a; a;');
    expect(JSON.parse(res.result)).toEqual({ name: 'node', self: '[Circular]' });

    const arrRes = executeCode('const arr = [1]; arr.push(arr); arr;');
    expect(JSON.parse(arrRes.result)).toEqual([1, '[Circular]']);
  });

  it('supports top-level return statements including trailing single-line comments', () => {
    expect(executeCode('const a = 21;\nreturn a * 2;')).toEqual({ result: '42', stdout: '' });
    expect(executeCode('return 10 + 5; // trailing comment without newline')).toEqual({
      result: '15',
      stdout: '',
    });
  });

  it('drains Promise.resolve microtasks queued during synchronous evaluation', () => {
    const res = executeCode('let x = 0; Promise.resolve(42).then(v => { x = v; });');
    expect(res.result).toBe('');
    const res2 = executeCode(
      'Promise.resolve("microtask-done").then(v => console.log(v)); "sync-result"',
    );
    expect(res2).toEqual({ result: 'sync-result', stdout: 'microtask-done' });
  });

  it('captures console.log, console.info, console.warn, and console.error in order', () => {
    const res = executeCode(`
      console.log('line 1', 123);
      console.info('info msg');
      console.warn('warn msg');
      console.error('err msg');
      99
    `);
    expect(res.stdout).toBe('line 1 123\ninfo msg\nwarn msg\nerr msg');
    expect(res.result).toBe('99');
  });
});

describe('formatExecuteCodeOutput', () => {
  it('formats all 4 combinations of (stdout, result)', () => {
    expect(formatExecuteCodeOutput({ stdout: '', result: '42' })).toBe('42');
    expect(formatExecuteCodeOutput({ stdout: 'logged', result: '' })).toBe('logged');
    expect(formatExecuteCodeOutput({ stdout: 'logged', result: '42' })).toBe('logged\nResult: 42');
    expect(formatExecuteCodeOutput({ stdout: '', result: '' })).toBe('(no output)');
  });
});

describe('executeCode — negative, security & boundary tests (Gate 2)', () => {
  it('1. rejects empty, whitespace-only, non-string, and oversized code (> 10,000 chars)', () => {
    expect(() => executeCode('')).toThrow(/non-empty string/i);
    expect(() => executeCode('   \n\t  ')).toThrow(/non-empty string/i);
    expect(() => executeCode(null as unknown as string)).toThrow(/non-empty string/i);
    expect(() => executeCode(undefined as unknown as string)).toThrow(/non-empty string/i);
    expect(() => executeCode(123 as unknown as string)).toThrow(/non-empty string/i);
    expect(() => executeCode('1+'.repeat(5001))).toThrow(/too long/i);
  });

  it('2. throws SyntaxError on malformed JS and malformed top-level return', () => {
    expect(() => executeCode('const x = ;')).toThrow(/SyntaxError/);
    expect(() => executeCode('return (')).toThrow(/SyntaxError/);
  });

  it('3. surfaces runtime exceptions inside guest without leaking host stack frames', () => {
    expect(() => executeCode('throw new Error("boom")')).toThrow('Error: boom');
    expect(() => executeCode('throw "string error"')).toThrow('string error');
    expect(() => executeCode('throw { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" }')).toThrow(
      '{"code":"ERR_SCRIPT_EXECUTION_TIMEOUT"}',
    );
    expect(() => executeCode('({ get x() { throw new Error("getter boom"); } })')).toThrow(
      'Error: getter boom',
    );
    try {
      executeCode('throw new TypeError("bad type")');
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toBe('TypeError: bad type');
      expect(msg).not.toContain('computeTools.ts');
    }
  });

  it('4. blocks dynamic code generation (eval, new Function) and WebAssembly', () => {
    expect(() => executeCode('eval("1 + 1")')).toThrow(/EvalError|Code generation from strings disallowed/i);
    expect(() => executeCode('new Function("return 1")()')).toThrow(
      /EvalError|Code generation from strings disallowed/i,
    );
    expect(() =>
      executeCode(
        'new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))',
      ),
    ).toThrow(/CompileError|WebAssembly|Wasm code generation disallowed/i);
  });

  it('5. exposes no Node/host globals (process, require, fetch, Buffer, timers)', () => {
    const check = executeCode(`({
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch,
      Buffer: typeof Buffer,
      setTimeout: typeof setTimeout,
      setInterval: typeof setInterval,
      setImmediate: typeof setImmediate,
      queueMicrotask: typeof queueMicrotask,
    })`);
    expect(JSON.parse(check.result)).toEqual({
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      Buffer: 'undefined',
      setTimeout: 'undefined',
      setInterval: 'undefined',
      setImmediate: 'undefined',
      queueMicrotask: 'undefined',
    });
  });

  it('6. blocks prototype-chain escape attempts via ({}).constructor.constructor and console.log.constructor.constructor', () => {
    expect(() => executeCode('({}).constructor.constructor("return process")()')).toThrow(
      /EvalError|Code generation from strings disallowed/i,
    );
    expect(() => executeCode('console.log.constructor.constructor("return process")()')).toThrow(
      /EvalError|Code generation from strings disallowed/i,
    );
  });

  it('7. resists intrinsic poisoning inside user code', () => {
    const res = executeCode(`
      JSON.stringify = () => 'hacked';
      Array.prototype.push = () => {};
      Array.prototype.toJSON = () => 'hacked';
      Object.prototype.toString = () => 'hacked';
      Object.prototype.toJSON = () => 'hacked';
      Function.prototype.call = () => 'hacked';
      Error.prototype.message = 'hacked';
      console.log('clean log');
      ({ ok: true, nums: [1, 2, 3] })
    `);
    expect(res.stdout).toBe('clean log');
    expect(JSON.parse(res.result)).toEqual({ ok: true, nums: [1, 2, 3] });
  });

  it('8. terminates CPU infinite loops, microtask floods, and malicious toJSON/getter/Proxy traps via VM timeout', () => {
    expect(() => executeCode('while (true) {}', { timeoutMs: 50 })).toThrow(/timed out/i);
    expect(() =>
      executeCode('function spin() { Promise.resolve().then(spin); } spin();', { timeoutMs: 50 }),
    ).toThrow(/timed out/i);
    expect(() => executeCode('({ toJSON() { while (true) {} } })', { timeoutMs: 50 })).toThrow(
      /timed out/i,
    );
    expect(() => executeCode('({ get x() { while (true) {} } })', { timeoutMs: 50 })).toThrow(
      /timed out/i,
    );
    expect(() => executeCode('throw { get code() { while (true) {} } }', { timeoutMs: 50 })).toThrow(
      /timed out/i,
    );
    expect(() =>
      executeCode('throw new Proxy({}, { get() { while (true) {} } })', { timeoutMs: 50 }),
    ).toThrow('{}');
    expect(() =>
      executeCode('throw new Proxy({ a: 1 }, { get() { while (true) {} } })', { timeoutMs: 50 }),
    ).toThrow(/timed out/i);

    // Timeout clamping: out-of-range / NaN options do not crash and clamp into [1, MAX_TIMEOUT_MS]
    expect(executeCode('1 + 1', { timeoutMs: 99_999 }).result).toBe('2');
    expect(executeCode('1 + 1', { timeoutMs: 0 }).result).toBe('2');
    expect(executeCode('1 + 1', { timeoutMs: -50 }).result).toBe('2');
    expect(executeCode('1 + 1', { timeoutMs: Number.NaN }).result).toBe('2');
  });

  it('9. caps both console stdout flood and oversized return values at MAX_OUTPUT_LENGTH (32,000 chars)', () => {
    const consoleFlood = executeCode('for (let i = 0; i < 100; i++) console.log("x".repeat(1000)); 1');
    expect(consoleFlood.stdout).toContain('…[truncated]');
    expect(consoleFlood.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH + 20);
    expect(consoleFlood.result).toBe('1');

    const returnFlood = executeCode('"a".repeat(40000)');
    expect(returnFlood.result).toContain('…[truncated]');
    expect(returnFlood.result.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH + 20);
  });
});

describe('buildComputeServer', () => {
  type RegisteredToolEntry = {
    description?: string;
    inputSchema?: Record<string, unknown>;
    handler: (
      args: { code: string },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  };

  function getRegisteredTools() {
    const srv = buildComputeServer();
    expect(srv.name).toBe('compute');
    expect(srv.type).toBe('sdk');
    return (srv.instance as unknown as { _registeredTools: Record<string, RegisteredToolEntry> })
      ._registeredTools;
  }

  it('registers only execute_code with { code } schema (no timeoutMs) and removes legacy tools', () => {
    const tools = getRegisteredTools();
    expect(Object.keys(tools)).toEqual(['execute_code']);
    expect(tools.calculate).toBeUndefined();
    expect(tools.statistics).toBeUndefined();
    expect(tools.date_diff).toBeUndefined();

    const schema = tools.execute_code.inputSchema ?? {};
    const shape =
      'shape' in schema && typeof schema.shape === 'object' && schema.shape !== null
        ? (schema.shape as Record<string, unknown>)
        : schema;
    expect(Object.keys(shape)).toEqual(['code']);
    expect(shape).not.toHaveProperty('timeoutMs');
  });

  it('executes code and returns formatted MCP text on success and isError: true on failure', async () => {
    const tools = getRegisteredTools();
    const okRes = await tools.execute_code.handler({ code: 'console.log("step"); 6 * 7' }, {});
    expect(okRes.isError).toBeUndefined();
    expect(okRes.content).toEqual([{ type: 'text', text: 'step\nResult: 42' }]);

    const errRes = await tools.execute_code.handler({ code: 'throw new Error("bad input")' }, {});
    expect(errRes.isError).toBe(true);
    expect(errRes.content[0].type).toBe('text');
    expect(errRes.content[0].text).toMatch(/^Error:.*bad input/);
  });
});
