import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAcpRuntime: vi.fn(),
  nodeChildProcessTransport: vi.fn((options: unknown) => ({ kind: 'transport', options })),
  runtime: {
    newSession: vi.fn(),
    loadSession: vi.fn(),
    shutdown: vi.fn(),
  },
  session: {
    setMode: vi.fn(),
    setModel: vi.fn(),
    close: vi.fn(),
    dispose: vi.fn(),
    transcript: { session: { models: { availableModels: [{ id: 'good-model' }] } } },
    on: vi.fn(),
  },
  sessionUsageListeners: [] as Array<(event: unknown) => void>,
  sessionPlanListeners: [] as Array<(event: unknown) => void>,
  terminalHost: {
    terminals: new Map(),
  },
  terminalResolveCwd: undefined as undefined | ((requestedCwd?: string) => string),
  inspectorListeners: [] as Array<(entry: unknown) => void>,
}));

vi.mock('@acp-kit/core', () => ({
  PermissionDecision: { AllowAlways: 'allow-always' },
  createAcpRuntime: mocks.createAcpRuntime,
  createRuntimeInspector: vi.fn(() => ({
    onEntry: vi.fn((listener: (entry: unknown) => void) => {
      mocks.inspectorListeners.push(listener);
      return vi.fn();
    }),
    toJSONL: vi.fn(() => ''),
  })),
}));

vi.mock('@acp-kit/core/node', () => ({
  createLocalFileSystemHost: vi.fn(() => ({})),
  createLocalTerminalHost: vi.fn((options: { resolveCwd(requestedCwd?: string): string }) => {
    mocks.terminalResolveCwd = options.resolveCwd;
    return mocks.terminalHost;
  }),
  nodeChildProcessTransport: mocks.nodeChildProcessTransport,
}));

const { closeRole, openRole } = await import('../lib/runtime/role.mjs');
const { createAcpRuntime: mockedCreateAcpRuntime } = await import('@acp-kit/core');

function createFallbackSpawn() {
  return vi.fn((command: string, args: string[]) => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }));
}

describe('runtime role adapter', () => {
  beforeEach(() => {
    mocks.createAcpRuntime.mockReset();
    mocks.nodeChildProcessTransport.mockClear();
    mocks.runtime.newSession.mockReset();
    mocks.runtime.loadSession.mockReset();
    mocks.runtime.shutdown.mockReset();
    mocks.session.setMode.mockReset();
    mocks.session.setModel.mockReset();
    mocks.session.transcript = { session: { models: { availableModels: [{ id: 'good-model' }] } } };
    mocks.session.close.mockReset();
    mocks.session.dispose.mockReset();
    mocks.terminalHost.terminals = new Map();
    mocks.terminalResolveCwd = undefined;
    mocks.inspectorListeners.length = 0;
    mocks.sessionUsageListeners.length = 0;
    mocks.sessionPlanListeners.length = 0;
    mocks.session.on.mockReset();
    mocks.session.on.mockImplementation((type: string, listener: (event: unknown) => void) => {
      if (type === 'session.usage.updated') {
        mocks.sessionUsageListeners.push(listener);
      }
      if (type === 'session.plan.updated') {
        mocks.sessionPlanListeners.push(listener);
      }
      return () => {};
    });
    mocks.createAcpRuntime.mockReturnValue(mocks.runtime);
    mocks.runtime.newSession.mockResolvedValue(mocks.session);
    mocks.runtime.loadSession.mockResolvedValue(mocks.session);
    mocks.session.setMode.mockResolvedValue(undefined);
    mocks.runtime.shutdown.mockResolvedValue(undefined);
    mocks.session.close.mockResolvedValue(undefined);
    mocks.session.dispose.mockResolvedValue(undefined);
  });


  it('smoke-tests the runtime fallback path from this package for globally installed startup resolution', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-runtime-fallback-'));
    const fakeBinDir = path.join(tempRoot, 'fake-bin');
    const originalPath = process.env.PATH;
    try {
      fs.mkdirSync(fakeBinDir, { recursive: true });
      const fakeNpx = path.join(fakeBinDir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
      fs.writeFileSync(fakeNpx, process.platform === 'win32' ? '@echo off\r\n' : '#!/usr/bin/env node\n', 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(fakeNpx, 0o755);
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ''}`;

      const spawnProcess = createFallbackSpawn();
      const { createAcpRuntime } = await vi.importActual<typeof import('@acp-kit/core')>('@acp-kit/core');
      const runtime = createAcpRuntime({
        agent: {
          id: 'spar-runtime-fallback',
          displayName: 'Spar Runtime Fallback',
          command: 'missing-acp-agent',
          args: [],
          fallbackCommands: [{ command: 'npx', args: ['--yes', '@example/never-installed-missing-acp-agent@latest'] }],
        },
        cwd: tempRoot,
        host: {},
        spawnProcess,
        connectionFactory: {
          create() {
            return {
              initialize: async () => ({ authMethods: [] }),
              newSession: async () => ({ sessionId: 'spar-runtime-fallback-session' }),
              prompt: async () => ({ stopReason: 'end_turn' }),
              cancel: async () => undefined,
              dispose: async () => undefined,
            } as never;
          },
        },
      });

      const session = await runtime.newSession();
      expect(session.sessionId).toBe('spar-runtime-fallback-session');
      expect(spawnProcess).toHaveBeenCalled();
      expect(spawnProcess.mock.calls[0]?.[0]).toBe(fakeNpx);
      expect(spawnProcess.mock.calls[0]?.[1]).toEqual(['--yes', '@example/never-installed-missing-acp-agent@latest']);
      await runtime.shutdown();
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15000);
  it('uses login-shell transport on non-Windows hosts so global installs resolve ACP like npx', async () => {
    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.nodeChildProcessTransport).toHaveBeenCalledWith({
      useLoginShell: process.platform !== 'win32',
    });
    expect(mocks.createAcpRuntime.mock.calls[0]?.[0]?.transport).toEqual({
      kind: 'transport',
      options: { useLoginShell: process.platform !== 'win32' },
    });

    await state.close();
  });


  it('sets Claude Code sessions to real-workspace mode before setting the model', async () => {
    const onRoleStatus = vi.fn();
    mocks.session.transcript = {
      session: {
        models: { availableModels: [{ id: 'good-model' }] },
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'bypassPermissions', name: 'Bypass Permissions' },
          ],
        },
      },
    };

    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: { onRoleStatus },
      settings: {
        agent: { id: 'claude-code', displayName: 'Claude Code', command: 'claude-code-acp', args: [] },
        model: 'good-model',
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.session.setMode).toHaveBeenCalledWith('bypassPermissions');
    expect(mocks.session.setMode.mock.invocationCallOrder[0]).toBeLessThan(mocks.session.setModel.mock.invocationCallOrder[0]);
    expect(onRoleStatus).toHaveBeenCalledWith({ role: 'AUTHOR', message: 'session ready, setting real-workspace mode bypassPermissions...' });

    await state.close();
  });

  it('fails fast when Claude Code does not expose the required real-workspace mode', async () => {
    mocks.session.transcript = {
      session: {
        models: { availableModels: [{ id: 'good-model' }] },
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default', name: 'Default' }],
        },
      },
    };

    await expect(openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { id: 'claude-code', displayName: 'Claude Code', command: 'claude-code-acp', args: [] },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    })).rejects.toThrow('cannot be forced into real-workspace mode "bypassPermissions"');

    expect(mocks.session.setMode).not.toHaveBeenCalled();
    expect(mocks.session.close).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it('resumes a saved ACP session when recovery metadata provides a session id', async () => {
    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      recovery: { sessionId: 'saved-session', turnsOnActiveSession: 3 },
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.runtime.loadSession).toHaveBeenCalledWith({ sessionId: 'saved-session', cwd: path.resolve(process.cwd()) });
    expect(mocks.runtime.newSession).not.toHaveBeenCalled();
    expect(state.recovery).toMatchObject({ resumed: true, requestedSessionId: 'saved-session', turnsOnActiveSession: 3 });

    await state.close();
  });

  it('falls back to a fresh ACP session when a saved session cannot be resumed', async () => {
    const onRoleStatus = vi.fn();
    mocks.runtime.loadSession.mockRejectedValueOnce(new Error('session not found'));

    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: { onRoleStatus },
      recovery: { sessionId: 'stale-session', turnsOnActiveSession: 9 },
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.runtime.loadSession).toHaveBeenCalledWith({ sessionId: 'stale-session', cwd: path.resolve(process.cwd()) });
    expect(mocks.runtime.newSession).toHaveBeenCalledWith({ cwd: path.resolve(process.cwd()) });
    expect(onRoleStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'saved session unavailable, starting fresh...' }));
    expect(state.recovery).toMatchObject({ resumed: false, requestedSessionId: 'stale-session', turnsOnActiveSession: 0 });

    await state.close();
  });

  it('closes a created session before force-killing remaining terminals when model setup fails', async () => {
    const child = { killed: false, kill: vi.fn() };
    mocks.terminalHost.terminals.set('child', child);

    await expect(openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: 'bad-model',
        modelEnvName: 'AUTHOR_MODEL',
      },
    })).rejects.toThrow('bad-model');

    expect(mocks.session.close).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.kill.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.runtime.shutdown.mock.invocationCallOrder[0]);
    expect(mocks.session.dispose).not.toHaveBeenCalled();
  });

  it('surfaces cleanup failure alongside the original startup failure', async () => {
    mocks.session.close.mockRejectedValueOnce(new Error('cleanup failed while closing session'));

    const thrown = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: 'bad-model',
        modelEnvName: 'AUTHOR_MODEL',
      },
    }).catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Role startup failed and cleanup also failed.');
    expect(thrown.errors.map((error: Error) => error.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('bad-model'),
      'cleanup failed while closing session',
    ]));
  });

  it('reports ACP session.usage.updated events to the renderer while the role is open', async () => {
    const onUsageUpdate = vi.fn();

    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: true,
      renderer: { onUsageUpdate },
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.sessionUsageListeners.length).toBe(1);
    mocks.sessionUsageListeners[0]?.({
      type: 'session.usage.updated',
      used: 1234,
      size: 200_000,
      cost: 0.05,
    });

    expect(onUsageUpdate).toHaveBeenCalledWith({
      role: 'AUTHOR',
      usage: expect.objectContaining({ used: 1234, size: 200_000, cost: 0.05 }),
    });

    onUsageUpdate.mockClear();
    mocks.sessionUsageListeners[0]?.({
      type: 'session.usage.updated',
      inputTokens: 5,
      cost: null,
    });

    expect(onUsageUpdate.mock.calls[0]?.[0].usage).toMatchObject({ inputTokens: 5 });
    expect(onUsageUpdate.mock.calls[0]?.[0].usage.cost).toBeUndefined();

    await state.close();
  });

  it('maps startup observer phases to concise role status updates', async () => {
    const onRoleStatus = vi.fn();

    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: { onRoleStatus },
      settings: {
        agent: { id: 'author', displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    const startupObserver = mocks.createAcpRuntime.mock.calls[0]?.[0]?.startupObserver;
    startupObserver.mark({ phase: 'adapter process spawn begin', detail: {} });
    startupObserver.mark({ phase: 'ACP initialize begin', detail: {} });
    startupObserver.mark({ phase: 'newSession begin', detail: {} });

    expect(onRoleStatus).toHaveBeenCalledWith({ role: 'AUTHOR', message: 'spawning...' });
    expect(onRoleStatus).toHaveBeenCalledWith({ role: 'AUTHOR', message: 'handshaking...' });
    expect(onRoleStatus).toHaveBeenCalledWith({ role: 'AUTHOR', message: 'new session...' });

    await state.close();
  });

  it('deduplicates repeated startup phases that map to the same role status message', async () => {
    const onRoleStatus = vi.fn();

    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: { onRoleStatus },
      settings: {
        agent: { id: 'author', displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    onRoleStatus.mockClear();
    const startupObserver = mocks.createAcpRuntime.mock.calls[0]?.[0]?.startupObserver;
    startupObserver.mark({ phase: 'ACP connect begin', detail: {} });
    startupObserver.mark({ phase: 'ACP initialize begin', detail: {} });
    startupObserver.mark({ phase: 'ACP initialize begin', detail: {} });

    expect(onRoleStatus.mock.calls).toEqual([
      [{ role: 'AUTHOR', message: 'handshaking...' }],
    ]);

    await state.close();
  });

  it('rejects terminal cwd paths outside the workspace root', async () => {
    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.terminalResolveCwd?.('subdir')).toBe(path.resolve(process.cwd(), 'subdir'));
    expect(() => mocks.terminalResolveCwd?.('..')).toThrow('escapes workspace root');

    if (process.platform === 'win32') {
      const currentDrive = path.parse(process.cwd()).root.toLowerCase();
      const otherDrive = currentDrive.startsWith('c:') ? 'D:\\outside' : 'C:\\outside';
      expect(() => mocks.terminalResolveCwd?.(otherDrive)).toThrow('escapes workspace root');
    }

    await state.close();
  });

  it('opens ACP sessions with an absolute workspace cwd', async () => {
    const cwd = process.cwd();

    const state = await openRole({
      role: 'AUTHOR',
      cwd,
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.runtime.newSession).toHaveBeenCalledWith({ cwd: path.resolve(cwd) });
    await state.close();
  });

  it('forwards ACP session.plan.updated events to the renderer while the role is open', async () => {
    const onPlanUpdate = vi.fn();

    const state = await openRole({
      role: 'REVIEWER',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: { onPlanUpdate },
      settings: {
        agent: { displayName: 'Reviewer', command: 'reviewer' },
        model: null,
        modelEnvName: 'REVIEWER_MODEL',
      },
    });

    expect(mocks.sessionPlanListeners.length).toBe(1);
    const entries = [
      { content: 'Step A', priority: 'high', status: 'in_progress' },
      { content: 'Step B', priority: 'medium', status: 'pending' },
    ];
    mocks.sessionPlanListeners[0]?.({ type: 'session.plan.updated', entries });
    expect(onPlanUpdate).toHaveBeenCalledWith({ role: 'REVIEWER', entries });

    // A subsequent close must not re-emit, and a malformed (non-array) entries
    // payload should still produce an empty entries list rather than throwing.
    onPlanUpdate.mockClear();
    mocks.sessionPlanListeners[0]?.({ type: 'session.plan.updated' });
    expect(onPlanUpdate).toHaveBeenCalledWith({ role: 'REVIEWER', entries: [] });

    await state.close();
  });

  it('surfaces cleanup failures when closing a real role state', async () => {
    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });
    mocks.session.close.mockRejectedValueOnce(new Error('disk full while persisting transcript'));

    const thrown = await closeRole(state).catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Failed to clean up ACP role resources.');
    expect(thrown.errors.map((error: Error) => error.message)).toContain('disk full while persisting transcript');
    expect(mocks.runtime.shutdown).toHaveBeenCalledTimes(1);
  });
});
