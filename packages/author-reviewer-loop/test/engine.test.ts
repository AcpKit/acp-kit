import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  openRole: vi.fn(),
  closeRole: vi.fn(),
  runTurn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: { mkdir: mocks.mkdir },
}));

vi.mock('../lib/runtime/role.mjs', () => ({
  openRole: mocks.openRole,
  closeRole: mocks.closeRole,
}));

vi.mock('../lib/runtime/turn.mjs', () => ({
  runTurn: mocks.runTurn,
}));

const { createLoopEngine } = await import('../lib/engine.mjs');
const { createRunRecoveryStore } = await import('../lib/runtime/run-recovery.mjs');

function config(maxRounds = 2) {
  return {
    cwd: process.cwd(),
    maxRounds,
    trace: false,
    tui: false,
    authorSettings: {
      agent: { id: 'author', displayName: 'Author', command: 'author', args: [] },
      model: null,
      prompt: ({ round, feedback }: { round: number; feedback: string }) => `author ${round} ${feedback}`,
    },
    reviewerSettings: {
      agent: { id: 'reviewer', displayName: 'Reviewer', command: 'reviewer', args: [] },
      model: null,
      prompt: ({ round }: { round: number }) => `reviewer ${round}`,
    },
  };
}

describe('author-reviewer-loop engine', () => {
  beforeEach(() => {
    mocks.mkdir.mockReset();
    mocks.openRole.mockReset();
    mocks.closeRole.mockReset();
    mocks.runTurn.mockReset();
    mocks.mkdir.mockResolvedValue(undefined);
  });

  it('reuses both role sessions until configured turn limits are reached', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) => {
      if (role === 'REVIEWER') return round === 1 ? '1. Fix this' : 'APPROVED';
      return '';
    });

    const result = await createLoopEngine({ config: config(3) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(mocks.openRole).toHaveBeenCalledTimes(2);
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR').map(([arg]) => arg.state);
    const reviewerTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER').map(([arg]) => arg.state);
    expect(authorTurns).toEqual([authorState, authorState]);
    expect(reviewerTurns).toEqual([reviewerState, reviewerState]);
  });

  it('refreshes author and reviewer sessions independently after their configured turn limits', async () => {
    const authorStates = [
      { role: 'AUTHOR', session: { id: 'author-run-trace-1' } },
      { role: 'AUTHOR', session: { id: 'author-session-2' } },
    ];
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-3' } },
    ];
    let authorIndex = 0;
    let reviewerIndex = 0;
    const cfg = config(3);
    cfg.authorSettings.sessionTurns = 2;
    cfg.reviewerSettings.sessionTurns = 1;
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorStates[authorIndex++]! : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? (round === 3 ? 'APPROVED' : '1. Keep going') : '',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({ approved: true, rounds: 3 });
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR').map(([arg]) => arg.state);
    const reviewerTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER').map(([arg]) => arg.state);
    expect(authorTurns).toEqual([authorStates[0], authorStates[0], authorStates[1]]);
    expect(reviewerTurns).toEqual([reviewerStates[0], reviewerStates[1], reviewerStates[2]]);
    expect(mocks.closeRole).toHaveBeenCalledWith(authorStates[0]);
    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerStates[0]);
  });

  it('only treats APPROVED on its own line as approval', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'NOT APPROVED: still broken' : '',
    );

    const result = await createLoopEngine({ config: config(1) }).run();

    expect(result).toMatchObject({
      approved: false,
      feedback: 'NOT APPROVED: still broken',
      rounds: 1,
    });
  });

  it('accepts same-line APPROVED verdicts with positive summaries and stops without another round', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED - restart recovery verified after rerun.' : 'implemented durable fix',
    );

    const result = await createLoopEngine({ config: config(3) }).run();

    expect(result).toMatchObject({
      approved: true,
      rounds: 1,
      feedback: 'APPROVED - restart recovery verified after rerun.',
    });
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
  });

  it('rejects same-line conditional APPROVED verdicts that still describe unresolved risk', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER'
        ? (round === 1
            ? 'APPROVED if you ignore the still-broken Linux startup path.'
            : 'APPROVED\nLinux startup verified after rerun.')
        : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('still-broken Linux startup path');
  });
  it('rejects approval-shaped reviewer hallucinations before accepting a standalone verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'The README says "APPROVED" but tests are failing.',
      '- APPROVED if you ignore the broken edge case.',
      'APPROVED\nAll production checks pass.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(3) }).run();

    expect(result).toMatchObject({
      approved: true,
      rounds: 3,
      feedback: 'APPROVED\nAll production checks pass.',
    });
    expect(mocks.runTurn).toHaveBeenCalledTimes(6);
  });

  it('treats contradictory APPROVED replies as not approved until the reviewer sends a clean verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\n1. Remaining issue: restart recovery is still broken.',
      'APPROVED\nRestart recovery verified after a clean rerun.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('treated as NOT APPROVED because it mixed APPROVED with conflicting issue text');
  });

  it('accepts APPROVED replies with clean negated issue summaries instead of looping unnecessarily', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    let reviewerIndex = 0;
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER'
        ? 'APPROVED\n- No remaining issues; restart recovery and tests pass.\n- Problems: none.'
        : 'implemented durable fix',
    );

    const result = await createLoopEngine({ config: config(3) }).run();

    expect(result).toMatchObject({
      approved: true,
      rounds: 1,
      feedback: expect.stringContaining('No remaining issues'),
    });
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
  });

  it('accepts clean issue-none summaries with trailing prose after APPROVED', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    let reviewerIndex = 0;
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER'
        ? 'APPROVED\nIssues: none. Everything looks solid after restart recovery verification.'
        : 'implemented durable fix',
    );

    const result = await createLoopEngine({ config: config(2) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
  });

  it('accepts ANSI-wrapped APPROVED verdicts after sanitizing terminal control output', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    let reviewerIndex = 0;
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? '\u001b[32mAPPROVED\u001b[0m\n\u200BNo remaining issues.' : 'implemented durable fix',
    );

    const result = await createLoopEngine({ config: config(2) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    expect(result.feedback).toBe('APPROVED\nNo remaining issues.');
  });

  it('accepts APPROVED verdicts wrapped in non-SGR terminal control sequences', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER'
        ? '\u001b[?25l\u001b]0;review complete\u001b\\APPROVED\u001b[?25h\nNo remaining issues.'
        : 'implemented durable fix',
    );

    const result = await createLoopEngine({ config: config(2) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    expect(result.feedback).toBe('APPROVED\nNo remaining issues.');
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
  });

  it('accepts mixed-case approved verdicts as tolerant LLM output when follow-up notes are clean', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'aPpRoVeD\nNo remaining issues after verification.' : 'implemented durable fix',
    );

    const result = await createLoopEngine({ config: config(2) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    expect(result.feedback).toBe('aPpRoVeD\nNo remaining issues after verification.');
  });

  it('accepts historical failure notes that are explicitly fixed and verified', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER'
        ? 'APPROVED\nPreviously failed on Windows after interruption, but now fixed and verified.'
        : 'implemented durable fix',
    );

    const result = await createLoopEngine({ config: config(2) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
  });

  it('rejects APPROVED replies that hide failures behind a negated opening phrase', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\nNo remaining issues, but the dependency conflict still crashes startup.',
      'APPROVED\nNo remaining issues; startup verified after dependency resolution.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : 'draft',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('dependency conflict still crashes startup');
    expect(secondAuthorPrompt).toContain('treated as NOT APPROVED because it mixed APPROVED with conflicting issue text');
  });

  it('treats prose contradictions after APPROVED as not approved until the reviewer sends a clean verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\nHowever, restart recovery still fails on Windows.',
      'APPROVED\nRestart recovery verified after a clean rerun.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('However, restart recovery still fails on Windows.');
  });

  it('treats failure bullets after APPROVED as not approved until the reviewer sends a clean verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\n- Tests still fail on Windows after restart.',
      'APPROVED\nRestart recovery verified after a clean rerun.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('- Tests still fail on Windows after restart.');
  });

  it('treats numbered failure items after APPROVED as not approved until the reviewer sends a clean verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\n1. Windows restart recovery still fails after interruption.',
      'APPROVED\nRestart recovery verified after a clean rerun.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('1. Windows restart recovery still fails after interruption.');
  });

  it('treats follow-up failure sentences after APPROVED as not approved until the reviewer sends a clean verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\nVerification failed on Windows after restart.',
      'APPROVED\nRestart recovery verified after a clean rerun.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('Verification failed on Windows after restart.');
  });

  it('treats CRLF-separated issue lists after APPROVED as rejection feedback even through blank lines', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\r\n\r\n1. Issue: restart recovery is still broken after interruption.\r\n',
      'APPROVED\r\nRestart recovery verified after interruption.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : 'draft',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('1. Issue: restart recovery is still broken after interruption.');
    expect(secondAuthorPrompt).toContain('treated as NOT APPROVED because it mixed APPROVED with conflicting issue text');
  });

  it('treats high-latency hang notes after APPROVED as unresolved failure feedback', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\nHigh latency hang during reviewer startup.',
      'APPROVED\nHigh latency reviewer startup now succeeds after retry recovery verification.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : 'draft',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('High latency hang during reviewer startup.');
    expect(secondAuthorPrompt).toContain('treated as NOT APPROVED because it mixed APPROVED with conflicting issue text');
  });

  it('captures and persists run events as a local run trace', async () => {
    const lines: string[] = [];
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = {
      ...config(1),
      runTrace: {
        enabled: true,
        runTraceId: 'test-run-trace',
        now: (() => {
          let at = 1000;
          return () => at += 1;
        })(),
        writeLine: (line: string) => lines.push(line),
      },
    };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, renderer }: { role: 'AUTHOR' | 'REVIEWER'; renderer: any }) => {
      if (role === 'AUTHOR') {
        renderer.onTraceEntry({ role, entry: { direction: 'sent', frame: 'author-wire' } });
        renderer.onToolStart({ round: 1, role, toolCallId: 'tool-1', title: 'Run tests' });
        return 'draft';
      }
      return 'APPROVED';
    });

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.at(0)).toMatchObject({ type: 'runStart', runTraceId: 'test-run-trace' });
    expect(entries.some((entry) => entry.event?.type === 'traceEntry' && entry.event.entry.frame === 'author-wire')).toBe(true);
    expect(entries.some((entry) => entry.event?.type === 'toolStart' && entry.event.toolCallId === 'tool-1')).toBe(true);
    expect(entries.at(-1)).toMatchObject({ type: 'runEnd', status: 'completed', result: { approved: true, rounds: 1 } });
  });

  it('closes run traces with failed status when the run fails', async () => {
    const lines: string[] = [];
    const failure = new Error('author crashed');
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = {
      ...config(1),
      runTrace: { enabled: true, runTraceId: 'failed-run-trace', writeLine: (line: string) => lines.push(line) },
    };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      if (role === 'AUTHOR') throw failure;
      return 'APPROVED';
    });

    await expect(createLoopEngine({ config: cfg }).run()).rejects.toThrow('author crashed');

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.some((entry) => entry.event?.type === 'error' && entry.event.error.message === 'author crashed')).toBe(true);
    expect(entries.at(-1)).toMatchObject({
      type: 'runEnd',
      status: 'failed',
      error: { message: 'author crashed' },
      finalState: { hasError: true },
    });
  });

  it('captures wire traces when run trace persistence is enabled even when TUI and trace logging are disabled', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = { ...config(1), tui: false, trace: false, runTrace: { enabled: true, writeLine: () => {} } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    await createLoopEngine({ config: cfg }).run();

    expect(mocks.openRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'AUTHOR',
      trace: false,
      captureTrace: true,
    }));
    expect(mocks.openRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'REVIEWER',
      trace: false,
      captureTrace: true,
    }));
  });

  it('captures wire traces in TUI mode even when trace logging is disabled', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = { ...config(1), tui: true, trace: false };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    await createLoopEngine({ config: cfg }).run();

    expect(mocks.openRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'AUTHOR',
      trace: false,
      captureTrace: true,
    }));
    expect(mocks.openRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'REVIEWER',
      trace: false,
      captureTrace: true,
    }));
  });

  it('starts the author turn before waiting for the reviewer role to finish launching', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    let resolveReviewer: ((state: typeof reviewerState) => void) | undefined;
    const reviewerReady = new Promise<typeof reviewerState>((resolve) => {
      resolveReviewer = resolve;
    });
    const authorTurnStarted = new Promise<void>((resolve) => {
      mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
        if (role === 'AUTHOR') {
          resolve();
          return 'draft';
        }
        return 'APPROVED';
      });
    });
    mocks.openRole.mockImplementation(({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? Promise.resolve(authorState) : reviewerReady,
    );

    const runPromise = createLoopEngine({ config: config(1) }).run();
    await authorTurnStarted;

    expect(mocks.runTurn.mock.calls[0]?.[0]).toMatchObject({ role: 'AUTHOR', state: authorState });
    expect(mocks.runTurn.mock.calls.some(([arg]) => arg.role === 'REVIEWER')).toBe(false);

    resolveReviewer?.(reviewerState);
    await expect(runPromise).resolves.toMatchObject({ approved: true, rounds: 1 });
    expect(mocks.closeRole).toHaveBeenCalledWith(authorState);
    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerState);
  });

  it('runs the author turn before surfacing a reviewer startup or model setup failure', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerError = new Error('REVIEWER_MODEL="bad" is not available');
    reviewerError.name = 'ConfigurationError';
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      if (role === 'REVIEWER') throw reviewerError;
      return authorState;
    });
    mocks.runTurn.mockResolvedValue('draft');

    await expect(createLoopEngine({ config: config(1) }).run()).rejects.toThrow('not available');

    expect(mocks.openRole).toHaveBeenCalledTimes(2);
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(mocks.runTurn.mock.calls[0]?.[0]).toMatchObject({ role: 'AUTHOR', state: authorState });
    expect(mocks.closeRole).toHaveBeenCalledWith(authorState);
  });

  it('reports both startup failures when author and reviewer cannot launch', async () => {
    const authorError = new Error('AUTHOR agent missing dependency');
    const reviewerError = new Error('REVIEWER auth expired');
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      throw role === 'AUTHOR' ? authorError : reviewerError;
    });

    const thrown = await createLoopEngine({ config: config(1) }).run().catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Role startup failed.');
    expect(thrown.errors.map((error: Error) => error.message)).toEqual(expect.arrayContaining([
      'AUTHOR agent missing dependency',
      'REVIEWER auth expired',
    ]));
    expect(mocks.runTurn).not.toHaveBeenCalled();
  });

  it('surfaces author startup failure promptly even when reviewer launch hangs, then closes a late reviewer', async () => {
    const authorError = new Error('AUTHOR agent missing dependency');
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session-late' } };
    let resolveReviewer: ((state: typeof reviewerState) => void) | undefined;
    const reviewerReady = new Promise<typeof reviewerState>((resolve) => {
      resolveReviewer = resolve;
    });
    mocks.openRole.mockImplementation(({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => (
      role === 'AUTHOR' ? Promise.reject(authorError) : reviewerReady
    ));

    const outcome = await Promise.race([
      createLoopEngine({ config: config(1) }).run()
        .then((result) => ({ status: 'resolved' as const, result }))
        .catch((error) => ({ status: 'rejected' as const, error })),
      new Promise<{ status: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ status: 'timeout' }), 100);
      }),
    ]);

    expect(outcome).toMatchObject({ status: 'rejected', error: authorError });
    expect(mocks.runTurn).not.toHaveBeenCalled();

    resolveReviewer?.(reviewerState);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerState);
  });

  it('closes a reviewer that settles after started roles are collected during failure cleanup', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session-late-during-cleanup' } };
    const authorTurnError = new Error('author crashed after starting work');
    let resolveReviewer: ((state: typeof reviewerState) => void) | undefined;
    let releaseAuthorClose: (() => void) | undefined;
    const reviewerReady = new Promise<typeof reviewerState>((resolve) => {
      resolveReviewer = resolve;
    });
    const authorCloseBlocked = new Promise<void>((resolve) => {
      releaseAuthorClose = resolve;
    });
    mocks.openRole.mockImplementation(({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? Promise.resolve(authorState) : reviewerReady,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      if (role === 'AUTHOR') throw authorTurnError;
      return 'APPROVED';
    });
    mocks.closeRole.mockImplementation(async (state: { role: string }) => {
      if (state === authorState) await authorCloseBlocked;
    });

    const runPromise = createLoopEngine({ config: config(1) }).run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.closeRole).toHaveBeenCalledWith(authorState);
    expect(mocks.closeRole).not.toHaveBeenCalledWith(reviewerState);

    resolveReviewer?.(reviewerState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseAuthorClose?.();

    await expect(runPromise).rejects.toThrow('author crashed after starting work');
    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerState);
  });

  it('records a normal engine error when workspace creation fails before launch', async () => {
    mocks.mkdir.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    const engine = createLoopEngine({ config: config(1) });
    await expect(engine.run()).rejects.toThrow('ENOSPC');

    expect(mocks.openRole).not.toHaveBeenCalled();
    expect(engine.getState()).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('ENOSPC'),
    });
  });

  it('preserves the original run failure while still closing both roles when cleanup also fails', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewError = new Error('review failed');
    const closeError = new Error('author close failed');
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      if (role === 'AUTHOR') return 'draft';
      throw reviewError;
    });
    mocks.closeRole.mockImplementation(async (state: { role: string }) => {
      if (state === authorState) throw closeError;
    });

    const thrown = await createLoopEngine({ config: config(2) }).run().catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Author-reviewer loop failed and cleanup also failed.');
    expect(thrown.errors.map((error: Error) => error.message)).toEqual(expect.arrayContaining([
      'review failed',
      'author close failed',
    ]));
    expect(mocks.closeRole).toHaveBeenCalledWith(authorState);
    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerState);
  });

  it('accumulates reported token usage into role panes', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({
      role,
      round,
      renderer,
    }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      renderer: { onTurnSnapshot(event: unknown): void };
    }) => {
      renderer.onTurnSnapshot({
        round,
        role,
        snapshot: {
          text: role === 'REVIEWER' ? 'APPROVED' : 'done',
          status: 'completed',
          tools: [],
          usage: role === 'AUTHOR'
            ? { inputTokens: 100, outputTokens: 25, totalTokens: 125 }
            : { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
        },
      });
      return role === 'REVIEWER' ? 'APPROVED' : 'done';
    });

    const engine = createLoopEngine({ config: config(1) });
    await engine.run();
    const state = engine.getState();
    const round = state.rounds.get(1);

    expect(round?.AUTHOR.usage).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(round?.REVIEWER.usage).toMatchObject({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  });

  it('keeps latest ACP context usage instead of adding used and size across rounds', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({
      role,
      round,
      renderer,
    }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      renderer: { onTurnSnapshot(event: unknown): void };
    }) => {
      renderer.onTurnSnapshot({
        round,
        role,
        snapshot: {
          text: role === 'REVIEWER' && round === 2 ? 'APPROVED' : 'continue',
          status: 'completed',
          tools: [],
          usage: role === 'AUTHOR'
            ? { used: round * 100, size: 1_000 }
            : { used: round * 10, size: 500 },
        },
      });
      return role === 'REVIEWER' && round === 2 ? 'APPROVED' : 'continue';
    });

    const engine = createLoopEngine({ config: config(2) });
    await engine.run();
    const state = engine.getState();
    const round = state.rounds.get(2);

    expect(round?.AUTHOR.usage).toMatchObject({ used: 200, size: 1_000 });
    expect(round?.REVIEWER.usage).toMatchObject({ used: 20, size: 500 });
  });

  it('updates role panes from ACP usage events that arrive outside turn snapshots', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({
      role,
      round,
      renderer,
    }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      renderer: { onTurnStart(event: unknown): void; onUsageUpdate(event: unknown): void };
    }) => {
      renderer.onTurnStart({ round, role });
      renderer.onUsageUpdate({
        role,
        usage: role === 'AUTHOR' ? { used: 1234, size: 200_000 } : { used: 4321, size: 200_000 },
      });
      return role === 'REVIEWER' ? 'APPROVED' : 'done';
    });

    const engine = createLoopEngine({ config: config(1) });
    await engine.run();
    const round = engine.getState().rounds.get(1);

    expect(round?.AUTHOR.usage).toMatchObject({ used: 1234, size: 200_000 });
    expect(round?.REVIEWER.usage).toMatchObject({ used: 4321, size: 200_000 });
  });

  it('publishes tool update events into pane state and event subscribers', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({
      role,
      round,
      renderer,
    }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      renderer: { onToolStart(event: unknown): void; onToolUpdate(event: unknown): void };
    }) => {
      if (role === 'REVIEWER') return 'APPROVED';
      renderer.onToolStart({ round, role, toolCallId: 'tool-1', tag: '#1', title: 'Run command' });
      renderer.onToolUpdate({ round, role, toolCallId: 'tool-1', tag: '#1', title: 'Run command', status: 'running', output: 'partial', chars: 7 });
      return 'done';
    });

    const engine = createLoopEngine({ config: config(1) });
    const events: string[] = [];
    engine.onEvent((event: { type: string }) => events.push(event.type));
    await engine.run();

    expect(events).toContain('toolUpdate');
    expect(engine.getState().rounds.get(1)?.AUTHOR.tools[0]).toMatchObject({
      id: 'tool-1',
      status: 'running',
      output: 'partial',
      chars: 7,
    });
  });

  it('continues with the same sessions when approval is reopened by an edited task', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    const cfg = config(2) as ReturnType<typeof config> & {
      task: string;
      onApproved?: () => Promise<{ continue: boolean; feedback?: string }>;
    };
    cfg.task = 'first task';
    cfg.authorSettings.prompt = ({ round, feedback }: { round: number; feedback: string }) =>
      `author ${round} ${cfg.task} ${feedback}`;
    cfg.onApproved = vi
      .fn()
      .mockImplementationOnce(async () => {
        cfg.task = 'edited task';
        return { continue: true, feedback: 'task changed after approval' };
      })
      .mockResolvedValueOnce({ continue: false });

    let reviewerIndex = 0;
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    expect(mocks.openRole).toHaveBeenCalledTimes(2);
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR');
    const reviewerTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER');
    expect(authorTurns.map(([arg]) => arg.state)).toEqual([authorState, authorState]);
    expect(reviewerTurns.map(([arg]) => arg.state)).toEqual([reviewerStates[0], reviewerStates[0]]);
    expect(authorTurns[1]?.[0].prompt).toContain('edited task');
  });

  it('continues with the same sessions when approval is force-continued', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    const cfg = config(1) as ReturnType<typeof config> & {
      onApproved?: () => Promise<{ continue: boolean; feedback?: string }>;
    };
    cfg.onApproved = vi
      .fn()
      .mockResolvedValueOnce({ continue: true, feedback: 'force another round' })
      .mockResolvedValueOnce({ continue: false });
    let reviewerIndex = 0;
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const engine = createLoopEngine({ config: cfg });
    const events: Array<{ type: string; feedback?: string }> = [];
    engine.onEvent((event: { type: string; feedback?: string }) => events.push(event));
    const result = await engine.run();

    expect(result).toMatchObject({ approved: true, rounds: 2, maxRounds: 2 });
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === 'approvalContinued' && event.feedback === 'force another round')).toBe(true);
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR');
    expect(authorTurns.map(([arg]) => arg.state)).toEqual([authorState, authorState]);
    expect(mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER').map(([arg]) => arg.state)).toEqual([reviewerStates[0], reviewerStates[0]]);
    expect(authorTurns[1]?.[0].prompt).toContain('force another round');
  });

  it('refreshes sessions on an approval continuation when session turn limits are exhausted', async () => {
    const authorStates = [
      { role: 'AUTHOR', session: { id: 'author-run-trace-1' } },
      { role: 'AUTHOR', session: { id: 'author-session-2' } },
    ];
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    const cfg = config(1) as ReturnType<typeof config> & {
      onApproved?: () => Promise<{ continue: boolean; feedback?: string }>;
    };
    cfg.authorSettings.sessionTurns = 1;
    cfg.reviewerSettings.sessionTurns = 1;
    cfg.onApproved = vi
      .fn()
      .mockResolvedValueOnce({ continue: true, feedback: 'continue after approval with fresh verification' })
      .mockResolvedValueOnce({ continue: false });

    let authorIndex = 0;
    let reviewerIndex = 0;
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorStates[authorIndex++]! : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED\nVerified.' : 'implemented fix',
    );

    const result = await createLoopEngine({ config: cfg }).run();
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR');
    const reviewerTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER');

    expect(result).toMatchObject({ approved: true, rounds: 2, maxRounds: 2 });
    expect(authorTurns.map(([arg]) => arg.state)).toEqual(authorStates);
    expect(reviewerTurns.map(([arg]) => arg.state)).toEqual(reviewerStates);
    expect(authorTurns[1]?.[0].prompt).toContain('continue after approval with fresh verification');
    expect(mocks.closeRole).toHaveBeenCalledWith(authorStates[0]);
    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerStates[0]);
  });

  it('publishes actionable approval-pending state without emitting a terminal result', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    let resolveApproval;
    let markApprovalPending;
    const approvalPending = new Promise<void>((resolve) => {
      markApprovalPending = resolve;
    });
    const cfg = config(1) as ReturnType<typeof config> & {
      onApproved?: () => Promise<{ continue: boolean; feedback?: string }>;
    };
    cfg.onApproved = vi.fn().mockImplementation(() => {
      markApprovalPending?.();
      return new Promise((resolve) => {
        resolveApproval = resolve;
      });
    });

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const engine = createLoopEngine({ config: cfg });
    const results: unknown[] = [];
    const pendingApprovals: unknown[] = [];
    engine.onEvent((event: { type: string; result?: unknown }) => {
      if (event.type === 'result') results.push(event.result);
      if (event.type === 'approvalPending') pendingApprovals.push(event.result);
    });

    const runPromise = engine.run();
    await approvalPending;

    expect(results).toEqual([]);
    expect(pendingApprovals).toEqual([
      expect.objectContaining({ approved: true, rounds: 1 }),
    ]);
    expect(engine.getState()).toMatchObject({
      phase: 'done',
      approvalPending: true,
      result: expect.objectContaining({ approved: true, rounds: 1 }),
    });

    resolveApproval?.({ continue: false });

    await expect(runPromise).resolves.toMatchObject({ approved: true, rounds: 1 });
    expect(results).toHaveLength(1);
    expect(engine.getState().approvalPending).toBe(false);
  });

  it('caps repeated approval continuations to prevent runaway approval loops', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = {
      ...config(1),
      maxApprovalContinuations: 1,
      onApproved: vi.fn().mockResolvedValue({ continue: true, feedback: 'again' }),
    };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({
      approved: true,
      rounds: 2,
      maxRounds: 2,
      continuationLimitReached: true,
    });
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    expect(mocks.runTurn).toHaveBeenCalledTimes(4);
  });

  it('keeps the full user-visible flow when contradictory reviews eventually converge', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = config(4);
    cfg.authorSettings.prompt = ({ round, feedback }: { round: number; feedback: string }) =>
      `round=${round}\nprevious-review=${feedback || '<none>'}`;
    cfg.reviewerSettings.prompt = ({ round, feedback, authorReply }: { round: number; feedback: string; authorReply: string }) =>
      `review round=${round}\nprevious-review=${feedback || '<none>'}\nauthor=${authorReply}`;

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round, prompt, renderer }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      prompt: string;
      renderer: { onMessageDelta(event: unknown): void; onToolStart(event: unknown): void; onToolEnd(event: unknown): void };
    }) => {
      if (role === 'AUTHOR') {
        renderer.onMessageDelta({ round, role, delta: `implemented-${round}` });
        return `implementation ${round} using ${prompt}`;
      }
      renderer.onToolStart({ round, role, toolCallId: `review-${round}`, tag: '#1', title: 'Run verification' });
      renderer.onToolEnd({ round, role, toolCallId: `review-${round}`, tag: '#1', title: 'Run verification', status: 'completed', output: 'ok', chars: 2 });
      if (round === 1) return 'Fix A immediately. Do not change B.';
      if (round === 2) return 'Contradiction: revert A and change B instead.';
      return 'APPROVED\nVerified after resolving contradictory review guidance.';
    });

    const engine = createLoopEngine({ config: cfg });
    const eventTypes: string[] = [];
    engine.onEvent((event: { type: string }) => eventTypes.push(event.type));
    const result = await engine.run();
    const authorPrompts = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR').map(([arg]) => arg.prompt);

    expect(result).toMatchObject({ approved: true, rounds: 3 });
    expect(authorPrompts[1]).toContain('Fix A immediately. Do not change B.');
    expect(authorPrompts[2]).toContain('Contradiction: revert A and change B instead.');
    expect(eventTypes).toEqual(expect.arrayContaining(['launching', 'delta', 'toolStart', 'toolEnd', 'result']));
    expect(engine.getState().rounds.get(3)?.REVIEWER.tools[0]).toMatchObject({
      id: 'review-3',
      status: 'completed',
      output: 'ok',
    });
  });

  it('exhausts maxRounds with repeated empty author output and rejection feedback', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = config(3);
    cfg.authorSettings.prompt = ({ round, feedback }: { round: number; feedback: string }) =>
      `round=${round}; recover-from=${feedback || '<none>'}`;

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) => {
      if (role === 'AUTHOR') return round === 1 ? '' : 'still no durable fix';
      return `REJECTED round ${round}: missing restart recovery and tests.`;
    });

    const result = await createLoopEngine({ config: cfg }).run();
    const authorPrompts = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR').map(([arg]) => arg.prompt);

    expect(result).toMatchObject({
      approved: false,
      rounds: 3,
      maxRounds: 3,
      feedback: 'REJECTED round 3: missing restart recovery and tests.',
    });
    expect(authorPrompts[1]).toContain('REJECTED round 1');
    expect(authorPrompts[2]).toContain('REJECTED round 2');
    expect(mocks.runTurn).toHaveBeenCalledTimes(6);
  });

  it('replaces empty reviewer replies with explicit recovery feedback', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) => {
      if (role === 'AUTHOR') return round === 1 ? 'draft' : 'reworked draft';
      return round === 1 ? ' \n\t ' : 'APPROVED';
    });

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('Reviewer returned an empty response.');
    expect(secondAuthorPrompt).toContain('Do not assume approval.');
  });

  it('normalizes a zero maxRounds config into a single round instead of silently skipping the loop', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : 'implemented fix',
    );

    const result = await createLoopEngine({ config: config(0) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1, maxRounds: 1 });
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
    expect(mocks.openRole).toHaveBeenCalledTimes(2);
  });

  it('normalizes a negative maxRounds config into a single round instead of skipping all work', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : 'implemented fix',
    );

    const result = await createLoopEngine({ config: config(-5) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1, maxRounds: 1 });
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
  });

  it('normalizes a fractional maxRounds config before deciding how many rounds to run', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    let reviewerIndex = 0;

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? (round === 1 ? '1. Fix restart recovery.' : 'APPROVED') : 'implemented fix',
    );

    const result = await createLoopEngine({ config: { ...config(1), maxRounds: 2.7 } }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2, maxRounds: 2 });
    expect(mocks.runTurn).toHaveBeenCalledTimes(4);
  });

  it('normalizes non-finite maxRounds values to one safe round for programmatic callers', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };

    for (const maxRounds of [Number.NaN, Number.POSITIVE_INFINITY]) {
      mocks.openRole.mockReset();
      mocks.runTurn.mockReset();
      mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
        role === 'AUTHOR' ? authorState : reviewerState,
      );
      mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
        role === 'REVIEWER' ? 'APPROVED' : 'implemented fix',
      );

      const result = await createLoopEngine({ config: { ...config(1), maxRounds } }).run();

      expect(result).toMatchObject({ approved: true, rounds: 1, maxRounds: 1 });
      expect(mocks.runTurn).toHaveBeenCalledTimes(2);
    }
  });

  it('falls back to the normalized base round budget when maxApprovalContinuations is fractional', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-3' } },
    ];
    let reviewerIndex = 0;
    const cfg = {
      ...config(1),
      maxApprovalContinuations: 2.5,
      onApproved: vi.fn().mockResolvedValue({ continue: true, feedback: 'continue after approval' }),
    };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : 'implemented fix',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2, maxRounds: 2, continuationLimitReached: true });
    expect(result.feedback).toContain('Approval continuation limit reached after 1 continuation(s).');
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    expect(mocks.runTurn).toHaveBeenCalledTimes(4);
  });

  it('falls back to the normalized base round budget when maxApprovalContinuations is negative', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerStates = [
      { role: 'REVIEWER', session: { id: 'reviewer-run-trace-1' } },
      { role: 'REVIEWER', session: { id: 'reviewer-session-2' } },
    ];
    let reviewerIndex = 0;
    const cfg = {
      ...config(1),
      maxApprovalContinuations: -1,
      onApproved: vi.fn().mockResolvedValue({ continue: true, feedback: 'continue after approval' }),
    };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerStates[reviewerIndex++]!,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : 'implemented fix',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2, maxRounds: 2, continuationLimitReached: true });
    expect(result.feedback).toContain('Approval continuation limit reached after 1 continuation(s).');
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    expect(mocks.runTurn).toHaveBeenCalledTimes(4);
  });

  it('resumes from a saved pending reviewer turn without rerunning the author turn', async () => {
    const authorState = {
      role: 'AUTHOR',
      session: { id: 'author-session', sessionId: 'author-session' },
      recovery: { resumed: true, turnsOnActiveSession: 1 },
    };
    const reviewerState = {
      role: 'REVIEWER',
      session: { id: 'reviewer-session', sessionId: 'reviewer-session' },
      recovery: { resumed: true, turnsOnActiveSession: 0 },
    };
    const store = {
      load: vi.fn().mockReturnValue({
        version: 1,
        identity: {},
        identityHash: 'x',
        updatedAt: 1,
        loop: {
          roundLimit: 3,
          approvalContinuations: 0,
          feedback: '1. Missing persistence.',
          pending: {
            type: 'reviewer-turn',
            round: 2,
            started: true,
            authorReply: 'Implemented persistence and targeted restart tests.',
          },
        },
        roles: {
          AUTHOR: { sessionId: 'author-session', turnsOnActiveSession: 1 },
          REVIEWER: { sessionId: 'reviewer-session', turnsOnActiveSession: 0 },
        },
      }),
      write: vi.fn(),
      clear: vi.fn(),
    };

    mocks.openRole.mockImplementation(async ({ role, recovery }: { role: 'AUTHOR' | 'REVIEWER'; recovery?: { sessionId?: string } }) => {
      if (role === 'AUTHOR') {
        expect(recovery).toMatchObject({ sessionId: 'author-session' });
        return authorState;
      }
      expect(recovery).toMatchObject({ sessionId: 'reviewer-session' });
      return reviewerState;
    });
    const cfg = config(3);
    cfg.reviewerSettings.prompt = ({ round, feedback, authorReply }: { round: number; feedback: string; authorReply: string }) =>
      `reviewer ${round}\nfeedback=${feedback || '<none>'}\nauthor=${authorReply}`;

    mocks.runTurn.mockImplementation(async ({ role, round, prompt }: { role: 'AUTHOR' | 'REVIEWER'; round: number; prompt: string }) => {
      if (role === 'AUTHOR') return 'unexpected author rerun';
      expect(round).toBe(2);
      expect(prompt).toContain('Implemented persistence and targeted restart tests.');
      return 'APPROVED\nRestart recovery verified after resume.';
    });

    const result = await createLoopEngine({ config: { ...cfg, runRecovery: { store } } }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2, maxRounds: 3 });
    expect(mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR')).toHaveLength(0);
    expect(mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER')).toHaveLength(1);
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('records the Spar session lifecycle separately from run recovery', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session', sessionId: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session', sessionId: 'reviewer-session' } };
    const sparSessionStore = {
      start: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const runRecoveryStore = {
      load: vi.fn().mockReturnValue(null),
      write: vi.fn(),
      clear: vi.fn(),
    };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? 'implemented' : 'APPROVED\nLooks good.',
    );

    const result = await createLoopEngine({
      config: {
        ...config(1),
        sparSession: { store: sparSessionStore },
        runRecovery: { store: runRecoveryStore },
      },
    }).run();

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    expect(sparSessionStore.start).toHaveBeenCalledTimes(1);
    expect(sparSessionStore.complete).toHaveBeenCalledWith(expect.objectContaining({ approved: true, rounds: 1 }));
    expect(sparSessionStore.fail).not.toHaveBeenCalled();
    expect(runRecoveryStore.write).toHaveBeenCalled();
    expect(runRecoveryStore.clear).toHaveBeenCalledTimes(1);
  });

  it('resumes from a saved approval decision without rerunning agent turns', async () => {
    const authorState = {
      role: 'AUTHOR',
      session: { id: 'author-session', sessionId: 'author-session' },
      recovery: { resumed: true, turnsOnActiveSession: 2 },
    };
    const reviewerState = {
      role: 'REVIEWER',
      session: { id: 'reviewer-session', sessionId: 'reviewer-session' },
      recovery: { resumed: true, turnsOnActiveSession: 2 },
    };
    const onApproved = vi.fn().mockResolvedValue({ continue: false });
    const store = {
      load: vi.fn().mockReturnValue({
        version: 1,
        identity: {},
        identityHash: 'x',
        updatedAt: 1,
        loop: {
          roundLimit: 2,
          approvalContinuations: 0,
          feedback: 'APPROVED',
          pending: {
            type: 'approval-decision',
            round: 2,
            started: true,
            result: {
              approved: true,
              feedback: 'APPROVED\nReady for handoff.',
              maxRounds: 2,
              rounds: 2,
              cwd: process.cwd(),
              continuationLimitReached: false,
            },
          },
        },
        roles: {
          AUTHOR: { sessionId: 'author-session', turnsOnActiveSession: 2 },
          REVIEWER: { sessionId: 'reviewer-session', turnsOnActiveSession: 2 },
        },
      }),
      write: vi.fn(),
      clear: vi.fn(),
    };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );

    const result = await createLoopEngine({ config: { ...config(2), onApproved, runRecovery: { store } } }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2, feedback: 'APPROVED\nReady for handoff.' });
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(onApproved).toHaveBeenCalledWith(expect.objectContaining({ approved: true, rounds: 2 }));
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('falls back to fresh sessions when saved session ids are stale or unavailable', async () => {
    const authorState = {
      role: 'AUTHOR',
      session: { id: 'author-fresh', sessionId: 'author-fresh' },
      recovery: { resumed: false, turnsOnActiveSession: 0 },
    };
    const reviewerState = {
      role: 'REVIEWER',
      session: { id: 'reviewer-fresh', sessionId: 'reviewer-fresh' },
      recovery: { resumed: false, turnsOnActiveSession: 0 },
    };
    const store = {
      load: vi.fn().mockReturnValue({
        version: 1,
        identity: {},
        identityHash: 'x',
        updatedAt: 1,
        loop: {
          roundLimit: 2,
          approvalContinuations: 0,
          feedback: '',
          pending: { type: 'author-turn', round: 1, started: false },
        },
        roles: {
          AUTHOR: { sessionId: 'author-stale', turnsOnActiveSession: 4 },
          REVIEWER: { sessionId: 'reviewer-stale', turnsOnActiveSession: 3 },
        },
      }),
      write: vi.fn(),
      clear: vi.fn(),
    };

    mocks.openRole.mockImplementation(async ({ role, recovery }: { role: 'AUTHOR' | 'REVIEWER'; recovery?: { sessionId?: string } }) => {
      expect(recovery?.sessionId).toMatch(/-stale$/);
      return role === 'AUTHOR' ? authorState : reviewerState;
    });
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? (round === 2 ? 'APPROVED' : '1. Keep going') : 'implemented fix',
    );

    const result = await createLoopEngine({ config: { ...config(2), runRecovery: { store } } }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(mocks.runTurn).toHaveBeenCalledTimes(4);
  });

  it('roundtrips engine-written recovery through the real store after interruption and resumes reviewer verification', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-engine-recovery-'));
    const cfg = config(3);
    cfg.reviewerSettings.prompt = ({ round, feedback, authorReply }: { round: number; feedback: string; authorReply: string }) =>
      `reviewer ${round}\nfeedback=${feedback || '<none>'}\nauthor=${authorReply}`;
    const store = createRunRecoveryStore({ enabled: true, home, config: cfg });
    const authorState = {
      role: 'AUTHOR',
      session: { id: 'author-session', sessionId: 'author-session' },
      recovery: { resumed: false, turnsOnActiveSession: 0 },
    };
    const reviewerState = {
      role: 'REVIEWER',
      session: { id: 'reviewer-session', sessionId: 'reviewer-session' },
      recovery: { resumed: false, turnsOnActiveSession: 0 },
    };

    mocks.openRole.mockImplementation(async ({ role, recovery }: { role: 'AUTHOR' | 'REVIEWER'; recovery?: { sessionId?: string } }) => {
      if (role === 'AUTHOR') {
        expect(recovery?.sessionId).toBeUndefined();
        return authorState;
      }
      expect(recovery?.sessionId).toBeUndefined();
      return reviewerState;
    });

    const interruption = new Error('simulated interruption after recovery checkpoint');
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      if (role === 'AUTHOR') return 'Implemented run recovery and replay-based split-word fix.';
      throw interruption;
    });

    await expect(createLoopEngine({ config: { ...cfg, runRecovery: { enabled: true, home, store } } }).run())
      .rejects.toThrow('simulated interruption after recovery checkpoint');

    const writtenRecovery = store.load();
    expect(writtenRecovery).toMatchObject({
      loop: {
        feedback: '',
        pending: {
          type: 'reviewer-turn',
          round: 1,
          started: true,
          authorReply: 'Implemented run recovery and replay-based split-word fix.',
        },
      },
      roles: {
        AUTHOR: { sessionId: 'author-session', turnsOnActiveSession: 1 },
        REVIEWER: { sessionId: 'reviewer-session', turnsOnActiveSession: 1 },
      },
    });

    mocks.openRole.mockReset();
    mocks.runTurn.mockReset();
    mocks.closeRole.mockReset();

    const resumedAuthorState = {
      role: 'AUTHOR',
      session: { id: 'author-session', sessionId: 'author-session' },
      recovery: { resumed: true, turnsOnActiveSession: 1 },
    };
    const resumedReviewerState = {
      role: 'REVIEWER',
      session: { id: 'reviewer-session', sessionId: 'reviewer-session' },
      recovery: { resumed: true, turnsOnActiveSession: 1 },
    };
    mocks.openRole.mockImplementation(async ({ role, recovery }: { role: 'AUTHOR' | 'REVIEWER'; recovery?: { sessionId?: string } }) => {
      if (role === 'AUTHOR') {
        expect(recovery).toMatchObject({ sessionId: 'author-session', turnsOnActiveSession: 1 });
        return resumedAuthorState;
      }
      expect(recovery).toMatchObject({ sessionId: 'reviewer-session', turnsOnActiveSession: 1 });
      return resumedReviewerState;
    });
    mocks.runTurn.mockImplementation(async ({ role, round, prompt }: { role: 'AUTHOR' | 'REVIEWER'; round: number; prompt: string }) => {
      if (role === 'AUTHOR') return 'author should not rerun';
      expect(round).toBe(1);
      expect(prompt).toContain('Implemented run recovery and replay-based split-word fix.');
      return 'APPROVED\nReviewer resume verified through the persisted recovery store.';
    });

    const resumed = await createLoopEngine({ config: { ...cfg, runRecovery: { enabled: true, home, store } } }).run();

    expect(resumed).toMatchObject({ approved: true, rounds: 1 });
    expect(mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR')).toHaveLength(0);
    expect(mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER')).toHaveLength(1);
    expect(store.load()).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });

});
