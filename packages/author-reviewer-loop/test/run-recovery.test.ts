import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInitialRunRecoveryState,
  createRunRecoveryId,
  createRunRecoveryStore,
  normalizeLoadedRunRecovery,
  runRecoveryDirectory,
  runRecoveryEnabled,
  runRecoveryFilePath,
} from '../lib/runtime/run-recovery.mjs';

function config() {
  return {
    cwd: '/workspace/project',
    task: 'Implement restart-safe run recovery',
    quality: 'prod',
    maxRounds: 3,
    maxApprovalContinuations: 2,
    authorSettings: {
      agent: { id: 'codex' },
      model: 'gpt-5.5',
      sessionTurns: 5,
    },
    reviewerSettings: {
      agent: { id: 'copilot' },
      model: 'gpt-5.4',
      sessionTurns: 7,
    },
  };
}

describe('Spar run recovery persistence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores recovery files under the ACP Kit Spar directory', () => {
    const cfg = config();
    const recoveryId = createRunRecoveryId({ config: cfg });

    expect(runRecoveryDirectory({ home: '/tmp/spar-home' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'run-recovery'));
    expect(runRecoveryFilePath({ home: '/tmp/spar-home', config: cfg, recoveryId })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'run-recovery', `${recoveryId}.json`));
  });

  it('defaults off under Vitest unless explicitly enabled', () => {
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('SPAR_RUN_RECOVERY', '');
    expect(runRecoveryEnabled()).toBe(false);

    vi.stubEnv('SPAR_RUN_RECOVERY', '1');
    expect(runRecoveryEnabled()).toBe(true);

    vi.stubEnv('SPAR_RUN_RECOVERY', 'off');
    expect(runRecoveryEnabled()).toBe(false);
  });

  it('writes and loads a recovery checkpoint with pending reviewer state', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-run-recovery-'));
    const cfg = config();
    const store = createRunRecoveryStore({ enabled: true, home, config: cfg });
    const state = createInitialRunRecoveryState(cfg);
    state.roles = {
      AUTHOR: { sessionId: 'author-session', turnsOnActiveSession: 2 },
      REVIEWER: { sessionId: 'reviewer-session', turnsOnActiveSession: 1 },
    };
    state.loop.feedback = '1. Verify restart recovery.';
    state.loop.pending = {
      type: 'reviewer-turn',
      round: 2,
      started: true,
      authorReply: 'Implemented restart-safe persistence and tests.',
    };

    expect(store.write(state)).toBe(true);

    const loaded = store.load();
    expect(loaded).toMatchObject({
      roles: {
        AUTHOR: { sessionId: 'author-session', turnsOnActiveSession: 2 },
        REVIEWER: { sessionId: 'reviewer-session', turnsOnActiveSession: 1 },
      },
      loop: {
        feedback: '1. Verify restart recovery.',
        pending: {
          type: 'reviewer-turn',
          round: 2,
          started: true,
          authorReply: 'Implemented restart-safe persistence and tests.',
        },
      },
    });
  });

  it('quarantines malformed recovery files instead of blocking a fresh run', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-run-recovery-bad-'));
    const cfg = config();
    const filePath = runRecoveryFilePath({ home, config: cfg });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{bad json', 'utf8');

    const store = createRunRecoveryStore({ enabled: true, home, config: cfg });

    expect(store.load()).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.corrupt-'))).toBe(true);
  });

  it('rejects recovery files for a different config fingerprint', () => {
    const cfg = config();
    const state = createInitialRunRecoveryState(cfg);
    const other = { ...cfg, task: 'Different task' };

    expect(normalizeLoadedRunRecovery(state, { config: other })).toBeNull();
  });

  it('rejects recovery files from a different quality mode', () => {
    const cfg = config();
    const state = createInitialRunRecoveryState(cfg);

    expect(normalizeLoadedRunRecovery(state, { config: { ...cfg, quality: 'dev' } })).toBeNull();
  });

  it('disables further persistence after a write failure instead of crashing the run', () => {
    const writeFileSync = vi.fn(() => {
      throw new Error('ENOSPC: recovery disk full');
    });
    const store = createRunRecoveryStore({
      enabled: true,
      config: config(),
      filePath: path.join(os.tmpdir(), `spar-recovery-${Date.now()}.json`),
      writeFileSync,
    });

    expect(store.write(createInitialRunRecoveryState(config()))).toBe(false);
    expect(store.enabled).toBe(false);
    expect(store.write(createInitialRunRecoveryState(config()))).toBe(false);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });
});
