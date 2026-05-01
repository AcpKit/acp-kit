import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const RUN_TRACE_DIR_NAME = 'run-traces';
export const RUN_TRACE_ENV = 'SPAR_RUN_TRACE';
const DEFAULT_MAX_ENTRY_BYTES = 2_000_000;

export function sparDataDir({ home = os.homedir() } = {}) {
  return path.join(home, '.acp-kit', 'spar');
}

export function runTraceDirectory({ home = os.homedir() } = {}) {
  return path.join(sparDataDir({ home }), RUN_TRACE_DIR_NAME);
}

export function createRunTraceId({ now = Date.now, random = Math.random, pid = process.pid } = {}) {
  const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const suffix = Math.floor(random() * 0x1000000).toString(16).padStart(6, '0');
  return `${timestamp}-${pid}-${suffix}`;
}

export function runTraceFilePath({ home = os.homedir(), runTraceId = createRunTraceId() } = {}) {
  return path.join(runTraceDirectory({ home }), `${runTraceId}.jsonl`);
}

export function runTraceEnabled(env = process.env) {
  const value = String(env?.[RUN_TRACE_ENV] ?? '').trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  if (env?.VITEST && value === '') return false;
  return true;
}

export function createRunTraceRecorder({
  enabled = runTraceEnabled(),
  cwd,
  config,
  home = os.homedir(),
  runTraceId = createRunTraceId(),
  filePath = runTraceFilePath({ home, runTraceId }),
  now = Date.now,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  writeLine,
} = {}) {
  const writer = writeLine || createJsonlFileWriter({ filePath });
  let closed = false;

  function write(entry) {
    if (!enabled || closed) return;
    try {
      writer(formatRunTraceEntry(entry, { maxEntryBytes }));
    } catch {
      // Run tracing is diagnostic-only and must never affect the run.
    }
  }

  write({
    type: 'runStart',
    runTraceId,
    at: now(),
    cwd,
    pid: process.pid,
    config: summarizeConfig(config),
  });

  return {
    enabled,
    runTraceId,
    filePath,
    record(type, detail = {}) {
      write({ type, runTraceId, at: now(), ...detail });
    },
    close(detail = {}) {
      if (closed) return;
      write({
        type: 'runEnd',
        runTraceId,
        at: now(),
        ...detail,
      });
      closed = true;
    },
  };
}

function createJsonlFileWriter({ filePath }) {
  return (line) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  };
}

export function formatRunTraceEntry(entry, { maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
  const json = safeJsonStringify(entry);
  if (Buffer.byteLength(json, 'utf8') <= maxEntryBytes) return json;
  return safeJsonStringify({
    type: entry?.type || 'runTraceEntry',
    runTraceId: entry?.runTraceId,
    at: entry?.at,
    omitted: true,
    originalBytes: Buffer.byteLength(json, 'utf8'),
    reason: `run trace entry exceeded ${maxEntryBytes} bytes`,
    eventType: entry?.event?.type,
    actionType: entry?.action?.type,
  });
}

function safeJsonStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
}

function summarizeConfig(config = {}) {
  return {
    cwd: config.cwd,
    maxRounds: config.maxRounds,
    maxApprovalContinuations: config.maxApprovalContinuations,
    trace: Boolean(config.trace),
    tui: Boolean(config.tui),
    taskSource: config.taskSource,
    author: summarizeRoleSettings(config.authorSettings),
    reviewer: summarizeRoleSettings(config.reviewerSettings),
  };
}

function summarizeRoleSettings(settings = {}) {
  return {
    agent: settings.agent?.id,
    agentName: settings.agent?.displayName,
    model: settings.model ?? null,
    sessionTurns: settings.sessionTurns,
  };
}
