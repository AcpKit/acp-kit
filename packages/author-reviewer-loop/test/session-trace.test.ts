import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionTraceId,
  createSessionTraceRecorder,
  formatSessionTraceEntry,
  sessionTraceDirectory,
  sessionTraceFilePath,
  sessionTracingEnabled,
  sparDataDir,
} from '../lib/runtime/session-trace.mjs';

describe('Spar session trace persistence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores session traces under the ACP Kit Spar directory', () => {
    expect(sparDataDir({ home: '/tmp/spar-home' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar'));
    expect(sessionTraceDirectory({ home: '/tmp/spar-home' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'traces'));
    expect(sessionTraceFilePath({ home: '/tmp/spar-home', sessionId: 'session-1' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'traces', 'session-1.jsonl'));
  });

  it('creates stable timestamped session ids without path separators', () => {
    const id = createSessionTraceId({ now: () => Date.UTC(2026, 4, 2, 3, 4, 5, 6), random: () => 0.5, pid: 42 });

    expect(id).toBe('2026-05-02T03-04-05-006Z-42-800000');
    expect(id).not.toContain(path.sep);
  });

  it('defaults off under Vitest unless explicitly enabled', () => {
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('SPAR_SESSION_TRACE', '');
    expect(sessionTracingEnabled()).toBe(false);

    vi.stubEnv('SPAR_SESSION_TRACE', '1');
    expect(sessionTracingEnabled()).toBe(true);

    vi.stubEnv('SPAR_SESSION_TRACE', 'off');
    expect(sessionTracingEnabled()).toBe(false);
  });

  it('writes a complete JSONL session with start, events, and end', () => {
    const lines: string[] = [];
    const recorder = createSessionTraceRecorder({
      enabled: true,
      cwd: '/workspace/project',
      sessionId: 'session-1',
      now: (() => {
        let at = 1000;
        return () => at += 5;
      })(),
      config: {
        cwd: '/workspace/project',
        maxRounds: 2,
        trace: false,
        tui: true,
        authorSettings: { agent: { id: 'codex', displayName: 'Codex' }, model: 'gpt-5.5', sessionTurns: 20 },
        reviewerSettings: { agent: { id: 'copilot', displayName: 'Copilot' }, model: 'gpt-5.4', sessionTurns: 10 },
      },
      writeLine: (line) => lines.push(line),
    });

    recorder.record('event', {
      event: { type: 'traceEntry', role: 'AUTHOR', entry: { direction: 'sent', frame: '{"jsonrpc":"2.0"}' } },
      action: { type: 'traceEntry', traceId: 1 },
    });
    recorder.close({ status: 'completed', result: { approved: true, rounds: 1 } });

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.type)).toEqual(['sessionStart', 'event', 'sessionEnd']);
    expect(entries[0]).toMatchObject({ sessionId: 'session-1', cwd: '/workspace/project', config: { tui: true, author: { agent: 'codex' } } });
    expect(entries[1]).toMatchObject({ event: { type: 'traceEntry', role: 'AUTHOR' }, action: { traceId: 1 } });
    expect(entries[2]).toMatchObject({ status: 'completed', result: { approved: true, rounds: 1 } });
  });

  it('writes JSONL trace files and creates parent directories', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-session-trace-'));
    const recorder = createSessionTraceRecorder({
      enabled: true,
      home,
      sessionId: 'session-file',
      cwd: '/workspace/project',
      config: { cwd: '/workspace/project' },
    });

    recorder.record('event', { event: { type: 'launching' } });
    recorder.close({ status: 'completed' });

    const filePath = sessionTraceFilePath({ home, sessionId: 'session-file' });
    const entries = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.type)).toEqual(['sessionStart', 'event', 'sessionEnd']);
  });

  it('bounds oversized trace entries instead of writing unbounded JSON', () => {
    const line = formatSessionTraceEntry({
      type: 'event',
      sessionId: 'session-1',
      at: 1,
      event: { type: 'traceEntry', frame: 'x'.repeat(200) },
      action: { type: 'traceEntry' },
    }, { maxEntryBytes: 120 });

    const entry = JSON.parse(line);
    expect(entry).toMatchObject({
      type: 'event',
      sessionId: 'session-1',
      omitted: true,
      eventType: 'traceEntry',
      actionType: 'traceEntry',
    });
    expect(entry.originalBytes).toBeGreaterThan(120);
  });

  it('swallows writer failures because tracing is diagnostic-only', () => {
    const recorder = createSessionTraceRecorder({
      enabled: true,
      sessionId: 'session-1',
      writeLine: () => { throw new Error('disk full'); },
    });

    expect(() => recorder.record('event', { event: { type: 'launching' } })).not.toThrow();
    expect(() => recorder.close({ status: 'failed' })).not.toThrow();
  });
});
