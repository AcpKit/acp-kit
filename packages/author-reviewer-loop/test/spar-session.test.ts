import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSparSessionRecord,
  createSparSessionStore,
  sparSessionDirectory,
  sparSessionFilePath,
  sparSessionRecordingEnabled,
} from '../lib/runtime/spar-session.mjs';

function config() {
  return {
    cwd: '/workspace/project',
    task: 'Implement a focused change',
    taskSource: { kind: 'text' },
    quality: 'dev',
    maxRounds: 3,
    maxApprovalContinuations: 1,
    authorSettings: {
      agent: { id: 'codex-cli', displayName: 'Codex CLI' },
      model: 'gpt-5.5',
      sessionTurns: 5,
    },
    reviewerSettings: {
      agent: { id: 'github-copilot', displayName: 'GitHub Copilot' },
      model: 'gpt-5.4',
      sessionTurns: 7,
    },
  };
}

describe('Spar session lifecycle records', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores Spar session records separately from run recovery checkpoints', () => {
    expect(sparSessionDirectory({ home: '/tmp/spar-home' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'sessions'));
    expect(sparSessionFilePath({ home: '/tmp/spar-home', sparSessionId: 'spar-session-1' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'sessions', 'spar-session-1.json'));
  });

  it('defaults off under Vitest unless explicitly enabled', () => {
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('SPAR_SESSION_RECORD', '');
    expect(sparSessionRecordingEnabled()).toBe(false);

    vi.stubEnv('SPAR_SESSION_RECORD', '1');
    expect(sparSessionRecordingEnabled()).toBe(true);

    vi.stubEnv('SPAR_SESSION_RECORD', 'off');
    expect(sparSessionRecordingEnabled()).toBe(false);
  });

  it('summarizes one Spar run lifecycle without ACP role session ambiguity', () => {
    const record = createSparSessionRecord({ config: config(), sparSessionId: 'spar-session-1', now: () => 10 });

    expect(record).toMatchObject({
      sparSessionId: 'spar-session-1',
      status: 'running',
      createdAt: 10,
      updatedAt: 10,
      cwd: path.resolve('/workspace/project'),
      task: 'Implement a focused change',
      quality: 'dev',
      author: { agent: 'codex-cli', agentName: 'Codex CLI', model: 'gpt-5.5', sessionTurns: 5 },
      reviewer: { agent: 'github-copilot', agentName: 'GitHub Copilot', model: 'gpt-5.4', sessionTurns: 7 },
    });
  });

  it('writes running and completed status updates', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-session-record-'));
    const store = createSparSessionStore({ enabled: true, home, config: config(), sparSessionId: 'spar-session-1', now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20) });

    store.start();
    store.complete({ approved: true, rounds: 1 });

    const filePath = sparSessionFilePath({ home, sparSessionId: 'spar-session-1' });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written).toMatchObject({
      sparSessionId: 'spar-session-1',
      status: 'completed',
      createdAt: 10,
      updatedAt: 20,
      result: { approved: true, rounds: 1 },
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
