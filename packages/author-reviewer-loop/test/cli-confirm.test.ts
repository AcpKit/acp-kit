import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: mocks.createInterface,
}));

const {
  confirmDangerIgnoreApproval,
  confirmRun,
  confirmRunRecovery,
  formatDangerIgnoreApprovalWarning,
  formatRecoveryPromptSummary,
} = await import('../lib/cli/confirm.mjs');

const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

describe('CLI confirmation prompt', () => {
  beforeEach(() => {
    mocks.createInterface.mockReset();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY });
  });

  it('asks the operator to start the run with the correct prompt text', async () => {
    const question = vi.fn().mockResolvedValue('y');
    const close = vi.fn();
    mocks.createInterface.mockReturnValue({ question, close });

    await expect(confirmRun()).resolves.toBe(true);

    expect(question).toHaveBeenCalledWith('Start run? [y/N] ');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the default answer as no when the operator submits an empty reply', async () => {
    const question = vi.fn().mockResolvedValue('');
    const close = vi.fn();
    mocks.createInterface.mockReturnValue({ question, close });

    await expect(confirmRun()).resolves.toBe(false);

    expect(question).toHaveBeenCalledWith('Start run? [y/N] ');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('asks before resuming an interrupted run and defaults to no', async () => {
    const question = vi.fn().mockResolvedValue('');
    const close = vi.fn();
    mocks.createInterface.mockReturnValue({ question, close });

    await expect(confirmRunRecovery({
      updatedAt: Date.UTC(2026, 4, 2, 6, 7, 8),
      loop: { pending: { type: 'reviewer-turn', round: 2 } },
    })).resolves.toBe(false);

    expect(question).toHaveBeenCalledWith('Resume interrupted Spar run? [y/N] ');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('preserves recovery checkpoints when confirmation is not interactive', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    await expect(confirmRunRecovery({
      updatedAt: Date.UTC(2026, 4, 2, 6, 7, 8),
      loop: { pending: { type: 'reviewer-turn', round: 2 } },
    })).resolves.toBeNull();

    expect(mocks.createInterface).not.toHaveBeenCalled();
  });

  it('formats recovery confirmation with the pending step', () => {
    expect(formatRecoveryPromptSummary({
      updatedAt: Date.UTC(2026, 4, 2, 6, 7, 8),
      loop: { pending: { type: 'approval-decision', round: 3 } },
    })).toContain('Pending step: approval-decision round 3.');
  });

  it('requires two exact confirmations for danger-ignore-approval', async () => {
    const question = vi
      .fn()
      .mockResolvedValueOnce('RUN ALL ROUNDS')
      .mockResolvedValueOnce('IGNORE APPROVAL');
    const close = vi.fn();
    mocks.createInterface.mockReturnValue({ question, close });

    await expect(confirmDangerIgnoreApproval({ maxRounds: 3 })).resolves.toBe(true);

    expect(question).toHaveBeenCalledWith('Type RUN ALL ROUNDS to continue: ');
    expect(question).toHaveBeenCalledWith('Type IGNORE APPROVAL to confirm: ');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refuses danger-ignore-approval in non-interactive terminals', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    await expect(confirmDangerIgnoreApproval({ maxRounds: 3 })).resolves.toBe(false);

    expect(mocks.createInterface).not.toHaveBeenCalled();
  });

  it('formats danger-ignore-approval warning with the round count', () => {
    expect(formatDangerIgnoreApprovalWarning({ maxRounds: 4 })).toContain('run all 4 round(s)');
    expect(formatDangerIgnoreApprovalWarning({ maxRounds: 4 })).toContain('required even when --yes');
  });
});
