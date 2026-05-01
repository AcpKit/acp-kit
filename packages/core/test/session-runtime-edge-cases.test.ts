import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  createAcpRuntime,
  PermissionDecision,
  runOneShotPrompt,
  type AcpConnectionFactory,
  type AcpTransport,
  type SpawnProcess,
} from '../src/index.js';

function createFakeSpawn(): SpawnProcess {
  return () => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
}

function createBasicConnectionFactory(overrides: Record<string, unknown> = {}): {
  factory: AcpConnectionFactory;
  captureClient: () => { sessionUpdate(notification: unknown): Promise<void> } | null;
} {
  let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
  return {
    captureClient: () => capturedClient,
    factory: {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
          newSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
          prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
          cancel: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn().mockResolvedValue(undefined),
          ...overrides,
        } as never;
      },
    },
  };
}

describe('session cancellation', () => {
  it('cancel during active prompt emits turn.cancelled', async () => {
    let rejectPrompt: ((err: unknown) => void) | null = null;
    const { factory, captureClient } = createBasicConnectionFactory({
      prompt: vi.fn(() => new Promise((_resolve, reject) => { rejectPrompt = reject; })),
      cancel: vi.fn(async () => {
        rejectPrompt?.(Object.assign(new Error('cancelled'), { code: -32800 }));
      }),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const events: string[] = [];
    session.on('event', (e) => events.push(e.type));

    const promptPromise = session.prompt('hello');
    // Wait a tick for prompt to start
    await new Promise((r) => setTimeout(r, 10));
    await session.cancel();

    const result = await promptPromise;
    expect(result.stopReason).toBe('cancelled');
    expect(events).toContain('turn.started');
    expect(events).toContain('turn.cancelled');
    expect(events).not.toContain('turn.completed');

    await runtime.shutdown();
  });

  it('cancel when no prompt is running is a no-op', async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    const { factory } = createBasicConnectionFactory({ cancel: cancelFn });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    await session.cancel();
    expect(cancelFn).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  it('does not treat ordinary cancellation-looking error text as a user cancel', async () => {
    const { factory } = createBasicConnectionFactory({
      prompt: vi.fn().mockRejectedValue(new Error('cleanup cancelled because disk is full')),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const events: string[] = [];
    session.on('event', (e) => events.push(e.type));

    await expect(session.prompt('hello')).rejects.toThrow('cleanup cancelled because disk is full');
    expect(events).toContain('turn.failed');
    expect(events).not.toContain('turn.cancelled');

    await runtime.shutdown();
  });
});

describe('session dispose/close edge cases', () => {
  it('prompt after dispose throws', async () => {
    const { factory } = createBasicConnectionFactory();
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    await session.dispose();
    await expect(session.prompt('hello')).rejects.toThrow(/disposed/);
    await runtime.shutdown();
  });

  it('dispose is idempotent', async () => {
    const { factory } = createBasicConnectionFactory();
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const events: string[] = [];
    session.on('event', (e) => events.push(e.type));

    await session.dispose();
    await session.dispose();

    // status.changed to disposed should only fire once
    const disposed = events.filter((e) => e === 'status.changed');
    expect(disposed).toHaveLength(1);
    await runtime.shutdown();
  });

  it('setMode throws after dispose', async () => {
    const { factory } = createBasicConnectionFactory();
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });
    const session = await runtime.newSession();
    await session.dispose();
    await expect(session.setMode('plan')).rejects.toThrow(/disposed/);
    await runtime.shutdown();
  });

  it('setModel throws after dispose', async () => {
    const { factory } = createBasicConnectionFactory();
    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });
    const session = await runtime.newSession();
    await session.dispose();
    await expect(session.setModel('gpt-5')).rejects.toThrow(/disposed/);
    await runtime.shutdown();
  });

  it('prompt throws when another prompt is already running', async () => {
    let resolvePrompt: ((val: unknown) => void) | null = null;
    const { factory } = createBasicConnectionFactory({
      prompt: vi.fn(() => new Promise((resolve) => { resolvePrompt = resolve; })),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const p1 = session.prompt('first');
    await expect(session.prompt('second')).rejects.toThrow(/already running/);
    resolvePrompt?.({ stopReason: 'end_turn' });
    await p1;
    await runtime.shutdown();
  });
});

describe('session status transitions', () => {
  it('emits status.changed events through the prompt lifecycle', async () => {
    const { factory, captureClient } = createBasicConnectionFactory({
      prompt: vi.fn(async () => {
        return { stopReason: 'end_turn' };
      }),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const statuses: Array<{ status: string; previous: string | null }> = [];
    session.on('status.changed', (e) => {
      statuses.push({ status: e.status, previous: e.previousStatus });
    });

    await session.prompt('hello');

    expect(statuses).toEqual([
      { status: 'running', previous: 'idle' },
      { status: 'idle', previous: 'running' },
    ]);

    await session.dispose();
    expect(statuses[2]).toEqual({ status: 'disposed', previous: 'idle' });
    await runtime.shutdown();
  });

  it('emits full prompt response usage including ACP context and cost fields', async () => {
    const { factory } = createBasicConnectionFactory({
      prompt: vi.fn(async () => ({
        stopReason: 'end_turn',
        usage: {
          used: 12_000,
          size: 200_000,
          cost: 0.42,
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
          cachedReadTokens: 9,
          cachedWriteTokens: 3,
          thoughtTokens: 7,
        },
      })),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const usageUpdates: unknown[] = [];
    session.on('session.usage.updated', (event) => usageUpdates.push(event));

    const result = await session.prompt('measure usage');

    expect(result.usage).toMatchObject({ used: 12_000, size: 200_000, cost: 0.42 });
    expect(usageUpdates[0]).toMatchObject({
      type: 'session.usage.updated',
      used: 12_000,
      size: 200_000,
      cost: 0.42,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cachedReadTokens: 9,
      cachedWriteTokens: 3,
      thoughtTokens: 7,
    });

    await runtime.shutdown();
  });
});

describe('runtime shutdown', () => {
  it('shutdown disposes the connection', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const { factory } = createBasicConnectionFactory({ dispose });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    await runtime.newSession();
    await runtime.shutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('permission mapping edge cases', () => {
  it('AllowOnce maps to proceed_once option', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'perm-test' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => PermissionDecision.AllowOnce,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();
    const response = await capturedClient?.requestPermission({
      toolCall: { id: 'tool-1', toolName: 'read_file' },
      options: [
        { optionId: 'proceed_once', name: 'Allow Once' },
        { optionId: 'proceed_always', name: 'Always Allow' },
        { optionId: 'cancel', name: 'Cancel' },
      ],
    });

    expect(response?.outcome.optionId).toBe('proceed_once');
    await runtime.shutdown();
  });

  it('Deny maps to cancel/reject option', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'deny-test' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => PermissionDecision.Deny,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();
    const response = await capturedClient?.requestPermission({
      toolCall: { id: 'tool-1', toolName: 'write_file' },
      options: [
        { optionId: 'proceed_once', name: 'Allow Once' },
        { optionId: 'cancel', name: 'Cancel' },
      ],
    });

    expect(response?.outcome.optionId).toBe('cancel');
    await runtime.shutdown();
  });

  it('defaults to first option when no matching option exists', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'fallback-test' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => PermissionDecision.AllowAlways,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();
    // Only one option, but we request AllowAlways -- no always option exists
    const response = await capturedClient?.requestPermission({
      toolCall: { id: 'tool-1', toolName: 'read_file' },
      options: [
        { optionId: 'only-option', name: 'Proceed' },
      ],
    });

    // Should fall back to the first/only available option
    expect(response?.outcome.optionId).toBe('only-option');
    await runtime.shutdown();
  });
});

describe('runOneShotPrompt edge cases', () => {
  it('propagates agent startup errors', async () => {
    const transport: AcpTransport = {
      async connect() {
        return {
          connection: {
            initialize: vi.fn().mockRejectedValue(new Error('agent not installed')),
            newSession: vi.fn(),
            prompt: vi.fn(),
            cancel: vi.fn(),
          },
          getDiagnostics: () => ({ stderr: '', exitSummary: null }),
        };
      },
    };

    const iter = runOneShotPrompt({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      prompt: 'hi',
      transport,
    });

    await expect(iter.next()).rejects.toThrow();
  });

  it('yields events and completes iteration', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const transport: AcpTransport = {
      async connect({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          connection: {
            initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
            newSession: vi.fn().mockResolvedValue({ sessionId: 'one-shot' }),
            prompt: vi.fn(async () => {
              await capturedClient?.sessionUpdate({
                sessionId: 'one-shot',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
              });
              return { stopReason: 'end_turn' };
            }),
            cancel: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn().mockResolvedValue(undefined),
          },
          getDiagnostics: () => ({ stderr: '', exitSummary: null }),
        };
      },
    };

    const events: string[] = [];
    for await (const event of runOneShotPrompt({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      prompt: 'hi',
      transport,
    })) {
      events.push(event.type);
    }

    expect(events).toContain('message.delta');
    expect(events).toContain('turn.completed');
  });

  it('early return disposes resources', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const transport: AcpTransport = {
      async connect({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          connection: {
            initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
            newSession: vi.fn().mockResolvedValue({ sessionId: 'early' }),
            prompt: vi.fn(async () => {
              await capturedClient?.sessionUpdate({
                sessionId: 'early',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } },
              });
              await capturedClient?.sessionUpdate({
                sessionId: 'early',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } },
              });
              return { stopReason: 'end_turn' };
            }),
            cancel: vi.fn().mockResolvedValue(undefined),
            dispose,
          },
          getDiagnostics: () => ({ stderr: '', exitSummary: null }),
        };
      },
    };

    const iter = runOneShotPrompt({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      prompt: 'hi',
      transport,
    });

    // Get first event then break
    await iter.next();
    await iter.return!();

    expect(dispose).toHaveBeenCalled();
  });
});

describe('session event subscription forms', () => {
  it('emits normalized session.error updates through the runtime session pipeline', async () => {
    const { factory, captureClient } = createBasicConnectionFactory({
      prompt: vi.fn(async function () {
        const client = captureClient();
        await client?.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial before failure' } },
        });
        await client?.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'session_error', message: 'adapter lost connection' },
        });
        return { stopReason: 'end_turn' };
      }),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const events: Array<{ type: string; message?: string; delta?: string }> = [];
    session.on('event', (event) => events.push(event));

    await session.prompt('hello');

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message.delta', delta: 'partial before failure' }),
      expect.objectContaining({ type: 'session.error', message: 'adapter lost connection' }),
    ]));
    expect(events.find((event) => event.type === 'session.error')).toMatchObject({
      message: 'adapter lost connection',
    });

    await runtime.shutdown();
  });

  it('on(type, listener) receives only matching events', async () => {
    const { factory, captureClient } = createBasicConnectionFactory({
      prompt: vi.fn(async function (this: unknown) {
        const client = captureClient();
        await client?.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        });
        await client?.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
        });
        return { stopReason: 'end_turn' };
      }),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const deltas: string[] = [];
    session.on('message.delta', (e) => deltas.push(e.delta));

    await session.prompt('hello');

    expect(deltas).toEqual(['hi']);
    await runtime.shutdown();
  });

  it('unsubscribe function removes the listener', async () => {
    const { factory, captureClient } = createBasicConnectionFactory({
      prompt: vi.fn(async function () {
        const client = captureClient();
        await client?.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'msg' } },
        });
        return { stopReason: 'end_turn' };
      }),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    const events: string[] = [];
    const unsub = session.on('event', (e) => events.push(e.type));
    unsub();

    await session.prompt('hello');

    // After unsubscribe, no events should be captured
    expect(events).toEqual([]);
    await runtime.shutdown();
  });
});

describe('session transcript snapshot', () => {
  it('getSnapshot returns current state after prompt', async () => {
    const { factory, captureClient } = createBasicConnectionFactory({
      prompt: vi.fn(async function () {
        const client = captureClient();
        await client?.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'snapshot content' } },
        });
        return { stopReason: 'end_turn' };
      }),
    });

    const runtime = createAcpRuntime({
      agent: { id: 'test', displayName: 'Test', command: 'test', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory: factory,
    });

    const session = await runtime.newSession();
    await session.prompt('hello');

    const snapshot = session.getSnapshot();
    expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.blocks[0].content).toBe('snapshot content');
    expect(snapshot.blocks[0].completed).toBe(true);

    // Snapshot should be a clone - mutating it shouldn't affect session
    snapshot.blocks[0].content = 'mutated';
    const snapshot2 = session.getSnapshot();
    expect(snapshot2.blocks[0].content).toBe('snapshot content');

    await runtime.shutdown();
  });
});
