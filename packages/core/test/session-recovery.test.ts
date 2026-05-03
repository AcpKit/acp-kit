import { describe, expect, it, vi } from 'vitest';

import { isMissingAcpSessionError, openOrCreateRuntimeSession } from '../src/index.js';

describe('session recovery helpers', () => {
  it('opens a new session when no saved session id is provided', async () => {
    const runtime = fakeRuntime();

    const result = await openOrCreateRuntimeSession({ runtime, cwd: '/repo' });

    expect(result).toMatchObject({ resumed: false, requestedSessionId: null });
    expect(result.session).toEqual({ sessionId: 'fresh-session' });
    expect(runtime.newSession).toHaveBeenCalledWith({ cwd: '/repo' });
    expect(runtime.loadSession).not.toHaveBeenCalled();
  });

  it('resumes a saved session id when loadSession succeeds', async () => {
    const runtime = fakeRuntime({ loadedSession: { sessionId: 'saved-session' } });
    const onStatus = vi.fn();

    const result = await openOrCreateRuntimeSession({ runtime, cwd: '/repo', sessionId: ' saved-session ', onStatus });

    expect(result).toMatchObject({ resumed: true, requestedSessionId: 'saved-session' });
    expect(result.session).toEqual({ sessionId: 'saved-session' });
    expect(runtime.loadSession).toHaveBeenCalledWith({ cwd: '/repo', sessionId: 'saved-session' });
    expect(runtime.newSession).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith('resuming saved session saved-session...');
  });

  it('falls back to a fresh session only for clearly missing saved sessions', async () => {
    const error = new Error('resume failed');
    Object.assign(error, { status: 404 });
    const runtime = fakeRuntime({ loadError: error });
    const onStatus = vi.fn();

    const result = await openOrCreateRuntimeSession({ runtime, cwd: '/repo', sessionId: 'gone-session', onStatus });

    expect(result).toMatchObject({ resumed: false, requestedSessionId: 'gone-session' });
    expect(result.session).toEqual({ sessionId: 'fresh-session' });
    expect(runtime.newSession).toHaveBeenCalledWith({ cwd: '/repo' });
    expect(onStatus).toHaveBeenCalledWith('saved session unavailable, starting fresh...');
  });

  it('surfaces transport and service failures instead of discarding recovery', async () => {
    for (const error of [
      Object.assign(new Error('ACP backend unavailable'), { status: 503 }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4317'), { code: 'ECONNREFUSED' }),
      new Error('ACP session/load timed out during high latency startup'),
    ]) {
      const runtime = fakeRuntime({ loadError: error });

      await expect(openOrCreateRuntimeSession({ runtime, cwd: '/repo', sessionId: 'saved-session' })).rejects.toThrow(error.message);
      expect(runtime.newSession).not.toHaveBeenCalled();
    }
  });

  it('classifies nested stale-session causes without misclassifying live failures', () => {
    const missing = new Error('wrapped resume failure');
    missing.cause = { reason: { detail: new Error('unknown session') } };
    const timeout = new Error('wrapped resume failure');
    timeout.cause = { reason: { detail: new Error('transport timeout after session/load request') } };

    expect(isMissingAcpSessionError(missing)).toBe(true);
    expect(isMissingAcpSessionError(timeout)).toBe(false);
  });
});

function fakeRuntime({ loadedSession = { sessionId: 'loaded-session' }, loadError = null } = {}) {
  return {
    newSession: vi.fn().mockResolvedValue({ sessionId: 'fresh-session' }),
    loadSession: vi.fn(async () => {
      if (loadError) throw loadError;
      return loadedSession;
    }),
  } as never;
}
