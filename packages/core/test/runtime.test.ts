import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  createAcpRuntime,
  PermissionDecision,
  runOneShotPrompt,
  type AcpConnectionFactory,
  type AcpTransport,
  type SpawnProcess,
  type WireMiddleware,
} from '../src/index.js';
import { resolveLaunch } from '../src/transports/node.js';

function createFakeSpawn(): SpawnProcess {
  return () => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
}

describe('AcpRuntime', () => {
  it('launches Windows PowerShell shims through powershell.exe', () => {
    expect(resolveLaunch('C:/nvm4w/nodejs/codex-acp.ps1', ['--flag'], 'win32')).toEqual({
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/nvm4w/nodejs/codex-acp.ps1', '--flag'],
    });
  });

  it('creates a session and emits normalized prompt lifecycle events', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        modes: {
          currentModeId: 'ask',
          availableModes: [{ id: 'ask', name: 'Ask' }],
        },
        models: {
          currentModelId: 'gpt-5.4',
          availableModels: [{ modelId: 'gpt-5.4', name: 'GPT-5.4' }],
        },
      }),
      prompt: vi.fn(async () => {
        await capturedClient?.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking' },
          },
        });
        await capturedClient?.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return connection as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.newSession();
    const events: string[] = [];
    session.on('event', (event) => {
      events.push(event.type);
    });

    const result = await session.prompt('hello');
    const snapshot = session.getSnapshot();

    expect(result.stopReason).toBe('end_turn');
    expect(events).toContain('turn.started');
    expect(events).toContain('reasoning.delta');
    expect(events).toContain('message.delta');
    expect(events).toContain('reasoning.completed');
    expect(events).toContain('message.completed');
    expect(events).toContain('turn.completed');
    expect(snapshot.blocks).toEqual([
      expect.objectContaining({ kind: 'reasoning', content: 'thinking', completed: true }),
      expect.objectContaining({ kind: 'message', content: 'hello', completed: true }),
    ]);
    expect(snapshot.session.currentModeId).toBe('ask');
    expect(snapshot.session.currentModelId).toBe('gpt-5.4');
  });

  it('keeps collecting late tool continuation updates after prompt resolves', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-late-tool' }),
      prompt: vi.fn(async () => {
        await capturedClient?.sessionUpdate({
          sessionId: 'session-late-tool',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            toolName: 'Edit',
            status: 'running',
            input: { text: 'write file' },
          },
        });
        setTimeout(() => {
          void capturedClient?.sessionUpdate({
            sessionId: 'session-late-tool',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              status: 'completed',
              toolResponse: { text: 'file written' },
            },
          });
          void capturedClient?.sessionUpdate({
            sessionId: 'session-late-tool',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done after tool' } },
          });
        }, 20);
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test Agent', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: {
        create({ client }) {
          capturedClient = client as typeof capturedClient;
          return connection as never;
        },
      },
    });

    const session = await runtime.newSession();
    const events: Array<{ type: string; turnId?: string; delta?: string; status?: string }> = [];
    session.on('event', (event) => events.push(event));

    await session.prompt('write it');

    const toolStart = events.find((event) => event.type === 'tool.start');
    const toolEnd = events.find((event) => event.type === 'tool.end');
    const messageDelta = events.find((event) => event.type === 'message.delta');
    const completedIndex = events.findIndex((event) => event.type === 'turn.completed');

    expect(toolEnd).toMatchObject({ type: 'tool.end', status: 'completed' });
    expect(messageDelta).toMatchObject({ type: 'message.delta', delta: 'done after tool' });
    expect(toolEnd?.turnId).toBe(toolStart?.turnId);
    expect(messageDelta?.turnId).toBe(toolStart?.turnId);
    expect(events.findIndex((event) => event.type === 'tool.end')).toBeLessThan(completedIndex);
    expect(events.findIndex((event) => event.type === 'message.delta')).toBeLessThan(completedIndex);
    expect(session.getSnapshot().blocks).toEqual([
      expect.objectContaining({ kind: 'message', content: 'done after tool', completed: true, turnId: toolStart?.turnId }),
    ]);
    expect(session.getSnapshot().tools['tool-1']).toMatchObject({ status: 'completed', turnId: toolStart?.turnId });

    await runtime.shutdown();
  });

  it('does not complete while a prompt-returned tool is still running', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    let completeTool: (() => void) | null = null;
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-open-tool' }),
      prompt: vi.fn(async () => {
        await capturedClient?.sessionUpdate({
          sessionId: 'session-open-tool',
          update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', toolName: 'Bash', status: 'running' },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test Agent', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: {
        create({ client }) {
          capturedClient = client as typeof capturedClient;
          completeTool = () => {
            void capturedClient?.sessionUpdate({
              sessionId: 'session-open-tool',
              update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', toolResponse: 'ok' },
            });
          };
          return connection as never;
        },
      },
    });

    const session = await runtime.newSession();
    let completed = false;
    const promptPromise = session.prompt('run tool').then(() => { completed = true; });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(completed).toBe(false);
    completeTool?.();
    await promptPromise;
    expect(session.getSnapshot().tools['tool-1']).toMatchObject({ status: 'completed' });

    await runtime.shutdown();
  });

  it('emits startup observer phases for connect, initialize, and newSession', async () => {
    const startupObserver = {
      mark: vi.fn(),
      once: vi.fn(),
    };
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'session-startup' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      host: {},
      startupObserver,
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();

    expect(startupObserver.mark.mock.calls.map(([event]) => event.phase)).toEqual(expect.arrayContaining([
      'ACP connect begin',
      'ACP connect end',
      'ACP initialize begin',
      'ACP initialize end',
      'newSession begin',
      'newSession end',
    ]));
  });

  it('retries session creation after ACP auth is required', async () => {
    const authenticate = vi.fn().mockResolvedValue(undefined);
    const newSession = vi
      .fn()
      .mockRejectedValueOnce({ code: -32000, message: 'auth required' })
      .mockResolvedValueOnce({ sessionId: 'session-2' });

    const connection = {
      initialize: vi.fn().mockResolvedValue({
        authMethods: [{ id: 'device', name: 'Device Code' }],
      }),
      newSession,
      authenticate,
      prompt: vi.fn(),
      cancel: vi.fn(),
    };

    const connectionFactory: AcpConnectionFactory = {
      create() {
        return connection as never;
      },
    };

    const chooseAuthMethod = vi.fn().mockResolvedValue('device');
    const runtime = createAcpRuntime({
      agent: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      host: {
        chooseAuthMethod,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.newSession();

    expect(session.sessionId).toBe('session-2');
    expect(chooseAuthMethod).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({ methodId: 'device' });
    expect(newSession).toHaveBeenCalledTimes(2);
  });

  it('uses a default host when none is provided', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'session-default-host' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();
    const response = await capturedClient?.requestPermission({
      toolCall: { id: 'tool-1', toolName: 'read_file' },
      options: [{ optionId: 'proceed_once', name: 'Allow Once' }],
    });

    expect(response?.outcome.optionId).toBe('proceed_once');
  });

  it('maps host permission decisions back to ACP option ids', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'session-3' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => PermissionDecision.AllowAlways,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();
    const response = await capturedClient?.requestPermission({
      toolCall: {
        id: 'tool-1',
        toolName: 'write_file',
        input: { path: 'README.md' },
      },
      options: [
        { optionId: 'proceed_once', name: 'Allow Once' },
        { optionId: 'proceed_always', name: 'Always Allow' },
        { optionId: 'cancel', name: 'Cancel' },
      ],
    });

    expect(response).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'proceed_always',
      },
    });
  });

  it('maps permission decisions by ACP option kind when option ids are agent-defined', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'session-kind-options' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const options = [
      { optionId: 'codex-allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'codex-allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'codex-reject-once', name: 'Reject', kind: 'reject_once' },
    ];

    const allowRuntime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test Agent', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => PermissionDecision.AllowAlways,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await allowRuntime.newSession();
    const allowResponse = await capturedClient?.requestPermission({
      toolCall: { id: 'tool-kind-allow', toolName: 'write_file', input: { path: 'README.md' } },
      options,
    });
    await allowRuntime.shutdown();

    const denyRuntime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test Agent', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => PermissionDecision.Deny,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await denyRuntime.newSession();
    const denyResponse = await capturedClient?.requestPermission({
      toolCall: { id: 'tool-kind-deny', toolName: 'write_file', input: { path: 'README.md' } },
      options,
    });
    await denyRuntime.shutdown();

    expect(allowResponse?.outcome.optionId).toBe('codex-allow-always');
    expect(denyResponse?.outcome.optionId).toBe('codex-reject-once');
  });

  it('records observations and durable session events', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const observations: string[] = [];
    const storeEntries: string[] = [];

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'session-observed' }),
          prompt: async () => {
            await capturedClient?.sessionUpdate({
              sessionId: 'session-observed',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'observed' },
              },
            });
            return { stopReason: 'end_turn' };
          },
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test Agent', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      context: { tenantId: 'tenant-1' },
      observability: {
        sink: (event) => { observations.push(event.type); },
      },
      eventStore: {
        append: (entry) => { storeEntries.push(entry.kind); },
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.newSession();
    await session.prompt('hello');

    expect(observations).toContain('runtime.connect.started');
    expect(observations).toContain('runtime.connect.completed');
    expect(observations).toContain('session.created');
    expect(observations).toContain('turn.started');
    expect(observations).toContain('turn.completed');
    expect(storeEntries).toContain('observation');
    expect(storeEntries).toContain('session.event');
  });

  it('routes permission requests through an approval queue', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;
    const observations: string[] = [];
    const approvalRequests: string[] = [];

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'session-approval' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test Agent', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => PermissionDecision.AllowAlways,
      },
      approvals: {
        request: async (request) => {
          approvalRequests.push(request.approvalId);
          return { approvalId: 'approval-1' };
        },
        waitForDecision: async () => PermissionDecision.Deny,
      },
      observability: {
        sink: (event) => { observations.push(event.type); },
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();
    const response = await capturedClient?.requestPermission({
      toolCall: { id: 'tool-approval', toolName: 'write_file', input: { path: 'secret.txt' } },
      options: [
        { optionId: 'proceed_once', name: 'Allow Once' },
        { optionId: 'cancel', name: 'Cancel' },
      ],
    });

    expect(approvalRequests[0]).toMatch(/^approval:tool-approval:/);
    expect(response?.outcome.optionId).toBe('cancel');
    expect(observations).toContain('permission.requested');
    expect(observations).toContain('approval.queued');
    expect(observations).toContain('approval.decided');
    expect(observations).toContain('permission.decided');
  });

  it('newSession throws when neither runtime nor call site provides cwd', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'unused' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await expect(runtime.newSession()).rejects.toThrow(/requires a `cwd`/);
  });

  it('shares one agent process across multiple sessions and exposes initialize metadata', async () => {
    const initialize = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      agentInfo: { name: 'fake-agent', version: '9.9.9' },
      authMethods: [{ id: 'device', name: 'Device' }],
      agentCapabilities: { loadSession: true, promptCapabilities: {} },
    });
    const newSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 's-1' })
      .mockResolvedValueOnce({ sessionId: 's-2' });

    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize,
          newSession,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const spawn = vi.fn(createFakeSpawn());
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: spawn,
      connectionFactory,
    });

    expect(runtime.isReady).toBe(false);
    const a = await runtime.newSession();
    const b = await runtime.newSession();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(a.sessionId).toBe('s-1');
    expect(b.sessionId).toBe('s-2');
    expect(runtime.isReady).toBe(true);
    expect(runtime.agentInfo?.name).toBe('fake-agent');
    expect(runtime.protocolVersion).toBe(1);
    expect(runtime.agentCapabilities?.loadSession).toBe(true);
    expect(runtime.authMethods).toHaveLength(1);

    await runtime.shutdown();
  });

  it('uses a project-local package bin before falling back to npx package startup', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-runtime-local-bin-'));
    try {
      const binDir = path.join(tempRoot, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, process.platform === 'win32' ? 'local-acp-agent.cmd' : 'local-acp-agent');
      fs.writeFileSync(binPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/usr/bin/env node\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);

      const connectionFactory: AcpConnectionFactory = {
        create() {
          return {
            initialize: async () => ({ authMethods: [] }),
            newSession: async () => ({ sessionId: 'local-bin-session' }),
            prompt: async () => ({ stopReason: 'end_turn' }),
            cancel: async () => undefined,
          } as never;
        },
      };
      const spawn = vi.fn(createFakeSpawn());
      const runtime = createAcpRuntime({
        agent: {
          id: 'local-bin',
          displayName: 'Local Bin',
          command: 'local-acp-agent',
          args: [],
          fallbackCommands: [{ command: 'npx', args: ['--yes', '@example/local-acp-agent@latest'] }],
        },
        cwd: tempRoot,
        host: {},
        spawnProcess: spawn,
        connectionFactory,
      });

      await runtime.newSession();

      expect(spawn.mock.calls[0]?.[0]).toBe(binPath);
      expect(spawn.mock.calls[0]?.[1]).toEqual([]);
      await runtime.shutdown();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves npx fallback packages from the installed runtime tree before raw npx fallback', async () => {
    const runtimeBinName = 'missing-codex-bin';
    const runtimeDir = path.dirname(fileURLToPath(new URL('../src/transports/node.ts', import.meta.url)));
    const binDir = path.resolve(runtimeDir, '..', '..', 'node_modules', '.bin');
    const binPath = path.join(binDir, process.platform === 'win32' ? `${runtimeBinName}.cmd` : runtimeBinName);
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.writeFile(binPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');

    const spawnProcess = vi.fn((command, args, options) => ({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
      on: () => undefined,
    })) as SpawnProcess;

    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'runtime-fallback' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: {
        id: 'codex-like',
        displayName: 'Codex-like',
        command: runtimeBinName,
        args: [],
        fallbackCommands: [{ command: 'npx', args: ['@openai/codex', 'codex'] }],
      },
      cwd: 'C:/repo',
      host: {},
      spawnProcess,
      connectionFactory,
    });

    const session = await runtime.newSession();
    expect(session.sessionId).toBe('runtime-fallback');
    expect(spawnProcess).toHaveBeenCalled();
    expect(spawnProcess.mock.calls[0]?.[0]).toBe(binPath);
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(['codex']);

    await fsp.rm(binPath, { force: true });
  });

  it('uses an already-prepared fallback package cache before raw npx startup', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-runtime-raw-npx-'));
    const fakeBinDir = path.join(tempRoot, 'fake-bin');
    const cacheRoot = path.join(tempRoot, 'agent-cache');
    const originalPath = process.env.PATH;
    const originalCacheDir = process.env.ACP_KIT_AGENT_CACHE_DIR;
    try {
      fs.mkdirSync(fakeBinDir, { recursive: true });
      const fakeNpx = path.join(fakeBinDir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
      fs.writeFileSync(fakeNpx, process.platform === 'win32' ? '@echo off\r\n' : '#!/usr/bin/env node\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(fakeNpx, 0o755);
      const cacheBinDir = path.join(cacheRoot, 'github_copilot-language-server_latest', 'node_modules', '.bin');
      fs.mkdirSync(cacheBinDir, { recursive: true });
      const cachedCopilot = path.join(cacheBinDir, process.platform === 'win32' ? 'acp-kit-copilot-language-server.cmd' : 'acp-kit-copilot-language-server');
      fs.writeFileSync(cachedCopilot, process.platform === 'win32' ? '@echo off\r\n' : '#!/usr/bin/env node\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(cachedCopilot, 0o755);
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ''}`;
      process.env.ACP_KIT_AGENT_CACHE_DIR = cacheRoot;

      const connectionFactory: AcpConnectionFactory = {
        create() {
          return {
            initialize: async () => ({ authMethods: [] }),
            newSession: async () => ({ sessionId: 'raw-npx-session' }),
            prompt: async () => ({ stopReason: 'end_turn' }),
            cancel: async () => undefined,
          } as never;
        },
      };
      const spawn = vi.fn(createFakeSpawn());
      const runtime = createAcpRuntime({
        agent: {
          id: 'github-copilot',
          displayName: 'GitHub Copilot',
          command: 'acp-kit-copilot-language-server',
          args: [],
          fallbackCommands: [{ command: 'npx', args: ['--yes', '@github/copilot-language-server@latest', '--acp'] }],
        },
        cwd: tempRoot,
        host: {},
        spawnProcess: spawn,
        connectionFactory,
      });

      await runtime.newSession();

      expect(spawn.mock.calls[0]?.[0]).toBe(cachedCopilot);
      expect(spawn.mock.calls[0]?.[1]).toEqual(['--acp']);
      await runtime.shutdown();
    } finally {
      process.env.PATH = originalPath;
      if (originalCacheDir === undefined) delete process.env.ACP_KIT_AGENT_CACHE_DIR;
      else process.env.ACP_KIT_AGENT_CACHE_DIR = originalCacheDir;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back to raw npx only after stable package locations miss', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-runtime-raw-npx-'));
    const fakeBinDir = path.join(tempRoot, 'fake-bin');
    const cacheRoot = path.join(tempRoot, 'empty-agent-cache');
    const originalPath = process.env.PATH;
    const originalCacheDir = process.env.ACP_KIT_AGENT_CACHE_DIR;
    try {
      fs.mkdirSync(fakeBinDir, { recursive: true });
      const fakeNpx = path.join(fakeBinDir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
      fs.writeFileSync(fakeNpx, process.platform === 'win32' ? '@echo off\r\n' : '#!/usr/bin/env node\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(fakeNpx, 0o755);
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ''}`;
      process.env.ACP_KIT_AGENT_CACHE_DIR = cacheRoot;

      const connectionFactory: AcpConnectionFactory = {
        create() {
          return {
            initialize: async () => ({ authMethods: [] }),
            newSession: async () => ({ sessionId: 'raw-npx-session' }),
            prompt: async () => ({ stopReason: 'end_turn' }),
            cancel: async () => undefined,
          } as never;
        },
      };
      const spawn = vi.fn(createFakeSpawn());
      const runtime = createAcpRuntime({
        agent: {
          id: 'raw-npx-fallback',
          displayName: 'Raw npx fallback',
          command: 'missing-acp-agent',
          args: [],
          fallbackCommands: [{ command: 'npx', args: ['--yes', '@example/never-installed-missing-acp-agent@latest'] }],
        },
        cwd: tempRoot,
        host: {},
        spawnProcess: spawn,
        connectionFactory,
      });

      await runtime.newSession();

      expect(spawn.mock.calls[0]?.[0]).toBe(fakeNpx);
      expect(spawn.mock.calls[0]?.[1]).toEqual(['--yes', '@example/never-installed-missing-acp-agent@latest']);
      await runtime.shutdown();
    } finally {
      process.env.PATH = originalPath;
      if (originalCacheDir === undefined) delete process.env.ACP_KIT_AGENT_CACHE_DIR;
      else process.env.ACP_KIT_AGENT_CACHE_DIR = originalCacheDir;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  it('uses a fallback launch command when the primary command is not on PATH', async () => {
    const initialize = vi.fn().mockResolvedValue({ authMethods: [] });
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'fallback-session' });
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize,
          newSession,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };
    const spawn = vi.fn(createFakeSpawn());
    const log = vi.fn();
    const runtime = createAcpRuntime({
      agent: {
        id: 'test',
        displayName: 'Test',
        command: 'acp-kit-definitely-missing-command',
        args: ['--primary'],
        fallbackCommands: [{ command: process.execPath, args: ['--fallback'] }],
      },
      cwd: 'C:/repo',
      host: { log },
      spawnProcess: spawn,
      connectionFactory,
    });

    const session = await runtime.newSession();

    expect(session.sessionId).toBe('fallback-session');
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['--fallback'], expect.any(Object));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: 'ACP agent primary command was not found; using fallback command',
    }));

    await runtime.shutdown();
  });

  it('treats unscoped npx package fallbacks as package candidates before raw npx startup', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-runtime-unscoped-bin-'));
    try {
      const binDir = path.join(tempRoot, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
      fs.writeFileSync(binPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/usr/bin/env node\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);

      const connectionFactory: AcpConnectionFactory = {
        create() {
          return {
            initialize: async () => ({ authMethods: [] }),
            newSession: async () => ({ sessionId: 'unscoped-local-bin-session' }),
            prompt: async () => ({ stopReason: 'end_turn' }),
            cancel: async () => undefined,
          } as never;
        },
      };
      const spawn = vi.fn(createFakeSpawn());
      const runtime = createAcpRuntime({
        agent: {
          id: 'unscoped-local-bin',
          displayName: 'Unscoped Local Bin',
          command: 'opencode',
          args: [],
          fallbackCommands: [{ command: 'npx', args: ['--yes', 'opencode-ai@latest', 'acp'] }],
        },
        cwd: tempRoot,
        host: {},
        spawnProcess: spawn,
        connectionFactory,
      });

      await runtime.newSession();

      expect(spawn.mock.calls[0]?.[0]).toBe(binPath);
      expect(spawn.mock.calls[0]?.[1]).toEqual(['acp']);
      await runtime.shutdown();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('routes session/update notifications to the matching session by sessionId', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: vi
            .fn()
            .mockResolvedValueOnce({ sessionId: 'session-A' })
            .mockResolvedValueOnce({ sessionId: 'session-B' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const a = await runtime.newSession();
    const b = await runtime.newSession();

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.on('event', (e) => seenA.push(e));
    b.on('event', (e) => seenB.push(e));

    await capturedClient?.sessionUpdate({
      sessionId: 'session-A',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'for A' } },
    });
    await capturedClient?.sessionUpdate({
      sessionId: 'session-B',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'for B' } },
    });

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);

    await runtime.shutdown();
  });

  it('loadSession resumes a session through connection.loadSession', async () => {
    const loadSession = vi.fn().mockResolvedValue({ modes: undefined, models: undefined });
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({
            authMethods: [],
            agentCapabilities: { loadSession: true, promptCapabilities: {} },
          }),
          newSession: async () => ({ sessionId: 'unused' }),
          loadSession,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.loadSession({ sessionId: 'resumed-1' });
    expect(session.sessionId).toBe('resumed-1');
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: 'resumed-1',
      cwd: 'C:/repo',
      mcpServers: [],
    });

    await runtime.shutdown();
  });

  it('loadSession throws when the agent does not advertise loadSession capability', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [], agentCapabilities: { promptCapabilities: {} } }),
          newSession: async () => ({ sessionId: 'unused' }),
          loadSession: async () => undefined,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await expect(runtime.loadSession({ sessionId: 'x' })).rejects.toThrow(/loadSession capability/);
  });

  it('forwards setMode and setModel to the underlying connection', async () => {
    const setSessionMode = vi.fn().mockResolvedValue(undefined);
    const unstable_setSessionModel = vi.fn().mockResolvedValue(undefined);
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-mode' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
          setSessionMode,
          unstable_setSessionModel,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.newSession();
    await session.setMode('plan');
    await session.setModel('gpt-5');

    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-mode', modeId: 'plan' });
    expect(unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-mode', modelId: 'gpt-5' });

    await runtime.shutdown();
  });

  it('setMode/setModel throw when the connection does not implement them', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-no-mode' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    const session = await runtime.newSession();
    await expect(session.setMode('plan')).rejects.toThrow(/session\/set_mode/);
    await expect(session.setModel('gpt-5')).rejects.toThrow(/session\/set_model/);
    await runtime.shutdown();
  });

  it('forwards initialize.clientInfo from package.json and advertises promptCapabilities', async () => {
    const initialize = vi.fn().mockResolvedValue({ authMethods: [] });
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize,
          newSession: async () => ({ sessionId: 'sess-init' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    await runtime.newSession();
    const params = initialize.mock.calls[0]?.[0];
    expect(params?.clientInfo?.name).toBe('@acp-kit/core');
    // Should be a real semver string from package.json, not the old hardcoded '0.1.4'.
    expect(params?.clientInfo?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(params?.clientInfo?.version).not.toBe('0.1.4');
    expect(params?.clientCapabilities?.promptCapabilities).toEqual({
      image: true,
      audio: false,
      embeddedContext: true,
    });
    await runtime.shutdown();
  });

  it('omits promptCapabilities when the host does not declare any', async () => {
    const initialize = vi.fn().mockResolvedValue({ authMethods: [] });
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize,
          newSession: async () => ({ sessionId: 'sess-init-2' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    await runtime.newSession();
    const params = initialize.mock.calls[0]?.[0];
    expect(params?.clientCapabilities?.promptCapabilities).toBeUndefined();
    await runtime.shutdown();
  });

  it('listSessions forwards to the connection when the agent advertises the capability', async () => {
    const listSessions = vi.fn().mockResolvedValue({ sessions: [{ sessionId: 'a', cwd: 'C:/repo' }] });
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({
            authMethods: [],
            agentCapabilities: { sessionCapabilities: { list: {} } },
          }),
          newSession: async () => ({ sessionId: 'sess-list' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
          listSessions,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    await runtime.newSession();
    const result = await runtime.listSessions({ cwd: 'C:/repo' });
    expect(listSessions).toHaveBeenCalledWith({ cwd: 'C:/repo' });
    expect(result.sessions).toHaveLength(1);
    await runtime.shutdown();
  });

  it('listSessions throws when the agent does not advertise the capability', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-no-list' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    await runtime.newSession();
    await expect(runtime.listSessions()).rejects.toThrow(/session\/list capability/);
    await runtime.shutdown();
  });

  it('session.close calls unstable_closeSession then disposes the session', async () => {
    const unstable_closeSession = vi.fn().mockResolvedValue(undefined);
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-close' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
          unstable_closeSession,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    const session = await runtime.newSession();
    await session.close();
    expect(unstable_closeSession).toHaveBeenCalledWith({ sessionId: 'sess-close' });
    await expect(session.setMode('plan')).rejects.toThrow(/disposed/);
    // close() is idempotent
    await session.close();
    expect(unstable_closeSession).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  it('session.close gracefully falls back to dispose when the agent does not implement close', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-close-fallback' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    const session = await runtime.newSession();
    await session.close();
    await expect(session.setMode('plan')).rejects.toThrow(/disposed/);
    await runtime.shutdown();
  });

  it('session.close falls back to dispose when the agent rejects close as method not found', async () => {
    const closeError = new Error('"Method not found": session/close') as Error & { code?: number; data?: unknown };
    closeError.name = 'RequestError';
    closeError.code = -32601;
    closeError.data = { method: 'session/close' };
    const unstable_closeSession = vi.fn().mockRejectedValue(closeError);
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-close-method-missing' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
          unstable_closeSession,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    const session = await runtime.newSession();

    await session.close();

    expect(unstable_closeSession).toHaveBeenCalledWith({ sessionId: 'sess-close-method-missing' });
    await expect(session.setMode('plan')).rejects.toThrow(/disposed/);
    await runtime.shutdown();
  });

  it('reconnect tears down the current connection and reconnects on next session', async () => {
    const initialize = vi.fn().mockResolvedValue({ authMethods: [] });
    const newSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'before' })
      .mockResolvedValueOnce({ sessionId: 'after' });
    const dispose = vi.fn().mockResolvedValue(undefined);
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize,
          newSession,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
          dispose,
        } as never;
      },
    };
    const spawn = vi.fn(createFakeSpawn());
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: spawn,
      connectionFactory,
    });

    const before = await runtime.newSession();
    await runtime.reconnect();
    expect(dispose).toHaveBeenCalledTimes(1);

    const after = await runtime.newSession();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(before.sessionId).toBe('before');
    expect(after.sessionId).toBe('after');

    await runtime.shutdown();
  });

  it('accepts a custom transport in place of the node child-process transport', async () => {
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'custom-transport' }),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const transport: AcpTransport = {
      connect: vi.fn().mockResolvedValue({
        connection: connection as never,
        getDiagnostics: () => ({ stderr: '', exitSummary: null }),
      }),
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      transport,
    });

    const session = await runtime.newSession();
    expect(session.sessionId).toBe('custom-transport');
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(connection.initialize).toHaveBeenCalledTimes(1);

    await runtime.shutdown();
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('wireMiddleware', () => {
  it('runs Koa-style middleware on outgoing frames and observes mutations', async () => {
    const sentFrames: unknown[] = [];
    const transport: AcpTransport = {
      async connect({ host, client: _client }) {
        // Build a tiny in-process pipeline: middleware → terminator (collect into sentFrames).
        const { composeWireMiddleware, normalizeWireMiddleware } = await import('../src/wire-middleware.js');
        const middlewares = normalizeWireMiddleware(host.wireMiddleware);
        const dispatch = composeWireMiddleware(middlewares, (ctx) => {
          sentFrames.push(ctx.frame);
        });

        const connection = {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'wm-1' }),
          prompt: async (params: unknown) => {
            await dispatch({ direction: 'out', frame: { method: 'session/prompt', params } });
            return { stopReason: 'end_turn' };
          },
          cancel: async () => undefined,
        };
        return { connection: connection as never };
      },
    };

    const calls: Array<{ direction: string; frame: unknown }> = [];
    const logger: WireMiddleware = async (ctx, next) => {
      calls.push({ direction: ctx.direction, frame: ctx.frame });
      await next();
    };
    const tagger: WireMiddleware = async (ctx, next) => {
      ctx.frame = { ...(ctx.frame as object), tagged: true };
      await next();
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: { wireMiddleware: [logger, tagger] },
      transport,
    });
    const session = await runtime.newSession();
    await session.prompt('hi');

    expect(calls).toHaveLength(1);
    expect(calls[0].direction).toBe('out');
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({ method: 'session/prompt', tagged: true });

    await runtime.shutdown();
  });

  it('drops a frame when middleware does not call next()', async () => {
    const reached: unknown[] = [];
    const { composeWireMiddleware } = await import('../src/wire-middleware.js');
    const dropAll: WireMiddleware = async () => {
      // do not call next
    };
    const dispatch = composeWireMiddleware([dropAll], (ctx) => {
      reached.push(ctx.frame);
    });
    await dispatch({ direction: 'out', frame: { method: 'whatever' } });
    expect(reached).toHaveLength(0);
  });

  it('throws if a middleware calls next() more than once', async () => {
    const { composeWireMiddleware } = await import('../src/wire-middleware.js');
    const buggy: WireMiddleware = async (_ctx, next) => {
      await next();
      await next();
    };
    const dispatch = composeWireMiddleware([buggy], () => undefined);
    await expect(dispatch({ direction: 'out', frame: {} })).rejects.toThrow(/multiple times/);
  });
});

describe('runOneShotPrompt', () => {
  it('yields normalized RuntimeSessionEvents and disposes after iteration', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'np-1' }),
      prompt: vi.fn(async () => {
        await capturedClient?.sessionUpdate({
          sessionId: 'np-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const transport: AcpTransport = {
      async connect({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          connection: connection as never,
          getDiagnostics: () => ({ stderr: '', exitSummary: null }),
        };
      },
    };

    const types: string[] = [];
    for await (const event of runOneShotPrompt({
      agent: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      prompt: 'hi',
      transport,
    })) {
      types.push(event.type);
    }

    expect(types).toContain('message.delta');
    expect(types).toContain('turn.completed');
    expect(connection.dispose).toHaveBeenCalled();
  });
});
