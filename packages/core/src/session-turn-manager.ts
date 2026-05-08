export interface SessionTurnManagerOptions<TState> {
  open: () => Promise<TState>;
  close?: (state: TState | null) => Promise<void> | void;
  getInitial?: () => Promise<TState>;
  maxTurns?: number;
  recovery?: { turnsOnActiveSession?: unknown } | null;
  getSessionId?: (state: TState) => string | null | undefined;
  onRefresh?: (event: { turnLimit: number; previous: TState | null }) => void;
  onRecover?: (event: { previous: TState | null }) => void;
  onCloseError?: (error: unknown, state: TState | null) => void;
}

export interface SessionTurnManager<TState> {
  getForTurn(): Promise<TState>;
  recoverForRetry(): Promise<TState>;
  refreshNow(): Promise<TState>;
  getActive(): TState | null;
  getStarted(): TState[];
  getRecoverySnapshot(): { sessionId: string; turnsOnActiveSession: number } | null;
}

export function createSessionTurnManager<TState>(options: SessionTurnManagerOptions<TState>): SessionTurnManager<TState> {
  const turnLimit = normalizeSessionTurnLimit(options.maxTurns);
  const started = new Set<TState>();
  let active: TState | null = null;
  let initialConsumed = false;
  let turnsOnActiveSession = 0;

  async function openFresh(): Promise<TState> {
    const state = await options.open();
    started.add(state);
    return state;
  }

  async function ensureActive(): Promise<TState> {
    if (active) return active;
    active = initialConsumed || !options.getInitial ? await openFresh() : await options.getInitial();
    initialConsumed = true;
    started.add(active);
    turnsOnActiveSession = Math.max(
      0,
      readTurnsOnActiveSession(active) || readTurnsOnActiveSession(options.recovery) || 0,
    );
    return active;
  }

  async function closePrevious(previous: TState | null): Promise<void> {
    if (!previous || !options.close) return;
    try {
      await options.close(previous);
    } catch (error) {
      options.onCloseError?.(error, previous);
    }
  }

  async function refresh(): Promise<void> {
    const previous = active;
    active = null;
    options.onRefresh?.({ turnLimit, previous });
    await closePrevious(previous);
    active = await openFresh();
    turnsOnActiveSession = 0;
  }

  async function recoverForRetry(): Promise<TState> {
    const previous = active;
    active = null;
    options.onRecover?.({ previous });
    await closePrevious(previous);
    active = await openFresh();
    turnsOnActiveSession = 1;
    return active;
  }

  return {
    async getForTurn() {
      await ensureActive();
      if (turnsOnActiveSession >= turnLimit) await refresh();
      turnsOnActiveSession += 1;
      return active as TState;
    },
    recoverForRetry,
    async refreshNow() {
      await refresh();
      return active as TState;
    },
    getActive() {
      return active;
    },
    getStarted() {
      return Array.from(started);
    },
    getRecoverySnapshot() {
      if (!active) return null;
      const sessionId = options.getSessionId?.(active) ?? readSessionId(active);
      if (!sessionId) return null;
      return { sessionId, turnsOnActiveSession };
    },
  };
}

export function normalizeSessionTurnLimit(value: unknown): number {
  if (Number.isInteger(value) && Number(value) >= 1) return Number(value);
  return 20;
}

function readTurnsOnActiveSession(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const candidate = (value as { recovery?: { turnsOnActiveSession?: unknown }; turnsOnActiveSession?: unknown }).recovery?.turnsOnActiveSession
    ?? (value as { turnsOnActiveSession?: unknown }).turnsOnActiveSession;
  const number = Number(candidate);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function readSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const sessionId = (value as { session?: { sessionId?: unknown }; sessionId?: unknown }).session?.sessionId
    ?? (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null;
}
