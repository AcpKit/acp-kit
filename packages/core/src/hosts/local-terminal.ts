import { spawn, type ChildProcess } from 'node:child_process';

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

import type { RuntimeHost } from '../host.js';

export interface LocalTerminalHostOptions {
  /**
   * Resolve the agent-supplied `cwd` (which can be relative, absolute, or omitted)
   * into an absolute filesystem path. Implement your own sandbox/root check here.
   *
   * Defaults to requiring an absolute path.
   */
  resolveCwd?: (cwd: string | undefined) => string;
  /** Extra env vars merged on top of `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Maximum number of bytes of combined stdout+stderr kept in memory per
   * terminal. Older bytes are dropped (FIFO). Defaults to 1 MiB. The
   * agent-supplied `outputByteLimit` overrides this per call.
   */
  defaultOutputByteLimit?: number;
}

export type LocalTerminalHost = Required<Pick<
  RuntimeHost,
  'createTerminal' | 'terminalOutput' | 'waitForTerminalExit' | 'killTerminal' | 'releaseTerminal'
>> & {
  /**
   * Live map of terminalId → child process. Useful for forced cleanup on
   * session teardown (e.g. iterate and `kill` every entry). Not part of the
   * ACP `RuntimeHost` contract — exposed as an escape hatch.
   */
  readonly terminals: ReadonlyMap<string, ChildProcess>;
};

interface TerminalRecord {
  process: ChildProcess;
  buffer: Buffer[];
  bufferBytes: number;
  byteLimit: number;
  truncated: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exited: boolean;
  exitPromise: Promise<void>;
}

/**
 * Build a `RuntimeHost` partial implementing ACP's terminal capability against
 * the local OS via `node:child_process.spawn`.
 *
 * - Accumulates stdout/stderr in a bounded ring buffer (`outputByteLimit`).
 * - `releaseTerminal` releases host-side bookkeeping but does NOT kill the
 *   process — call `killTerminal` first if you want it gone (matches ACP spec).
 * - `waitForTerminalExit` honours the request `timeout` and resolves with the
 *   last known exit code (`-1` if still running at timeout).
 *
 * Compose with your own permission/fs handlers; this helper has no opinions
 * about authorization. If you need a sandboxed cwd, supply `resolveCwd`.
 *
 * Not appropriate when:
 * - Your host has its own terminal UI (e.g. VS Code) — use that API instead so
 *   the user can interact with the terminal.
 * - You need to run commands inside a container/jail — wrap your own spawner.
 */
export function createLocalTerminalHost(options: LocalTerminalHostOptions = {}): LocalTerminalHost {
  const defaultLimit = options.defaultOutputByteLimit ?? 1024 * 1024;
  const env = { ...process.env, ...(options.env || {}) };
  const resolveCwd = options.resolveCwd ?? defaultResolveCwd;

  const terminals = new Map<string, TerminalRecord>();
  let nextId = 1;

  const appendOutput = (record: TerminalRecord, chunk: Buffer): void => {
    record.buffer.push(chunk);
    record.bufferBytes += chunk.length;
    while (record.bufferBytes > record.byteLimit && record.buffer.length > 0) {
      const oldest = record.buffer[0]!;
      const overflow = record.bufferBytes - record.byteLimit;
      if (oldest.length <= overflow) {
        record.buffer.shift();
        record.bufferBytes -= oldest.length;
        record.truncated = true;
      } else {
        record.buffer[0] = oldest.subarray(overflow);
        record.bufferBytes -= overflow;
        record.truncated = true;
      }
    }
  };

  const publicTerminals = new Map<string, ChildProcess>();

  return {
    get terminals(): ReadonlyMap<string, ChildProcess> {
      return publicTerminals;
    },

    async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
      const id = `term_${nextId++}`;
      const cwd = resolveCwd(params.cwd ?? undefined);
      const args = params.args ?? [];
      const shell = params.args === undefined;
      const child = spawn(params.command, args, {
        cwd,
        env: { ...env, ...resolveEnvOverrides(params.env) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell,
      });

      const record: TerminalRecord = {
        process: child,
        buffer: [],
        bufferBytes: 0,
        byteLimit: params.outputByteLimit ?? defaultLimit,
        truncated: false,
        exitCode: null,
        exitSignal: null,
        exited: false,
        exitPromise: undefined as unknown as Promise<void>,
      };

      record.exitPromise = new Promise<void>((resolveExit) => {
        const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
          if (record.exited) return;
          record.exited = true;
          record.exitCode = code;
          record.exitSignal = signal;
          resolveExit();
        };
        child.on('close', (code, signal) => finalize(code, signal));
        child.on('error', (error) => {
          appendOutput(record, Buffer.from(`Failed to start terminal command: ${error.message}\n`));
          finalize(127, null);
        });
      });

      child.stdout?.on('data', (chunk: Buffer) => appendOutput(record, chunk));
      child.stderr?.on('data', (chunk: Buffer) => appendOutput(record, chunk));

      terminals.set(id, record);
      publicTerminals.set(id, child);
      return { terminalId: id };
    },

    async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
      const record = terminals.get(params.terminalId);
      if (!record) return { output: '', truncated: false };
      const output = Buffer.concat(record.buffer).toString('utf-8');
      const exitStatus = record.exited
        ? { exitCode: record.exitCode ?? undefined, signal: record.exitSignal ?? undefined }
        : undefined;
      const response: TerminalOutputResponse = { output, truncated: record.truncated };
      if (exitStatus) (response as TerminalOutputResponse & { exitStatus?: unknown }).exitStatus = exitStatus;
      return response;
    },

    async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
      const record = terminals.get(params.terminalId);
      if (!record) return { exitCode: -1 };
      if (!record.exited) {
        const timeoutMs = (params as WaitForTerminalExitRequest & { timeout?: number }).timeout;
        if (timeoutMs && timeoutMs > 0) {
          await Promise.race([
            record.exitPromise,
            new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
          ]);
        } else {
          await record.exitPromise;
        }
      }
      return {
        exitCode: record.exitCode ?? -1,
        ...(record.exitSignal ? { signal: record.exitSignal } : {}),
      } as WaitForTerminalExitResponse;
    },

    async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
      const record = terminals.get(params.terminalId);
      if (record && !record.exited) {
        // ACP `killTerminal` semantics are "stop it now" — go straight to
        // SIGKILL. SIGTERM is unreliable on shared CI runners (a child that
        // has not yet installed its handler can race the signal, the parent
        // shell may not propagate it, etc.) and any attempt to handle it
        // gracefully belongs in the caller, not here.
        try {
          record.process.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      return {};
    },

    async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
      // Per ACP spec, release frees host-side bookkeeping but does NOT kill
      // the underlying process. Callers wanting termination should
      // killTerminal first.
      terminals.delete(params.terminalId);
      publicTerminals.delete(params.terminalId);
      return {};
    },
  };
}

function defaultResolveCwd(cwd: string | undefined): string {
  if (!cwd) {
    throw new Error(
      'createLocalTerminalHost: agent did not supply a cwd and no `resolveCwd` was configured',
    );
  }
  return cwd;
}

function resolveEnvOverrides(env: unknown): NodeJS.ProcessEnv {
  if (!env || typeof env !== 'object') return {};
  if (Array.isArray(env)) {
    // ACP spec sometimes types env as `Array<{name,value}>`; accept that too.
    const out: NodeJS.ProcessEnv = {};
    for (const entry of env as Array<{ name?: string; value?: string }>) {
      if (entry?.name) out[entry.name] = entry.value ?? '';
    }
    return out;
  }
  return env as NodeJS.ProcessEnv;
}
