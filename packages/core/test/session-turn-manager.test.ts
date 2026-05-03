import { describe, expect, it, vi } from 'vitest';

import { createSessionTurnManager, normalizeSessionTurnLimit } from '../src/index.js';

describe('session turn manager', () => {
  it('uses the initial state once and tracks recovery snapshots', async () => {
    const initial = state('initial', 2);
    const open = vi.fn(async () => state('fresh'));
    const manager = createSessionTurnManager({
      getInitial: vi.fn(async () => initial),
      open,
      maxTurns: 5,
      getSessionId: (item) => item.session.sessionId,
    });

    expect(await manager.getForTurn()).toBe(initial);
    expect(open).not.toHaveBeenCalled();
    expect(manager.getRecoverySnapshot()).toEqual({ sessionId: 'initial', turnsOnActiveSession: 3 });
  });

  it('refreshes after the configured turn budget is exhausted', async () => {
    const close = vi.fn();
    const onRefresh = vi.fn();
    const opened = [state('fresh-1'), state('fresh-2')];
    const manager = createSessionTurnManager({
      open: vi.fn(async () => opened.shift()!),
      close,
      maxTurns: 1,
      onRefresh,
    });

    const first = await manager.getForTurn();
    const second = await manager.getForTurn();

    expect(first.session.sessionId).toBe('fresh-1');
    expect(second.session.sessionId).toBe('fresh-2');
    expect(close).toHaveBeenCalledWith(first);
    expect(onRefresh).toHaveBeenCalledWith({ turnLimit: 1, previous: first });
    expect(manager.getStarted().map((item) => item.session.sessionId)).toEqual(['fresh-1', 'fresh-2']);
  });

  it('recovers for retry with a fresh state and one consumed turn', async () => {
    const close = vi.fn();
    const onRecover = vi.fn();
    const opened = [state('fresh-1'), state('retry')];
    const manager = createSessionTurnManager({
      open: vi.fn(async () => opened.shift()!),
      close,
      onRecover,
    });

    const first = await manager.getForTurn();
    const retry = await manager.recoverForRetry();

    expect(retry.session.sessionId).toBe('retry');
    expect(close).toHaveBeenCalledWith(first);
    expect(onRecover).toHaveBeenCalledWith({ previous: first });
    expect(manager.getRecoverySnapshot()).toEqual({ sessionId: 'retry', turnsOnActiveSession: 1 });
  });

  it('reports close errors without blocking a replacement state', async () => {
    const closeError = new Error('close failed');
    const onCloseError = vi.fn();
    const opened = [state('fresh-1'), state('fresh-2')];
    const manager = createSessionTurnManager({
      open: vi.fn(async () => opened.shift()!),
      close: vi.fn(async () => { throw closeError; }),
      maxTurns: 1,
      onCloseError,
    });

    const first = await manager.getForTurn();
    const second = await manager.getForTurn();

    expect(second.session.sessionId).toBe('fresh-2');
    expect(onCloseError).toHaveBeenCalledWith(closeError, first);
  });

  it('normalizes invalid turn budgets to the default', () => {
    expect(normalizeSessionTurnLimit(3)).toBe(3);
    expect(normalizeSessionTurnLimit(0)).toBe(20);
    expect(normalizeSessionTurnLimit('3')).toBe(20);
  });
});

function state(sessionId: string, turnsOnActiveSession = 0) {
  return {
    session: { sessionId },
    recovery: { turnsOnActiveSession },
  };
}
