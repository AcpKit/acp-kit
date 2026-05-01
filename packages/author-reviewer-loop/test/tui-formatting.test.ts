import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PaneStatus, Phase } from '../lib/engine.mjs';
import {
  formatTuiAvailabilityLabel,
  formatTuiDashboardTitle,
  formatTuiDetailRowWrapMode,
  formatTuiEmptyState,
  formatTuiFinishSummary,
  formatTuiPaneHeadlineFitted,
  formatTuiPaneHeadline,
  formatTuiPaneSummary,
  formatTuiPaneStatusLine,
  formatTuiPreferenceStatus,
  formatTuiPlanSummary,
  formatTuiReasoningLabel,
  formatTuiTerminalTitle,
  formatTuiToolSize,
  formatTuiTaskEditorWaitingTitle,
  formatTuiUsageLabel,
  formatTuiForceContinueDecision,
  formatTuiPrimaryFooterKeys,
  formatTuiHelpKeybindings,
  formatTuiSetupFooterKeys,
  formatTuiConfirmSummaryRows,
  formatSparSplashFrame,
  formatSparBrandFrame,
  formatTuiAnimationLabel,
  isTuiApprovalActionPending,
  shouldPatchTuiChrome,
  renderTaskPreviewRows,
  renderFixedTaskPreviewRows,
  wrapTuiDisplayRows,
  fitTuiDisplayText,
} from '../lib/renderers/tui.mjs';

describe('author-reviewer-loop TUI formatting helpers', () => {
  it('keeps the always-visible footer focused on primary controls only', () => {
    const footer = formatTuiPrimaryFooterKeys({ phase: Phase.Running, taskTruncated: true });
    const labels = footer.map((item) => item.label);
    const keys = footer.map((item) => item.key);

    expect(labels).toEqual(['round', 'scroll', 'focus', 'help', 'quit']);
    expect(keys).not.toEqual(expect.arrayContaining(['t', 'w', 'g', 'e', 'v', 'Enter', '[/]/', '[ / ]']));
    expect(labels).not.toEqual(expect.arrayContaining(['trace', 'wrap', 'latest', 'edit', 'task', 'tool', 'detail']));
  });

  it('keeps advanced TUI controls discoverable in help instead of the primary footer', () => {
    const help = formatTuiHelpKeybindings();
    const helpKeys = help.map(([key]) => key);

    expect(helpKeys).toEqual(expect.arrayContaining(['t', 'w', 'g', 'G', 'e', 'v', '[ / ]', 'Enter / d', 'f', '?']));
  });

  it('keeps setup footer minimal and leaves advanced setup actions out of the primary line', () => {
    expect(formatTuiSetupFooterKeys({ mode: 'summary', taskTruncated: true })).toEqual([
      'Tab',
      '\u2191/\u2193',
      'Space',
      'Enter',
      '?',
      'q',
    ]);
  });

  it('omits advanced diagnostic state from the launch confirmation summary', () => {
    const rows = formatTuiConfirmSummaryRows({
      cwd: 'G:/workspace',
      taskSource: { kind: 'text' },
      taskLines: ['fix bugs'],
      author: 'Copilot',
      authorModel: 'gpt-5.4',
      reviewer: 'Codex',
      reviewerModel: 'gpt-5.5',
      maxRounds: 20,
      trace: true,
    });

    expect(rows.map(([label]) => label)).not.toContain('trace:    ');
  });

  it('does not patch animated chrome over setup, confirm, editor, cancelled, or terminal screens', () => {
    const launching = { phase: Phase.Launching };

    expect(shouldPatchTuiChrome({ state: launching, view: { screen: 'flow' } })).toBe(true);
    expect(shouldPatchTuiChrome({ state: launching, view: { screen: 'flow', awaitingSetup: true } })).toBe(false);
    expect(shouldPatchTuiChrome({ state: launching, view: { screen: 'flow', awaitingConfirm: true } })).toBe(false);
    expect(shouldPatchTuiChrome({ state: launching, view: { screen: 'flow', editingTask: true } })).toBe(false);
    expect(shouldPatchTuiChrome({ state: launching, view: { screen: 'flow', cancelled: true } })).toBe(false);
    expect(shouldPatchTuiChrome({ state: launching, view: { screen: 'trace' } })).toBe(false);
    expect(shouldPatchTuiChrome({ state: { phase: Phase.Done }, view: { screen: 'flow' } })).toBe(false);
  });

  it('summarizes run status in the dashboard header across lifecycle states', () => {
    expect(formatTuiDashboardTitle({
      phase: Phase.Launching,
      result: null,
      selectedRound: null,
      totalRounds: 0,
      maxRounds: 4,
    })).toBe('• Spar · Launching · Standing by for round 1');

    expect(formatTuiDashboardTitle({
      phase: Phase.Done,
      result: { approved: true },
      selectedRound: 2,
      totalRounds: 2,
      maxRounds: 5,
    })).toBe('• Spar · Approved · Round 2/5');

    expect(formatTuiDashboardTitle({
      phase: Phase.Error,
      result: null,
      selectedRound: 1,
      totalRounds: 1,
      maxRounds: 3,
    })).toBe('• Spar · Error · Round 1/3');
  });

  it('keeps long task previews bounded and preserves the full-task hint', () => {
    const preview = renderFixedTaskPreviewRows(
      'Investigate an extremely long task with many nested details and failure cases '.repeat(8),
      38,
      { maxRows: 2 },
    );

    expect(preview.rows).toHaveLength(2);
    expect(preview.truncated).toBe(true);
    expect(preview.rows[1]).toContain('[v view full task, e edit]');
  });

  it('handles empty, short, and degenerate-width task previews without losing the task affordance', () => {
    expect(renderTaskPreviewRows(undefined, 40)).toEqual({
      rows: ['task:     (empty)'],
      truncated: false,
    });

    expect(renderTaskPreviewRows('short task', 40)).toEqual({
      rows: ['task:     short task'],
      truncated: false,
    });

    const zeroWidth = renderTaskPreviewRows('', 0, { maxRows: 2 });
    expect(zeroWidth.truncated).toBe(true);
    expect(zeroWidth.rows).toHaveLength(2);
    expect(zeroWidth.rows.every((row) => row.length <= 1)).toBe(true);

    const oneColumn = renderTaskPreviewRows('a', 1, { maxRows: 2 });
    expect(oneColumn.truncated).toBe(true);
    expect(oneColumn.rows).toHaveLength(2);
    expect(oneColumn.rows.every((row) => row.length <= 1)).toBe(true);

    const narrow = renderTaskPreviewRows('Investigate a long recovery task with lots of detail', 8, { maxRows: 2 });
    expect(narrow.truncated).toBe(true);
    expect(narrow.rows.every((row) => row.length <= 8)).toBe(true);
  });

  it('keeps wrapped display rows bounded even when the pane width collapses to zero', () => {
    expect(wrapTuiDisplayRows('Huge recovery transcript that should never leak past zero-width panes', 0)).toEqual(['']);
    expect(wrapTuiDisplayRows('abc def ghi', 4)).toEqual(['abc', 'def', 'ghi']);
    const longTokenRows = wrapTuiDisplayRows('websocket-output-without-spaces', 9);
    expect(longTokenRows.every((row) => row.length <= 9)).toBe(true);
    expect(longTokenRows.join('')).not.toContain('...');
  });

  it('keeps long unbroken wrapped display rows intact and bounded', () => {
    const rows = wrapTuiDisplayRows('websocket', 2);

    expect(rows).toEqual(['we', 'bs', 'oc', 'ke', 't']);
    expect(rows.join('')).toBe('websocket');
    expect(rows.join(' ')).not.toContain('we bcosket');
    expect(rows.every((row) => row.length <= 2)).toBe(true);
  });

  it('uses safe detail row wrap defaults outside React view scope', () => {
    expect(formatTuiDetailRowWrapMode()).toBe('truncate-end');
    expect(formatTuiDetailRowWrapMode({ wrapped: false })).toBe('truncate-end');
    expect(formatTuiDetailRowWrapMode({ wrapped: true })).toBe('truncate-clip');
  });

  it('formats tool output size as lines before characters', () => {
    expect(formatTuiToolSize({ lines: 3, chars: 120 })).toBe('3 lines · 120 chars');
    expect(formatTuiToolSize({ lines: 1, chars: 8 })).toBe('1 line · 8 chars');
    expect(formatTuiToolSize({ lines: 0, chars: 8 })).toBe('8 chars');
    expect(formatTuiToolSize({ lines: 3, chars: 0 })).toBe('3 lines');
    expect(formatTuiToolSize({ lines: 0, chars: 0 })).toBe('');
  });

  it('formats structured tool output size using pretty JSON rows', () => {
    const prettyRows = JSON.stringify({ content: ['alpha', 'beta'] }, null, 2).split('\n').length;
    expect(formatTuiToolSize({ lines: prettyRows, chars: 34 })).toBe(`${prettyRows} lines · 34 chars`);
  });

  it('renders compact pane headlines without noisy counts', () => {
    expect(formatTuiPaneHeadline({
      role: 'AUTHOR',
      round: 2,
      status: PaneStatus.Running,
      agent: 'Copilot',
      model: 'gpt-5.5',
    })).toBe('AUTHOR · Round 2 · ▶ Running · Copilot (gpt-5.5)');
  });

  it('keeps truncated model labels from showing a dangling open parenthesis', () => {
    const fitted = fitTuiDisplayText(formatTuiPaneHeadline({
      role: 'AUTHOR',
      round: 1,
      status: 'launching',
      agent: 'GitHub Copilot',
      model: 'gpt-5.4/high',
    }), 57, { ellipsis: true });

    expect(fitted).not.toMatch(/\([^)]*$/);
    expect(fitted).toContain(')');
    expect(fitted).toContain('...');
  });

  it('keeps the closing parenthesis after a truncated model label', () => {
    const fitted = formatTuiPaneHeadlineFitted({
      role: 'REVIEWER',
      round: 12,
      status: PaneStatus.Running,
      agent: 'Codex',
      model: 'gpt-5.5/xhigh',
      width: 40,
    });

    expect(fitted).toMatch(/\([^)]*\.\.\.\)/);
    expect(fitted).not.toMatch(/\([^)]*\.\.\.$/);
  });

  it('sanitizes blank role labels and startup availability copy for professional presentation', () => {
    expect(formatTuiPaneHeadline({
      role: 'REVIEWER',
      round: 9,
      status: PaneStatus.Completed,
      agent: ' \n ',
      model: ' ',
    })).toBe('REVIEWER · Round 9 · ✓ Ready · (choose) (default)');

    expect(formatTuiAvailabilityLabel({ status: 'ready' })).toBe('Ready');
    expect(formatTuiAvailabilityLabel({ status: 'auto' })).toBe('Via npx');
    expect(formatTuiAvailabilityLabel({ status: 'weird' })).toBe('Unavailable');
  });

  it('keeps plan and pane summaries stable for contradictory or malformed plan entries', () => {
    const entries = [
      { content: 'Harden restart recovery', status: 'completed' },
      null,
      { content: 'Resolve contradictory reviewer guidance', status: 'in_progress' },
      { content: 'Handle malformed adapter output', status: 'failed' },
    ];

    expect(formatTuiPlanSummary(entries)).toBe('Plan 1/4 ✓·→! · working: Resolve contradictory reviewer guidance');
    expect(formatTuiPaneStatusLine({
      pane: {
        tools: [{ id: 't1' }, { id: 't2' }],
        reasoning: { blocks: [{ id: 'r1' }] },
        chars: 8192,
      },
      plan: { entries },
    })).toEqual({
      text: 'Plan 1/4 ✓·→! · working: Resolve contradictory reviewer guidance',
      color: 'cyan',
      dim: false,
    });
  });

  it('truncates oversized plan and empty-state guidance before it can flood narrow panes', () => {
    const longInstruction = 'Recover after contradictory reviewer guidance and malformed LLM output without losing the restarted session state '.repeat(2);
    const entries = [{ content: longInstruction, status: 'in_progress' }];
    const planSummary = formatTuiPlanSummary(entries);
    const emptyState = formatTuiEmptyState({
      role: 'AUTHOR',
      pane: {},
      status: PaneStatus.Pending,
      phase: Phase.Running,
      selectedRound: 4,
      plan: { entries },
    });

    expect(planSummary).toMatch(/^Plan 0\/1 → · working: Recover after contradictory reviewer guidance/);
    expect(planSummary).toContain('...');
    expect(emptyState).toMatch(/^Waiting for this turn to start\. Up next: Recover after contradictory reviewer guidance/);
    expect(emptyState).toContain('...');
  });

  it('keeps plan summaries stable for empty and all-null plan payloads', () => {
    expect(formatTuiPlanSummary([])).toBe('Plan --');
    expect(formatTuiPlanSummary([null, undefined, null])).toBe('Plan 0/3 ···');
  });

  it('summarizes pane activity defensively when transcript metadata is partial or missing', () => {
    expect(formatTuiPaneSummary({
      pane: { tools: null, reasoning: undefined, chars: undefined },
      plan: null,
    })).toBe('No plan or transcript yet.');

    expect(formatTuiPaneSummary({
      pane: {
        tools: [{ id: 'tool-1' }, { id: 'tool-2' }],
        reasoning: { blocks: [{ id: 'r1' }, { id: 'r2' }] },
        chars: 4096,
      },
      plan: { entries: [{ status: 'completed' }, { status: 'pending' }] },
    })).toBe('2 tools · 2 thoughts · 4096 chars · plan 1/2');
  });

  it('formats rich token usage without dropping available telemetry', () => {
    expect(formatTuiUsageLabel(null)).toBe('tokens --');
    expect(formatTuiUsageLabel({
      used: 12_345,
      size: 200_000,
      inputTokens: 100_000,
      outputTokens: 25_000,
      totalTokens: 125_000,
      cachedReadTokens: 10_000,
      cachedWriteTokens: 500,
      thoughtTokens: 7_500,
      cost: 0.0123,
    })).toBe('ctx 12.3K/200K · total 125K in 100K out 25K · cache r10K w500 · think 7.5K · $0.01');
  });
  it('prefers error and stop-reason status lines before falling back to pane summaries', () => {
    expect(formatTuiPaneStatusLine({
      pane: { error: 'disk full while persisting transcript' },
      plan: { entries: [{ content: 'irrelevant', status: 'completed' }] },
    })).toEqual({
      text: 'error: disk full while persisting transcript',
      color: 'red',
      dim: false,
    });

    expect(formatTuiPaneStatusLine({
      pane: { stopReason: 'end_turn' },
      plan: { entries: [{ content: 'still irrelevant', status: 'in_progress' }] },
    })).toEqual({
      text: 'completed: end turn',
      color: undefined,
      dim: true,
    });

    expect(formatTuiPaneStatusLine({
      pane: {
        tools: [{ id: 'tool-1' }],
        reasoning: { blocks: [] },
        chars: 12,
      },
      plan: null,
    })).toEqual({
      text: '1 tool · 12 chars',
      color: undefined,
      dim: true,
    });
  });

  it('sanitizes malformed stop reasons, save-path copy, and finish summaries before they reach the chrome', () => {
    expect(formatTuiPaneStatusLine({
      pane: { error: '\u001b[31mdisk\nfull\twhile saving\u001b[0m' },
      plan: null,
    })).toEqual({
      text: 'error: disk full while saving',
      color: 'red',
      dim: false,
    });

    expect(formatTuiPaneStatusLine({
      pane: { stopReason: 'end_turn_after_retry' },
      plan: null,
    })).toEqual({
      text: 'completed: end turn after retry',
      color: undefined,
      dim: true,
    });

    expect(formatTuiPreferenceStatus({
      save: true,
      path: 'C:\\Users\\admin\\.acp-author-reviewer-loop.json',
    })).toBe('Save defaults · On (C:\\Users\\admin\\.acp-author-reviewer-loop.json)');

    expect(formatTuiPreferenceStatus({
      save: false,
      path: 'ignored',
    })).toBe('Save defaults · Off');

    expect(formatTuiFinishSummary({ rounds: 2, maxRounds: 5 })).toBe('Approved · 2/5 rounds · ready for handoff');
  });

  it('surfaces actionable empty states for launching, pending, completed, and failed panes', () => {
    expect(formatTuiEmptyState({
      role: 'AUTHOR',
      pane: null,
      status: 'launching',
      phase: Phase.Launching,
      selectedRound: null,
      plan: null,
    })).toBe('Launching AUTHOR session...');

    expect(formatTuiEmptyState({
      role: 'REVIEWER',
      pane: {},
      status: PaneStatus.Pending,
      phase: Phase.Running,
      selectedRound: 2,
      plan: { entries: [{ content: 'Verify the huge-input path', status: 'pending' }] },
    })).toBe('Waiting for this turn to start. Up next: Verify the huge-input path');

    expect(formatTuiEmptyState({
      role: 'AUTHOR',
      pane: {},
      status: PaneStatus.Completed,
      phase: Phase.Done,
      selectedRound: 1,
      plan: null,
    })).toBe('Turn completed without visible output in this pane.');

    expect(formatTuiEmptyState({
      role: 'REVIEWER',
      pane: { error: 'disk full while saving transcript' },
      status: PaneStatus.Failed,
      phase: Phase.Error,
      selectedRound: 1,
      plan: null,
    })).toBe('Turn failed before output reached this pane.');
  });

  it('shows detailed startup phase text when a role has progressed past generic launching', () => {
    expect(formatTuiEmptyState({
      role: 'AUTHOR',
      pane: null,
      status: 'launching',
      phase: Phase.Launching,
      selectedRound: null,
      plan: null,
      roleStatus: 'spawning via npx...',
    })).toBe('spawning via npx...');

    expect(formatTuiEmptyState({
      role: 'REVIEWER',
      pane: null,
      status: 'launching',
      phase: Phase.Launching,
      selectedRound: null,
      plan: null,
      roleStatus: 'handshaking...',
    })).toBe('handshaking...');
  });

  it('tells users when the loop has not started a first round yet', () => {
    expect(formatTuiEmptyState({
      role: 'AUTHOR',
      pane: {},
      status: PaneStatus.Pending,
      phase: Phase.Idle,
      selectedRound: null,
      plan: null,
    })).toBe('Standing by for round 1.');
  });

  it('formats animated terminal tab titles for major TUI states', () => {
    expect(formatTuiTerminalTitle({ awaitingSetup: true, frame: 0 })).toBe('Spar · setup');
    expect(formatTuiTerminalTitle({ awaitingConfirm: true, frame: 1 })).toBe('Spar · confirm');
    expect(formatTuiTerminalTitle({ editingTask: true, frame: 2 })).toBe('Spar · editing task');
    expect(formatTuiTerminalTitle({ state: { phase: Phase.Launching }, frame: 1 })).toBe('Spar ◓ · Launching');
    expect(formatTuiTerminalTitle({
      state: {
        phase: Phase.Running,
        latest: 2,
        order: [1, 2],
        rounds: new Map([[2, {
          AUTHOR: { status: PaneStatus.Completed },
          REVIEWER: { status: PaneStatus.Running },
        }]]),
      },
      frame: 0,
    })).toBe('Spar ◐ · R2');
    expect(formatTuiTerminalTitle({ state: { phase: Phase.Done, result: { approved: true } } })).toBe('Spar · approved');
  });

  it('animates only the statuses that should visibly move in the TUI chrome', () => {
    expect(formatTuiAnimationLabel('launching', 1)).toBe(' \\');
    expect(formatTuiAnimationLabel(PaneStatus.Running, 0)).toBe(' ▰▱▱▱▱▱▱▱');
    expect(formatTuiAnimationLabel(PaneStatus.Pending, 0)).toBe(' ·  ');
    expect(formatTuiAnimationLabel(PaneStatus.Completed, 0)).toBe('');
    expect(formatTuiAnimationLabel(PaneStatus.Failed, 0)).toBe('');
    expect(formatTuiAnimationLabel('unknown', 0)).toBe('');
  });

  it('keeps task-editor waiting copy static without spinner chrome', () => {
    const title = formatTuiTaskEditorWaitingTitle();

    expect(title).toBe('Opening task editor');
    expect(title).not.toMatch(/^[-\\|/]\s/);
  });

  it('keeps approval actions live as soon as the approval resolver exists', () => {
    expect(isTuiApprovalActionPending({
      state: { phase: Phase.Done, result: { approved: true }, approvalPending: true },
      hasPendingApproval: true,
    })).toBe(true);

    expect(isTuiApprovalActionPending({
      state: { phase: Phase.Running, result: null, approvalPending: false },
      hasPendingApproval: true,
    })).toBe(true);

    expect(isTuiApprovalActionPending({
      state: { phase: Phase.Done, result: { approved: true }, approvalPending: false },
      hasPendingApproval: false,
    })).toBe(false);
  });

  it('maps the force-continue key to a continuation approval decision', () => {
    const decision = formatTuiForceContinueDecision('fix the flaky tests');

    expect(decision).toMatchObject({ continue: true });
    expect(decision.feedback).toContain('user requested another round');
    expect(decision.feedback).toContain('fix the flaky tests');
  });

  it('formats reasoning sections with stable numbered labels instead of raw ids', () => {
    expect(formatTuiReasoningLabel(1)).toBe(' thinking #1 ');
    expect(formatTuiReasoningLabel(2)).toBe(' thinking #2 ');
    expect(formatTuiReasoningLabel(undefined as unknown as number)).toBe(' thinking #1 ');
  });

  it('builds the SPAR boxing-gloves banner as a single row with two gloves', () => {
    const row = formatSparSplashFrame({ frame: 0, width: 60, useEmoji: true });
    expect(typeof row.text).toBe('string');
    // Two glove emojis present on a non-impact frame.
    expect((row.text.match(/\u{1F94A}/gu) || []).length).toBe(2);
    expect(row.impact).toBe(false);
  });

  it('flags the impact frame and renders the spark glyph between gloves', () => {
    const row = formatSparSplashFrame({ frame: 4, width: 60, useEmoji: true });
    expect(row.impact).toBe(true);
    expect(row.text).toContain('\u2736');
  });

  it('falls back to ASCII gloves when emoji rendering is disabled', () => {
    const row = formatSparSplashFrame({ frame: 0, width: 50, useEmoji: false });
    expect(row.text).toContain('[X]');
    expect(row.text).not.toMatch(/\u{1F94A}/u);
  });

  it('loops the gloves animation by taking the modulo of the frame index', () => {
    // After a full cycle the frame state should match the starting frame
    // again. This is what keeps the banner animating indefinitely while
    // launching, instead of freezing on a final still.
    const first = formatSparSplashFrame({ frame: 0, width: 60, useEmoji: true });
    const wrapped = formatSparSplashFrame({ frame: 8, width: 60, useEmoji: true });
    expect(wrapped.text).toBe(first.text);
    expect(wrapped.impact).toBe(first.impact);
  });

  it('keeps the banner readable even when given an absurdly small width', () => {
    const row = formatSparSplashFrame({ frame: 0, width: 4, useEmoji: true });
    expect(typeof row.text).toBe('string');
    expect(row.text.length).toBeGreaterThan(0);
  });
  it('renders the SPAR brand row with the title centered and gloves on both sides', () => {
    const row = formatSparBrandFrame({ frame: 0, width: 60, title: 'Spar', useEmoji: true });
    expect((row.text.match(/\u{1F94A}/gu) || []).length).toBe(2);
    expect(row.text).toContain('Spar');
    const firstGlove = row.text.indexOf('\u{1F94A}');
    const lastGlove = row.text.lastIndexOf('\u{1F94A}');
    expect(lastGlove).toBeGreaterThan(firstGlove);
    expect(row.impact).toBe(false);
  });

  it('keeps the animated brand row free of truncation dots near the right glove', () => {
    const title = formatTuiDashboardTitle({
      phase: Phase.Launching,
      result: null,
      selectedRound: null,
      totalRounds: 0,
      maxRounds: 4,
    });
    const row = formatSparBrandFrame({ frame: 0, width: 42, title, useEmoji: true, animated: true });

    expect(row.text).not.toContain('...');
    expect(row.text).not.toMatch(/\u{1F94A}\.+/u);
  });

  it('marks the impact frame on the brand row and renders sparks', () => {
    const row = formatSparBrandFrame({ frame: 4, width: 60, title: 'Spar', useEmoji: true });
    expect(row.impact).toBe(true);
    expect(row.text).toContain('\u2736');
    expect(row.text).toContain('Spar');
  });

  it('falls back to ASCII gloves on the brand row when emoji is disabled', () => {
    const row = formatSparBrandFrame({ frame: 0, width: 60, title: 'Spar', useEmoji: false });
    expect(row.text).toContain('[X]');
    expect(row.text).not.toMatch(/\u{1F94A}/u);
    expect(row.text).toContain('Spar');
  });

  it('fits pane headlines without leaving a partial model parenthesis', () => {
    const fitted = formatTuiPaneHeadlineFitted({
      role: 'AUTHOR',
      round: 1,
      status: 'launching',
      agent: 'GitHub Copilot',
      model: 'gpt-5.4/high',
      width: 43,
    });
    expect(fitted).not.toMatch(/\([^)]*$/);
    expect(fitted).toContain(')');
  });

  it('keeps TUI detail row helper independent from React view state', () => {
    const source = readFileSync(new URL('../lib/renderers/tui.mjs', import.meta.url), 'utf8');
    const rowTextMatch = source.match(/function rowText\([^]*?\n  \}/);
    const detailCalls = [...source.matchAll(/rowText\(row === '' \? ' ' : row, [^\n]+, \{ clipped: view\.wrap \}\)/g)];

    expect(rowTextMatch?.[0]).toBeTruthy();
    expect(rowTextMatch?.[0]).not.toContain('view.');
    expect(rowTextMatch?.[0]).toContain('formatTuiDetailRowWrapMode');
    expect(detailCalls).toHaveLength(4);
  });
});
