import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openRole: vi.fn(),
  closeRole: vi.fn(),
  runTurn: vi.fn(),
}));

vi.mock('../lib/runtime/role.mjs', () => ({
  openRole: mocks.openRole,
  closeRole: mocks.closeRole,
}));

vi.mock('../lib/runtime/turn.mjs', () => ({
  runTurn: mocks.runTurn,
}));

const { runAuthorReviewerLoop } = await import('../lib/runtime/loop.mjs');

describe('author-reviewer-loop simulated E2E', () => {
  beforeEach(() => {
    mocks.openRole.mockReset();
    mocks.closeRole.mockReset();
    mocks.runTurn.mockReset();
  });

  it('runs from user task to final approval while preserving renderer-visible recovery context', async () => {
    const renderer = {
      onLaunching: vi.fn(),
      onTurnStart: vi.fn(),
      onMessageDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onResult: vi.fn(),
    };
    const config = {
      cwd: process.cwd(),
      maxRounds: 3,
      trace: false,
      tui: false,
      authorSettings: {
        agent: { id: 'author', displayName: 'Author', command: 'author', args: [] },
        model: null,
        prompt: ({ round, feedback }: { round: number; feedback: string }) =>
          `Build production feature. round=${round}. reviewer-feedback=${feedback || '<none>'}`,
      },
      reviewerSettings: {
        agent: { id: 'reviewer', displayName: 'Reviewer', command: 'reviewer', args: [] },
        model: null,
        prompt: ({ round, feedback, authorReply }: { round: number; feedback: string; authorReply: string }) =>
          `Review production feature. round=${round}. prior=${feedback || '<none>'}. author=${authorReply}`,
      },
    };
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'Cannot approve: missing persistence after restart.',
      'APPROVED\nPersistence verified after restart and renderer stayed responsive.',
    ];

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round, prompt, renderer: innerRenderer }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      prompt: string;
      renderer: {
        onMessageDelta(event: unknown): void;
        onToolStart(event: unknown): void;
        onToolEnd(event: unknown): void;
      };
    }) => {
      innerRenderer.onMessageDelta({ round, role, delta: `${role}:${round}` });
      innerRenderer.onToolStart({ round, role, toolCallId: `${role}-${round}-verify`, tag: '#1', title: 'Verify restart recovery' });
      innerRenderer.onToolEnd({ round, role, toolCallId: `${role}-${round}-verify`, tag: '#1', title: 'Verify restart recovery', status: 'completed', output: 'passed', chars: 6 });
      if (role === 'AUTHOR') return `implementation ${round}; prompt=${prompt}`;
      return reviewerReplies[round - 1];
    });

    const result = await runAuthorReviewerLoop({ config, renderer });
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('missing persistence after restart');
    expect(renderer.onLaunching).toHaveBeenCalledOnce();
    expect(renderer.onMessageDelta).toHaveBeenCalledWith(expect.objectContaining({ type: 'delta', role: 'AUTHOR', round: 1 }));
    expect(renderer.onToolEnd).toHaveBeenCalledWith(expect.objectContaining({ type: 'toolEnd', role: 'REVIEWER', round: 2, output: 'passed' }));
    expect(renderer.onResult).toHaveBeenCalledWith(expect.objectContaining({ approved: true, rounds: 2 }));
    expect(mocks.closeRole).toHaveBeenCalledWith(authorState);
    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerState);
  });

  it('turns an empty reviewer reply into explicit recovery guidance before the next round', async () => {
    const renderer = {
      onLaunching: vi.fn(),
      onResult: vi.fn(),
    };
    const config = {
      cwd: process.cwd(),
      maxRounds: 2,
      trace: false,
      tui: false,
      authorSettings: {
        agent: { id: 'author', displayName: 'Author', command: 'author', args: [] },
        model: null,
        prompt: ({ round, feedback }: { round: number; feedback: string }) =>
          `AUTHOR round=${round}; feedback=${feedback || '<none>'}`,
      },
      reviewerSettings: {
        agent: { id: 'reviewer', displayName: 'Reviewer', command: 'reviewer', args: [] },
        model: null,
        prompt: ({ round, authorReply }: { round: number; authorReply: string }) =>
          `REVIEWER round=${round}; author=${authorReply}`,
      },
    };
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round, prompt }: { role: 'AUTHOR' | 'REVIEWER'; round: number; prompt: string }) => {
      if (role === 'AUTHOR') return `implementation ${round}`;
      if (prompt.includes('Your previous review did not include a valid machine-readable Spar verdict')) {
        return 'SPAR_VERDICT: REJECTED';
      }
      return round === 1 ? '  \n\t ' : 'APPROVED\nRecovery verified after the retry.';
    });

    const result = await runAuthorReviewerLoop({ config, renderer });
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('Reviewer returned an empty response.');
    expect(secondAuthorPrompt).toContain('Do not assume approval.');
    expect(renderer.onResult).toHaveBeenCalledWith(expect.objectContaining({ approved: true, rounds: 2 }));
  });

  it('treats a post-approval failure sentence as rejection and carries it into the next author round', async () => {
    const renderer = {
      onLaunching: vi.fn(),
      onResult: vi.fn(),
    };
    const config = {
      cwd: process.cwd(),
      maxRounds: 2,
      trace: false,
      tui: false,
      authorSettings: {
        agent: { id: 'author', displayName: 'Author', command: 'author', args: [] },
        model: null,
        prompt: ({ round, feedback }: { round: number; feedback: string }) =>
          `AUTHOR round=${round}; feedback=${feedback || '<none>'}`,
      },
      reviewerSettings: {
        agent: { id: 'reviewer', displayName: 'Reviewer', command: 'reviewer', args: [] },
        model: null,
        prompt: ({ round, authorReply }: { round: number; authorReply: string }) =>
          `REVIEWER round=${round}; author=${authorReply}`,
      },
    };
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) => {
      if (role === 'AUTHOR') return `implementation ${round}`;
      return round === 1
        ? 'APPROVED\nVerification failed on Windows after restart.'
        : 'APPROVED\nRecovery verified after the retry.';
    });

    const result = await runAuthorReviewerLoop({ config, renderer });
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('Verification failed on Windows after restart.');
    expect(renderer.onResult).toHaveBeenCalledWith(expect.objectContaining({ approved: true, rounds: 2 }));
  });

  it('does not emit a final renderer result while a post-approval continuation is still pending', async () => {
    const renderer = {
      onLaunching: vi.fn(),
      onResult: vi.fn(),
    };
    let resolveApproval;
    let markApprovalPending;
    const approvalPending = new Promise<void>((resolve) => {
      markApprovalPending = resolve;
    });
    const config = {
      cwd: process.cwd(),
      maxRounds: 1,
      trace: false,
      tui: false,
      task: 'initial task',
      onApproved: vi.fn().mockImplementation(() => {
        markApprovalPending?.();
        return new Promise((resolve) => {
          resolveApproval = resolve;
        });
      }),
      authorSettings: {
        agent: { id: 'author', displayName: 'Author', command: 'author', args: [] },
        model: null,
        prompt: ({ round, feedback }: { round: number; feedback: string }) =>
          `AUTHOR round=${round}; feedback=${feedback || '<none>'}`,
      },
      reviewerSettings: {
        agent: { id: 'reviewer', displayName: 'Reviewer', command: 'reviewer', args: [] },
        model: null,
        prompt: ({ round, authorReply }: { round: number; authorReply: string }) =>
          `REVIEWER round=${round}; author=${authorReply}`,
      },
    };
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : 'implementation 1',
    );

    const runPromise = runAuthorReviewerLoop({ config, renderer });
    await approvalPending;

    expect(renderer.onResult).not.toHaveBeenCalled();

    resolveApproval?.({ continue: false });

    await expect(runPromise).resolves.toMatchObject({ approved: true, rounds: 1 });
    expect(renderer.onResult).toHaveBeenCalledTimes(1);
  });
});
