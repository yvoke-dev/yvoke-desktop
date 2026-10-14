/**
 * Sandboxed in-process JavaScript computation helper exposed to the model as the
 * `mcp__compute__execute_code` MCP tool (wired up in computeServer.ts).
 *
 * Runs strictly inside a zero-privilege `node:vm` context with no shell, filesystem,
 * network, timers, dynamic code generation (`eval` / `Function`), or WebAssembly.
 * This module deliberately does NOT import the Agent SDK so the permission layer and
 * unit tests stay lightweight.
 */
import { types as utilTypes } from 'node:util';
import { promiseHooks } from 'node:v8';
import vm from 'node:vm';
import { MCP_PREFIX_RE } from '../../shared/types';

export const COMPUTE_SERVER_NAME = 'compute';
export const COMPUTE_TOOL_PREFIX = `mcp__${COMPUTE_SERVER_NAME}__`;

/** Fully-qualified tool names, exactly as the model and the permission allow-list see them. */
export const COMPUTE_TOOLS = [`${COMPUTE_TOOL_PREFIX}execute_code`] as const;

export const MAX_CODE_LENGTH = 10_000;
export const DEFAULT_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 2_000;
export const MAX_OUTPUT_LENGTH = 32_000;

const KNOWN_COMPUTE_BARE_NAMES = new Set([
  'execute_code',
  'calculate',
  'statistics',
  'date_diff',
]);

/**
 * Whether `tool` names the current or any legacy in-process compute tool, either bare
 * (`execute_code`, `calculate`, `statistics`, `date_diff`) or MCP-qualified under any
 * server alias (`mcp__compute__*`, `mcp__yvoke__calculate`, `mcp__oim__calculate`).
 */
export function isComputeTool(tool: string): boolean {
  if (typeof tool !== 'string') return false;
  const trimmed = tool.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(COMPUTE_TOOL_PREFIX)) return true;
  const bare = lower.replace(MCP_PREFIX_RE, '').trim();
  return KNOWN_COMPUTE_BARE_NAMES.has(bare);
}

export interface ExecuteCodeOptions {
  timeoutMs?: number;
}

export interface ExecuteCodeResult {
  result: string;
  stdout: string;
}

interface BootstrapHooks {
  recordOutcome: (ok: boolean, val: unknown) => void;
  trackPromise: (promise: unknown, parent: unknown) => void;
}

const SILENCE_TIMEOUT_MS = 50;

const bootstrapScript = new vm.Script(
  `(function () {
    "use strict";
    const MAX_OUT = ${MAX_OUTPUT_LENGTH};
    const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);
    const jsonStringify = JSON.stringify;
    const StringCtor = String;
    const ErrorCtor = Error;
    const isArray = Array.isArray;
    const objectKeys = Object.keys;
    const objectCreate = Object.create;
    const getPrototypeOf = Object.getPrototypeOf;
    const setPrototypeOf = Object.setPrototypeOf;
    const defineProperty = Object.defineProperty;
    const hasOwn = uncurryThis(Object.prototype.hasOwnProperty);
    const SetCtor = Set;
    const setHas = uncurryThis(Set.prototype.has);
    const setAdd = uncurryThis(Set.prototype.add);
    const setDelete = uncurryThis(Set.prototype.delete);
    const setClear = uncurryThis(Set.prototype.clear);
    const setForEach = uncurryThis(Set.prototype.forEach);
    const MapCtor = Map;
    const mapForEach = uncurryThis(Map.prototype.forEach);
    const DateCtor = Date;
    const dateToISOString = uncurryThis(Date.prototype.toISOString);
    const dateGetTime = uncurryThis(Date.prototype.getTime);
    const RegExpCtor = RegExp;
    const regExpToString = uncurryThis(RegExp.prototype.toString);
    const PromiseCtor = Promise;
    const PromisePrototype = PromiseCtor.prototype;
    const promiseThen = uncurryThis(PromisePrototype.then);
    const isNaN = Number.isNaN;
    const isFinite = Number.isFinite;
    const strSlice = uncurryThis(String.prototype.slice);

    defineProperty(PromisePrototype, "constructor", {
      value: PromiseCtor,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    defineProperty(PromiseCtor, Symbol.species, {
      value: PromiseCtor,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    let stdout = "";
    let stdoutTruncated = false;
    let caughtInVm = false;
    let outcomeOk = true;
    let outcomeVal = undefined;
    const allPromises = new SetCtor();
    const leafPromises = new SetCtor();
    const noop = function () {};

    function truncate(str) {
      if (str.length <= MAX_OUT) return str;
      return strSlice(str, 0, MAX_OUT) + "…[truncated]";
    }

    function toSerializable(v, seen) {
      if (v === null || typeof v === "boolean" || typeof v === "string") return v;
      if (typeof v === "number") {
        if (isNaN(v)) return "NaN";
        if (!isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
        return v;
      }
      if (typeof v === "bigint") return StringCtor(v) + "n";
      if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol") {
        return StringCtor(v);
      }
      if (typeof v === "object") {
        if (setHas(allPromises, v)) {
          return "[Promise]";
        }
        if (v instanceof DateCtor) {
          const t = dateGetTime(v);
          return isNaN(t) ? "Invalid Date" : dateToISOString(v);
        }
        if (v instanceof RegExpCtor) {
          return regExpToString(v);
        }
        if (v instanceof ErrorCtor) {
          const eName =
            hasOwn(v, "name") && typeof v.name === "string"
              ? v.name
              : v.constructor && typeof v.constructor.name === "string"
                ? v.constructor.name
                : "Error";
          const eMsg =
            hasOwn(v, "message") && typeof v.message === "string" ? v.message : "";
          return eMsg ? eName + ": " + eMsg : eName;
        }
        if (setHas(seen, v)) return "[Circular]";
        if (hasOwn(v, "toJSON") && typeof v.toJSON === "function") {
          setAdd(seen, v);
          const jsonVal = v.toJSON();
          const res = toSerializable(jsonVal, seen);
          setDelete(seen, v);
          return res;
        }
        if (v instanceof SetCtor) {
          setAdd(seen, v);
          const out = [];
          setPrototypeOf(out, null);
          let idx = 0;
          setForEach(v, function (item) {
            out[idx++] = toSerializable(item, seen);
          });
          setDelete(seen, v);
          return out;
        }
        if (v instanceof MapCtor) {
          setAdd(seen, v);
          const obj = objectCreate(null);
          mapForEach(v, function (val, key) {
            obj[StringCtor(key)] = toSerializable(val, seen);
          });
          setDelete(seen, v);
          return obj;
        }
        if (isArray(v)) {
          setAdd(seen, v);
          const out = [];
          setPrototypeOf(out, null);
          for (let i = 0; i < v.length; i++) {
            out[i] = toSerializable(v[i], seen);
          }
          setDelete(seen, v);
          return out;
        }
        setAdd(seen, v);
        const out = objectCreate(null);
        const keys = objectKeys(v);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          out[k] = toSerializable(v[k], seen);
        }
        setDelete(seen, v);
        return out;
      }
      return StringCtor(v);
    }

    function formatValue(v) {
      if (v === undefined) return "";
      if (typeof v === "string") return truncate(v);
      if (typeof v === "number") {
        if (isNaN(v)) return "NaN";
        if (!isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
        return StringCtor(v);
      }
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "bigint") return StringCtor(v) + "n";
      if (typeof v === "symbol" || typeof v === "function") return truncate(StringCtor(v));
      if (v === null) return "null";
      const serialized = jsonStringify(toSerializable(v, new SetCtor()));
      return truncate(typeof serialized === "string" ? serialized : StringCtor(v));
    }

    function formatError(err) {
      if (err !== null && typeof err === "object") {
        if (err instanceof ErrorCtor || hasOwn(err, "message") || hasOwn(err, "name")) {
          const eName =
            hasOwn(err, "name") && typeof err.name === "string"
              ? err.name
              : err.constructor && typeof err.constructor.name === "string"
                ? err.constructor.name
                : "Error";
          const eMsg =
            hasOwn(err, "message") && typeof err.message === "string" ? err.message : "";
          return truncate(eMsg ? eName + ": " + eMsg : eName);
        }
        return formatValue(err);
      }
      return truncate(StringCtor(err));
    }

    defineProperty(ErrorCtor, "prepareStackTrace", {
      value: function (err) {
        return formatError(err);
      },
      writable: false,
      enumerable: false,
      configurable: false,
    });

    function writeConsole() {
      if (stdoutTruncated) return;
      let line = "";
      for (let i = 0; i < arguments.length; i++) {
        const part = typeof arguments[i] === "string" ? arguments[i] : formatValue(arguments[i]);
        line = i === 0 ? part : line + " " + part;
      }
      const next = stdout.length === 0 ? line : stdout + "\\n" + line;
      if (next.length > MAX_OUT) {
        stdout = strSlice(next, 0, MAX_OUT) + "…[truncated]";
        stdoutTruncated = true;
      } else {
        stdout = next;
      }
    }

    globalThis.console = {
      log: writeConsole,
      info: writeConsole,
      warn: writeConsole,
      error: writeConsole,
    };

    function trackPromise(p, parent) {
      if (parent !== undefined) {
        setDelete(leafPromises, parent);
      }
      if (p !== undefined) {
        setAdd(allPromises, p);
        setAdd(leafPromises, p);
      }
    }

    function safePromiseThen(p, onFulfilled, onRejected) {
      try {
        if (getPrototypeOf(p) !== PromisePrototype) {
          setPrototypeOf(p, PromisePrototype);
        }
        if (hasOwn(p, "constructor")) {
          delete p.constructor;
        }
        promiseThen(p, onFulfilled, onRejected);
      } catch {
        // Ignore if guest froze a promise after tampering with its prototype or own constructor.
      }
    }

    function silenceLeaves() {
      const snapshot = new SetCtor();
      setForEach(leafPromises, function (leaf) {
        setAdd(snapshot, leaf);
      });
      setClear(leafPromises);
      setForEach(snapshot, function (leaf) {
        safePromiseThen(leaf, undefined, noop);
      });
    }

    function catchOutcome(err) {
      caughtInVm = true;
      outcomeOk = false;
      outcomeVal = err;
    }

    function recordOutcome(ok, val) {
      if (caughtInVm) return;
      outcomeOk = ok;
      outcomeVal = val;
    }

    function settleOutcome() {
      const snapshot = new SetCtor();
      setForEach(leafPromises, function (leaf) {
        setAdd(snapshot, leaf);
      });
      setClear(leafPromises);
      if (outcomeOk && setHas(allPromises, outcomeVal)) {
        const p = outcomeVal;
        setDelete(snapshot, p);
        outcomeVal = undefined;
        safePromiseThen(
          p,
          function (res) {
            outcomeVal = res;
          },
          function (err) {
            outcomeOk = false;
            outcomeVal = err;
          },
        );
      }
      setForEach(snapshot, function (leaf) {
        safePromiseThen(
          leaf,
          undefined,
          function (err) {
            if (outcomeOk) {
              outcomeOk = false;
              outcomeVal = err;
            }
          },
        );
      });
    }

    function makeEnvelope(ok, resultOrError, out) {
      const env = objectCreate(null);
      env.ok = ok;
      if (ok) {
        env.result = resultOrError;
      } else {
        env.error = resultOrError;
      }
      env.stdout = out;
      return jsonStringify(env);
    }

    function finalize() {
      if (!outcomeOk) {
        try {
          return makeEnvelope(false, formatError(outcomeVal), stdout);
        } catch (serErr) {
          try {
            return makeEnvelope(false, formatError(serErr), stdout);
          } catch {
            return makeEnvelope(false, "Error: Unserializable guest exception", stdout);
          }
        }
      }
      try {
        return makeEnvelope(true, formatValue(outcomeVal), stdout);
      } catch (serErr) {
        try {
          return makeEnvelope(false, formatError(serErr), stdout);
        } catch {
          return makeEnvelope(false, "Error: Unserializable guest exception", stdout);
        }
      }
    }

    defineProperty(globalThis, "__yvoke_catch__", {
      value: catchOutcome,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    defineProperty(globalThis, "__yvoke_settle__", {
      value: settleOutcome,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    defineProperty(globalThis, "__yvoke_silence__", {
      value: silenceLeaves,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    defineProperty(globalThis, "__yvoke_finalize__", {
      value: finalize,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    return { recordOutcome, trackPromise };
  })()`,
  { filename: 'bootstrap.js' },
);

const settleScript = new vm.Script('globalThis.__yvoke_settle__()', {
  filename: 'settle.js',
});

const silenceScript = new vm.Script('globalThis.__yvoke_silence__()', {
  filename: 'silence.js',
});

const finalizeScript = new vm.Script('globalThis.__yvoke_finalize__()', {
  filename: 'finalize.js',
});

function runSilence(context: vm.Context): void {
  try {
    silenceScript.runInContext(context, {
      timeout: SILENCE_TIMEOUT_MS,
      breakOnSigint: false,
    });
  } catch {
    // Best-effort cleanup under V8 Watchdog timeout.
  }
}

function compileUserScript(code: string): vm.Script {
  let executableCode = code;
  try {
    new vm.Script(code, { filename: 'execute_code.js' });
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && /Illegal return statement/i.test(firstErr.message)) {
      const wrappedIife = `(function () {\n"use strict";\n${code}\n})()`;
      try {
        new vm.Script(wrappedIife, { filename: 'execute_code.js' });
        executableCode = wrappedIife;
      } catch {
        throw new SyntaxError(`SyntaxError: ${firstErr.message}`);
      }
    } else if (firstErr instanceof SyntaxError) {
      throw new SyntaxError(`SyntaxError: ${firstErr.message}`);
    } else {
      throw firstErr;
    }
  }

  // Wrap in an in-VM try/catch after syntax validation so thrown guest objects/Proxies are caught
  // inside V8 before runInContext exits — preventing Node's C++ DecorateErrorStack from inspecting
  // properties on a malicious Proxy after the V8 Watchdog timer has already been destroyed.
  return new vm.Script(
    `try {\n${executableCode}\n} catch (__yvoke_err__) {\n  __yvoke_catch__(__yvoke_err__);\n}`,
    { filename: 'execute_code.js' },
  );
}

function isVmTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (utilTypes.isProxy(err) || !utilTypes.isNativeError(err)) return false;
  const codeDesc = Object.getOwnPropertyDescriptor(err, 'code');
  if (codeDesc && 'value' in codeDesc && codeDesc.value === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    return true;
  }
  const msgDesc = Object.getOwnPropertyDescriptor(err, 'message');
  return (
    msgDesc !== undefined &&
    'value' in msgDesc &&
    typeof msgDesc.value === 'string' &&
    /Script execution timed out/i.test(msgDesc.value)
  );
}

/**
 * Execute a JavaScript snippet inside a fresh, zero-privilege `node:vm` context.
 * All value and error serialization occurs inside the timed VM context before
 * returning a primitive JSON string across the realm boundary.
 */
export function executeCode(code: string, options?: ExecuteCodeOptions): ExecuteCodeResult {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error('Code must be a non-empty string');
  }
  if (code.length > MAX_CODE_LENGTH) {
    throw new Error(`Code too long (max ${MAX_CODE_LENGTH} characters)`);
  }

  const rawTimeout =
    options?.timeoutMs !== undefined &&
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(rawTimeout)));

  const userScript = compileUserScript(code);

  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });

  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  const hooks = bootstrapScript.runInContext(context, {
    timeout: timeoutMs,
    breakOnSigint: false,
  }) as BootstrapHooks;

  const stopPromiseHook = promiseHooks.createHook({
    init(promise, parent) {
      hooks.trackPromise(promise, parent);
    },
  });
  try {
    const val = userScript.runInContext(context, {
      timeout: remaining(),
      breakOnSigint: false,
    });
    hooks.recordOutcome(true, val);
  } catch (err) {
    if (isVmTimeoutError(err)) {
      runSilence(context);
      throw new Error(`Execution timed out after ${timeoutMs}ms`);
    }
    hooks.recordOutcome(false, err);
  } finally {
    stopPromiseHook();
  }

  let raw: unknown;
  try {
    settleScript.runInContext(context, {
      timeout: remaining(),
      breakOnSigint: false,
    });
    raw = finalizeScript.runInContext(context, {
      timeout: remaining(),
      breakOnSigint: false,
    });
  } catch (err) {
    runSilence(context);
    if (isVmTimeoutError(err)) {
      throw new Error(`Execution timed out after ${timeoutMs}ms`);
    }
    throw new Error('Failed to serialize execution result');
  }

  if (typeof raw !== 'string') {
    throw new Error('Unexpected non-string result from sandbox serializer');
  }

  const parsed = JSON.parse(raw) as
    | { ok: true; result: string; stdout: string }
    | { ok: false; error: string; stdout: string };

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  return {
    result: parsed.result,
    stdout: parsed.stdout,
  };
}

/** Format the `{ result, stdout }` pair returned by `executeCode` for the MCP tool response. */
export function formatExecuteCodeOutput(res: ExecuteCodeResult): string {
  const hasStdout = res.stdout.length > 0;
  const hasResult = res.result.length > 0;
  if (hasStdout && hasResult) {
    return `${res.stdout}\nResult: ${res.result}`;
  }
  if (hasStdout) {
    return res.stdout;
  }
  if (hasResult) {
    return res.result;
  }
  return '(no output)';
}
