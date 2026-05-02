import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunTraceId,
  createRunTraceRecorder,
  formatRunTraceEntry,
  runTraceDirectory,
  runTraceFilePath,
  runTraceEnabled,
  sparDataDir,
} from '../lib/runtime/run-trace.mjs';

describe('Spar run trace persistence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores run traces under the ACP Kit Spar directory', () => {
    expect(sparDataDir({ home: '/tmp/spar-home' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar'));
    expect(runTraceDirectory({ home: '/tmp/spar-home' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'run-traces'));
    expect(runTraceFilePath({ home: '/tmp/spar-home', runTraceId: 'run-trace-1' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'run-traces', 'run-trace-1.jsonl'));
  });

  it('creates stable timestamped run trace ids without path separators', () => {
    const id = createRunTraceId({ now: () => Date.UTC(2026, 4, 2, 3, 4, 5, 6), random: () => 0.5, pid: 42 });

    expect(id).toBe('2026-05-02T03-04-05-006Z-42-800000');
    expect(id).not.toContain(path.sep);
  });

  it('defaults off under Vitest unless explicitly enabled', () => {
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('SPAR_RUN_TRACE', '');
    expect(runTraceEnabled()).toBe(false);

    vi.stubEnv('SPAR_RUN_TRACE', '1');
    expect(runTraceEnabled()).toBe(true);

    vi.stubEnv('SPAR_RUN_TRACE', 'off');
    expect(runTraceEnabled()).toBe(false);
  });

  it('writes a complete JSONL run trace with start, events, and end', () => {
    const lines: string[] = [];
    const recorder = createRunTraceRecorder({
      enabled: true,
      cwd: '/workspace/project',
      runTraceId: 'run-trace-1',
      now: (() => {
        let at = 1000;
        return () => at += 5;
      })(),
      config: {
        cwd: '/workspace/project',
        maxRounds: 2,
        trace: false,
        tui: true,
        authorSettings: { agent: { id: 'codex-cli', displayName: 'Codex' }, model: 'gpt-5.5', sessionTurns: 20 },
        reviewerSettings: { agent: { id: 'claude-code', displayName: 'Claude Code' }, model: 'opus', sessionTurns: 10 },
      },
      writeLine: (line) => lines.push(line),
    });

    recorder.record('event', {
      event: { type: 'traceEntry', role: 'AUTHOR', entry: { direction: 'sent', frame: '{"jsonrpc":"2.0"}' } },
      action: { type: 'traceEntry', traceId: 1 },
    });
    recorder.close({ status: 'completed', result: { approved: true, rounds: 1 } });

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.type)).toEqual(['runStart', 'event', 'runEnd']);
    expect(entries[0]).toMatchObject({
      runTraceId: 'run-trace-1',
      cwd: '/workspace/project',
      config: {
        tui: true,
        author: {
          agent: 'codex-cli',
          realWorkspace: { launchArgs: expect.arrayContaining(['sandbox_mode=\"danger-full-access\"']) },
        },
        reviewer: {
          agent: 'claude-code',
          realWorkspace: { env: { IS_SANDBOX: '1' }, sessionMode: 'bypassPermissions' },
        },
      },
    });
    expect(entries[1]).toMatchObject({ event: { type: 'traceEntry', role: 'AUTHOR' }, action: { traceId: 1 } });
    expect(entries[2]).toMatchObject({ status: 'completed', result: { approved: true, rounds: 1 } });
  });

  it('writes JSONL trace files and creates parent directories', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-run-trace-'));
    const recorder = createRunTraceRecorder({
      enabled: true,
      home,
      runTraceId: 'run-trace-file',
      cwd: '/workspace/project',
      config: { cwd: '/workspace/project' },
    });

    recorder.record('event', { event: { type: 'launching' } });
    recorder.close({ status: 'completed' });

    const filePath = runTraceFilePath({ home, runTraceId: 'run-trace-file' });
    const entries = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.type)).toEqual(['runStart', 'event', 'runEnd']);
  });

  it('bounds oversized trace entries instead of writing unbounded JSON', () => {
    const line = formatRunTraceEntry({
      type: 'event',
      runTraceId: 'run-trace-1',
      at: 1,
      event: { type: 'traceEntry', frame: 'x'.repeat(200) },
      action: { type: 'traceEntry' },
    }, { maxEntryBytes: 120 });

    const entry = JSON.parse(line);
    expect(entry).toMatchObject({
      type: 'event',
      runTraceId: 'run-trace-1',
      omitted: true,
      eventType: 'traceEntry',
      actionType: 'traceEntry',
    });
    expect(entry.originalBytes).toBeGreaterThan(120);
  });

  it('swallows writer failures because tracing is diagnostic-only', () => {
    const recorder = createRunTraceRecorder({
      enabled: true,
      runTraceId: 'run-trace-1',
      writeLine: () => { throw new Error('disk full'); },
    });

    expect(() => recorder.record('event', { event: { type: 'launching' } })).not.toThrow();
    expect(() => recorder.close({ status: 'failed' })).not.toThrow();
  });
});
