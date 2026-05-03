import type { McpServer } from '@agentclientprotocol/sdk';

import type { AcpRuntime, LoadSessionOptions, NewSessionOptions } from './runtime.js';
import type { RuntimeSession } from './session.js';

export interface OpenOrCreateRuntimeSessionOptions {
  runtime: Pick<AcpRuntime, 'newSession' | 'loadSession'>;
  sessionId?: string | null;
  cwd?: string;
  mcpServers?: McpServer[];
  /** Defaults to true. When false, loadSession failures are always rethrown. */
  fallbackOnMissing?: boolean;
  onStatus?: (message: string) => void;
}

export interface OpenOrCreateRuntimeSessionResult {
  session: RuntimeSession;
  resumed: boolean;
  requestedSessionId: string | null;
}

/**
 * Resume a saved ACP session when possible, falling back to a fresh session only
 * when the saved id is clearly stale or missing. Transport, timeout, auth, and
 * service failures are rethrown so callers do not silently discard live recovery.
 */
export async function openOrCreateRuntimeSession(
  options: OpenOrCreateRuntimeSessionOptions,
): Promise<OpenOrCreateRuntimeSessionResult> {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  const requestedSessionId = sessionId || null;
  const newSessionOptions = sessionOptions({ cwd: options.cwd, mcpServers: options.mcpServers });
  if (!sessionId) {
    return {
      session: await options.runtime.newSession(newSessionOptions),
      resumed: false,
      requestedSessionId,
    };
  }

  options.onStatus?.(`resuming saved session ${sessionId}...`);
  try {
    const loadOptions: LoadSessionOptions = {
      ...newSessionOptions,
      sessionId,
    };
    return {
      session: await options.runtime.loadSession(loadOptions),
      resumed: true,
      requestedSessionId,
    };
  } catch (error) {
    if (options.fallbackOnMissing === false || !isMissingAcpSessionError(error)) throw error;
    options.onStatus?.('saved session unavailable, starting fresh...');
    return {
      session: await options.runtime.newSession(newSessionOptions),
      resumed: false,
      requestedSessionId,
    };
  }
}

export function isMissingAcpSessionError(error: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 4) return false;
  if (typeof error === 'string') return hasMissingSessionMessage(error);
  if (!error || (typeof error !== 'object' && !(error instanceof Error))) return false;
  if (typeof error === 'object') {
    if (seen.has(error)) return false;
    seen.add(error);
  }

  const status = readNumericField(error, 'status', 'statusCode');
  if (status === 404) return true;

  const code = readStringField(error, 'code', 'errorCode');
  if (code && /^(?:ENOENT|404|NOT_?FOUND|SESSION_NOT_FOUND)$/i.test(code)) return true;

  const message = error instanceof Error ? error.message : readStringField(error, 'message', 'error', 'reason', 'detail', 'details', 'text');
  if (hasMissingSessionMessage(message)) return true;

  const cause = error instanceof Error
    ? error.cause
    : readNestedField(error, 'cause', 'error', 'reason', 'detail', 'details');
  return isMissingAcpSessionError(cause, depth + 1, seen);
}

function sessionOptions(options: { cwd?: string; mcpServers?: McpServer[] }): NewSessionOptions {
  return {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
  };
}

function hasMissingSessionMessage(message: unknown): boolean {
  return typeof message === 'string'
    && /\b(?:session\s+not\s+found|unknown\s+session|no\s+such\s+session|cannot\s+find\s+session|saved\s+session\s+unavailable)\b/i.test(message);
}

function readNumericField(value: unknown, ...keys: string[]): number | null {
  for (const key of keys) {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)) {
      const number = Number((value as Record<string, unknown>)[key]);
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function readStringField(value: unknown, ...keys: string[]): string {
  for (const key of keys) {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)) {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field === 'string' && field.trim()) return field;
    }
  }
  return '';
}

function readNestedField(value: unknown, ...keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return (value as Record<string, unknown>)[key];
  }
  return undefined;
}
