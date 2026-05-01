import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectInstalledAgents, isCommandOnPath } from '@acp-kit/core';
import { createLoopEngine, PaneStatus, Phase } from '../engine.mjs';
import { applyRoleSelection } from '../cli/config.mjs';
import { agentChoices, defaultModelForAgent, modelChoicesForAgent } from '../config/agents.mjs';
import { writePreferences } from '../config/preferences.mjs';
import { createStartupProfiler } from '../runtime/startup-profile.mjs';

const DEFAULT_EDITOR_TIMEOUT_MS = 30 * 60 * 1000;
const ENGINE_RENDER_FRAME_MS = 250;
const TUI_TITLE_FRAME_MS = 350;
const TUI_CHROME_FRAME_MS = 220;
const TUI_ANIMATION_SLOT_WIDTH = 9;
const ASCII_ELLIPSIS = '...';
const TUI_STATIC_STATUS_MARK = '•';
const TUI_SPINNER_FRAMES = ['-', '\\', '|', '/'];
const TUI_TITLE_SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const TUI_WAIT_FRAMES = ['·  ', ' · ', '  ·', ' · '];
const TUI_PROGRESS_FRAMES = ['▰▱▱▱▱▱▱▱', '▰▰▱▱▱▱▱▱', '▱▰▰▱▱▱▱▱', '▱▱▰▰▱▱▱▱', '▱▱▱▰▰▱▱▱', '▱▱▱▱▰▰▱▱', '▱▱▱▱▱▰▰▱', '▱▱▱▱▱▱▰▰'];
const FINISH_ANIMATION_FRAME_MS = 70;
const FINISH_ANIMATION_FRAMES = 24;

// Frame interval for the SPAR boxing-gloves banner shown while the
// engine cold-starts its two ACP agents. Kept short enough (~120 ms)
// for fluid motion. The banner is a slim 3-row strip above the
// author/reviewer split (NOT a full-screen splash) so users always see
// the panes and know which agents are starting.
// Per-frame inner gap (in columns) between the two gloves. The cycle
// approaches → clashes → recoils → approaches again, looping
// indefinitely so users keep seeing motion while launching takes time.
const SPAR_SPLASH_GAPS = [16, 12, 8, 4, 0, 4, 8, 12];
// Frames within the cycle that count as "impact" — gap == 0. Used to
// trigger the spark glyph and bold wordmark accent.
const SPAR_SPLASH_IMPACT_INDEX = 4;
// Boxing glove emoji renders as a wide character (2 columns) in most
// modern terminals (Windows Terminal, iTerm2, kitty, alacritty,
// gnome-terminal). Falls back to "[X]" / "[X]" for terminals without
// emoji support — controlled by `process.env.ACP_SPLASH_NO_EMOJI`.
const SPAR_SPLASH_GLOVE_EMOJI = '\u{1F94A}'; // 🥊
const SPAR_SPLASH_GLOVE_FALLBACK = '[X]';

export function parseEditorCommand(raw, { platform = process.platform } = {}) {
  const parsed = splitCommandLine(String(raw ?? '').trim(), { platform });
  if (parsed.length === 0) return { command: String(raw ?? '').trim(), args: [] };
  return { command: parsed[0], args: parsed.slice(1) };
}

export function splitCommandLine(value, { platform = process.platform } = {}) {
  const parts = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (platform !== 'win32' && char === '\\' && quote !== "'" && shouldEscapeNext(value[index + 1])) {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (current) parts.push(current);
  return parts;
}

function shouldEscapeNext(char) {
  return char === '\\' || char === '"' || char === "'" || /\s/.test(char || '');
}

export function commitSetupSelections(config, setup, { savePreferences = writePreferences } = {}) {
  applyRoleSelection(config, {
    author: {
      agentId: config.authorSettings.agentSource === 'env' ? config.authorSettings.agentId : setup.selections.authorAgentId,
      model: config.authorSettings.modelSource === 'env' ? config.authorSettings.model : setup.selections.authorModel,
      agentSource: config.authorSettings.agentSource === 'env' ? 'env' : 'tui',
      modelSource: config.authorSettings.modelSource === 'env' ? 'env' : 'tui',
    },
    reviewer: {
      agentId: config.reviewerSettings.agentSource === 'env' ? config.reviewerSettings.agentId : setup.selections.reviewerAgentId,
      model: config.reviewerSettings.modelSource === 'env' ? config.reviewerSettings.model : setup.selections.reviewerModel,
      agentSource: config.reviewerSettings.agentSource === 'env' ? 'env' : 'tui',
      modelSource: config.reviewerSettings.modelSource === 'env' ? 'env' : 'tui',
    },
  });

  if (!setup.selections.save) return;
  savePreferences({
    author: {
      agent: setup.selections.authorAgentId,
      model: setup.selections.authorModel,
    },
    reviewer: {
      agent: setup.selections.reviewerAgentId,
      model: setup.selections.reviewerModel,
    },
  }, {
    filePath: config.preferencesPath,
  });
}

function sanitizeDisplayText(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function displayCharWidth(char) {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    code >= 0x1100 && (
      code <= 0x115f
      || code === 0x2329
      || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
    )
  ) return 2;
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) width += displayCharWidth(char);
  return width;
}

function fitText(text, width, { ellipsis = false } = {}) {
  const safeWidth = Math.max(0, width);
  const value = String(text ?? '');
  if (safeWidth === 0) return { text: '', width: 0 };
  const ellipsisText = ellipsis ? fitAsciiEllipsis(safeWidth) : '';
  const ellipsisWidth = displayWidth(ellipsisText);
  const target = ellipsis ? Math.max(0, safeWidth - ellipsisWidth) : safeWidth;
  let used = 0;
  let result = '';
  for (const char of value) {
    const charWidth = displayWidth(char);
    if (used + charWidth > target) break;
    result += char;
    used += charWidth;
  }
  if (ellipsis && used < displayWidth(value)) {
    result = closeDanglingParen(result, target);
    used = displayWidth(result);
    result += ellipsisText;
    used += ellipsisWidth;
  }
  return { text: result, width: used };
}

function fitAsciiEllipsis(width) {
  return ASCII_ELLIPSIS.slice(0, Math.max(0, Math.min(ASCII_ELLIPSIS.length, width)));
}

function closeDanglingParen(text, maxWidth) {
  let result = String(text ?? '').trimEnd();
  if (result.lastIndexOf('(') <= result.lastIndexOf(')')) return result;
  while (result && displayWidth(result) + 1 > maxWidth) result = result.slice(0, -1).trimEnd();
  return result.lastIndexOf('(') > result.lastIndexOf(')') ? `${result})` : result;
}
export function fitTuiDisplayText(text, width, options = {}) {
  return fitText(text, width, options).text;
}

function lineCount(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value ? value.split('\n').length : 0;
  try {
    return JSON.stringify(value, null, 2).split('\n').length;
  } catch {
    const text = String(value);
    return text ? text.split('\n').length : 0;
  }
}

export function formatTuiToolSize({ lines = 0, chars = 0 } = {}) {
  const parts = [];
  if (Number.isFinite(lines) && lines > 0) parts.push(pluralize(lines, 'line'));
  if (Number.isFinite(chars) && chars > 0) parts.push(`${chars} chars`);
  return parts.join(' · ');
}

function wrapDisplayLine(line, cols) {
  line = sanitizeDisplayText(line);
  if (cols <= 0) return [''];
  if (displayWidth(line) <= cols) return [line];
  const out = [];
  let rest = line;
  while (displayWidth(rest) > cols) {
    let cut = fitText(rest, cols).text.length;
    let wordCut = rest.lastIndexOf(' ', cut);
    while (wordCut > 0 && displayWidth(rest.slice(0, wordCut)) > cols) {
      wordCut = rest.lastIndexOf(' ', wordCut - 1);
    }
    if (wordCut > 0) cut = wordCut;
    if (cut <= 0) cut = 1;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export function wrapTuiDisplayRows(line, cols) {
  return wrapDisplayLine(line, cols);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function cleanDisplayLabel(value, fallback) {
  const cleaned = compactWhitespace(sanitizeDisplayText(value ?? ''));
  return cleaned || fallback;
}

function humanizeToken(value, fallback = '') {
  const cleaned = cleanDisplayLabel(String(value ?? '').replace(/[_-]+/g, ' '), fallback);
  return cleaned;
}

function statusLabel(status) {
  if (status === PaneStatus.Running) return 'Running';
  if (status === PaneStatus.Completed) return 'Ready';
  if (status === PaneStatus.Failed) return 'Failed';
  if (status === PaneStatus.Pending) return 'Waiting';
  if (status === 'launching') return 'Launching';
  return compactWhitespace(String(status || 'waiting')) || 'Waiting';
}

function statusGlyph(status) {
  if (status === PaneStatus.Running) return '▶';
  if (status === PaneStatus.Completed) return '✓';
  if (status === PaneStatus.Failed) return '✖';
  if (status === PaneStatus.Pending) return '...';
  if (status === 'launching') return '◌';
  return '•';
}

function taskSummary(task) {
  const summary = compactWhitespace(String(task || '(empty)'));
  return summary || '(empty)';
}

export function renderTaskPreviewRows(task, cols, { prefix = 'task:     ', maxRows = 2 } = {}) {
  const safeCols = Math.max(1, cols);
  const rows = wrapDisplayLine(`${prefix}${taskSummary(task)}`, safeCols);
  if (rows.length <= maxRows) return { rows, truncated: false };
  const hint = ' ... [v view full task, e edit]';
  const visible = rows.slice(0, maxRows);
  const lastIndex = visible.length - 1;
  const fittedHint = fitText(hint, safeCols, { ellipsis: true }).text;
  const hintWidth = displayWidth(fittedHint);
  const room = Math.max(0, safeCols - hintWidth);
  const prefixText = room > 0
    ? fitText(visible[lastIndex], room, { ellipsis: true }).text.trimEnd()
    : '';
  visible[lastIndex] = `${prefixText}${fittedHint}`;
  return { rows: visible, truncated: true };
}

export function renderFixedTaskPreviewRows(task, cols, options = {}) {
  const { rows, truncated } = renderTaskPreviewRows(task, cols, options);
  const maxRows = options.maxRows ?? 2;
  const padded = rows.slice(0, maxRows);
  while (padded.length < maxRows) padded.push('');
  return { rows: padded, truncated };
}

export function formatTuiDashboardTitle({ phase, result, selectedRound, totalRounds, maxRounds }) {
  const phaseText = phase === Phase.Done
    ? (result?.approved ? 'Approved' : 'Needs review')
    : phase === Phase.Error
      ? 'Error'
      : phase === Phase.Running
        ? 'Running'
        : phase === Phase.Launching
        ? 'Launching'
        : 'Ready';
  const roundText = totalRounds > 0
    ? `Round ${selectedRound ?? totalRounds}/${Math.max(totalRounds, maxRounds ?? totalRounds)}`
    : 'Standing by for round 1';
  return `${TUI_STATIC_STATUS_MARK} Spar · ${phaseText} · ${roundText}`;
}

export function formatTuiPaneHeadline({ role, round, status, agent, model }) {
  const parts = [
    role,
    `Round ${round ?? '-'}`,
    `${statusGlyph(status)} ${statusLabel(status)}`,
    `${cleanDisplayLabel(agent, '(choose)')} (${cleanDisplayLabel(model, 'default')})`,
  ];
  return parts.join(' · ');
}

export function formatTuiPaneHeadlineFitted({ role, round, status, agent, model, width }) {
  const safeWidth = Math.max(1, width);
  const prefix = [
    role,
    `Round ${round ?? '-'}`,
    `${statusGlyph(status)} ${statusLabel(status)}`,
  ].join(' · ');
  const modelLabel = `(${cleanDisplayLabel(model, 'default')})`;
  const agentLabel = cleanDisplayLabel(agent, '(choose)');
  const full = `${prefix} · ${agentLabel} ${modelLabel}`;
  if (displayWidth(full) <= safeWidth) return full;

  const modelWidth = Math.min(displayWidth(modelLabel), Math.max(2, Math.floor(safeWidth * 0.38)));
  const fittedModel = fitModelLabel(modelLabel, modelWidth);
  const agentWidth = Math.max(0, safeWidth - displayWidth(prefix) - displayWidth(' · ') - displayWidth(' ') - displayWidth(fittedModel));
  if (agentWidth >= 4) {
    return `${prefix} · ${fitText(agentLabel, agentWidth, { ellipsis: true }).text} ${fittedModel}`;
  }
  const modelOnlyWidth = Math.max(0, safeWidth - displayWidth(prefix) - displayWidth(' · '));
  if (modelOnlyWidth >= 2) {
    return `${prefix} · ${fitModelLabel(modelLabel, modelOnlyWidth)}`;
  }
  return fitText(prefix, safeWidth, { ellipsis: true }).text;
}

function fitModelLabel(modelLabel, width) {
  const safeWidth = Math.max(0, width);
  if (displayWidth(modelLabel) <= safeWidth) return modelLabel;
  if (safeWidth < 2) return fitText(modelLabel, safeWidth, { ellipsis: true }).text;
  const inner = modelLabel.slice(1, -1);
  const innerWidth = Math.max(0, safeWidth - 2);
  return `(${fitText(inner, innerWidth, { ellipsis: true }).text})`;
}
export function formatTuiPlanSummary(entries) {
  const normalized = Array.isArray(entries) ? entries : [];
  if (normalized.length === 0) return 'Plan --';
  const total = normalized.length;
  const completed = normalized.filter((entry) => entry?.status === 'completed').length;
  const glyphs = normalized
    .map((entry) => {
      if (entry?.status === 'completed') return '✓';
      if (entry?.status === 'in_progress') return '→';
      if (entry?.status === 'failed' || entry?.status === 'cancelled') return '!';
      return '·';
    })
    .join('');
  const focus = normalized.find((entry) => entry?.status === 'in_progress')
    ?? normalized.find((entry) => entry?.status === 'pending')
    ?? normalized.find((entry) => compactWhitespace(entry?.content));
  const focusContent = fitText(compactWhitespace(focus?.content || ''), 72, { ellipsis: true }).text;
  const focusLabel = focusContent
    ? ` · ${focus?.status === 'in_progress' ? 'working' : 'next'}: ${focusContent}`
    : '';
  return `Plan ${completed}/${total} ${glyphs}${focusLabel}`;
}

export function formatTuiPaneSummary({ pane, plan }) {
  const tools = Array.isArray(pane?.tools) ? pane.tools.length : 0;
  const reasoning = Array.isArray(pane?.reasoning?.blocks) ? pane.reasoning.blocks.length : 0;
  const chars = Number.isFinite(pane?.chars) ? pane.chars : 0;
  const planEntries = Array.isArray(plan?.entries) ? plan.entries : [];
  const completed = planEntries.filter((entry) => entry?.status === 'completed').length;
  const parts = [];
  if (tools > 0) parts.push(pluralize(tools, 'tool'));
  if (reasoning > 0) parts.push(pluralize(reasoning, 'thought'));
  if (chars > 0) parts.push(`${chars} chars`);
  if (planEntries.length > 0) parts.push(`plan ${completed}/${planEntries.length}`);
  return parts.join(' · ') || 'No plan or transcript yet.';
}

export function formatTuiEmptyState({ role, pane, status, phase, selectedRound, plan, roleStatus }) {
  const planEntries = Array.isArray(plan?.entries) ? plan.entries : [];
  const focus = planEntries.find((entry) => entry?.status === 'in_progress')
    ?? planEntries.find((entry) => entry?.status === 'pending')
    ?? planEntries.find((entry) => compactWhitespace(entry?.content));
  const focusContent = fitText(compactWhitespace(focus?.content || ''), 72, { ellipsis: true }).text;
  if (pane?.error) return 'Turn failed before output reached this pane.';
  if (typeof roleStatus === 'string' && roleStatus.length > 0 && phase === Phase.Launching) {
    if (roleStatus === 'ready') return 'Ready.';
    if (roleStatus !== 'launching') return roleStatus;
  }
  if (status === 'launching' || phase === Phase.Launching) return `Launching ${role} session...`;
  if (selectedRound == null) return 'Standing by for round 1.';
  if (status === PaneStatus.Pending) {
    return focusContent
      ? `Waiting for this turn to start. Up next: ${focusContent}`
      : 'Waiting for this turn to start.';
  }
  if (status === PaneStatus.Completed) return 'Turn completed without visible output in this pane.';
  if (status === PaneStatus.Failed) return 'Turn failed before output reached this pane.';
  return 'No output yet.';
}

export function formatTuiPaneStatusLine({ pane, plan }) {
  if (pane?.error) return { text: `error: ${cleanDisplayLabel(pane.error, 'unknown error')}`, color: 'red', dim: false };
  if (pane?.stopReason) return { text: `completed: ${humanizeToken(pane.stopReason)}`, color: undefined, dim: true };
  if (plan?.entries?.length) return { text: formatTuiPlanSummary(plan.entries), color: 'cyan', dim: false };
  return { text: formatTuiPaneSummary({ pane, plan }), color: undefined, dim: true };
}

export function formatTuiAvailabilityLabel(availability) {
  if (availability?.status === 'ready') return 'Ready';
  if (availability?.status === 'auto') return 'Via npx';
  return 'Unavailable';
}

export function formatTuiPreferenceStatus({ save, path }) {
  if (!save) return 'Save defaults · Off';
  return `Save defaults · On (${cleanDisplayLabel(path, '(default path)')})`;
}

export function formatTuiFinishSummary({ rounds, maxRounds }) {
  const safeRounds = Number.isFinite(rounds) ? Math.max(0, rounds) : 0;
  const safeMaxRounds = Number.isFinite(maxRounds) ? Math.max(safeRounds, maxRounds) : safeRounds;
  return `Approved · ${safeRounds}/${safeMaxRounds} rounds · ready for handoff`;
}

export function formatTuiReasoningLabel(index) {
  const safeIndex = Number.isInteger(index) && index > 0 ? index : 1;
  return ` thinking #${safeIndex} `;
}

export function formatTuiPrimaryFooterKeys({ phase, taskTruncated = false } = {}) {
  const keys = [
    { key: '\u2190/\u2192', label: 'round' },
    { key: '\u2191/\u2193', label: 'scroll' },
    { key: 'Tab', label: 'focus' },
    { key: '?', label: 'help' },
    { key: 'q', label: 'quit' },
  ];
  if (phase === Phase.Error) keys.splice(keys.length - 1, 0, { key: 'x', label: 'error' });
  return keys;
}

export function formatTuiHelpKeybindings() {
  return [
    ['\u2190 / \u2192', 'Move between rounds'],
    ['\u2191 / \u2193', 'Scroll focused pane up/down by 1 line'],
    ['PgUp/PgDn', 'Scroll focused pane by 10 lines'],
    ['j / k', 'Same as down/up arrows'],
    ['Tab', 'Switch focused pane (AUTHOR \u2194 REVIEWER)'],
    ['g', 'Jump to latest round, re-enable follow'],
    ['G', 'Reset scroll to bottom in focused pane'],
    ['[ / ]', 'Select previous/next tool call in focused pane'],
    ['Enter / d', 'Open selected tool call details'],
    ['Esc / q', 'Return from tool detail view'],
    ['v', 'View full task text'],
    ['e', 'Edit task text'],
    ['t', 'Toggle ACP trace view'],
    ['w', 'Toggle soft wrap'],
    ['?', 'Toggle this help'],
    ['f', 'Force another round after reviewer approval'],
    ['q', 'Quit (only after the run completes)'],
  ];
}

export function formatTuiSetupFooterKeys({ mode = 'summary', taskTruncated = false } = {}) {
  if (mode === 'customModel') return ['type', 'Enter', 'Esc', 'q'];
  if (mode === 'model') return ['\u2191/\u2193', 'Enter', 'Esc/b', 'q'];
  return ['Tab', '\u2191/\u2193', 'Space', 'Enter', '?', 'q'];
}

export function formatTuiConfirmSummaryRows(config = {}) {
  const taskLines = Array.isArray(config.taskLines) ? config.taskLines : [config.task ?? ''];
  return [
    ['cwd:      ', config.cwd ?? ''],
    ['task src: ', config.taskSource?.kind === 'file' ? config.taskSource.path : '(inline text)'],
    ['task:     ', taskLines[0] ?? ''],
    ...taskLines.slice(1).map((row) => ['          ', row]),
    ['author:   ', config.author ?? ''],
    ['          model: ', config.authorModel || '(agent default)'],
    ['reviewer: ', config.reviewer ?? ''],
    ['          model: ', config.reviewerModel || '(agent default)'],
    ['rounds:   ', `max ${config.maxRounds ?? ''}`],
  ];
}

export function shouldPatchTuiChrome({ state, view } = {}) {
  return !(
    view?.screen !== 'flow'
    || view?.awaitingSetup
    || view?.awaitingConfirm
    || view?.editingTask
    || view?.cancelled
    || state?.phase === Phase.Done
    || state?.phase === Phase.Error
  );
}

/**
 * Build the SPAR brand row shown as the first line of the header box.
 * The product name (e.g. `Spar · Launching · ...`) is rendered in the
 * exact center of the row. While the engine is launching, two boxing
 * gloves enter from the left and right edges and step closer to the
 * title each frame, clash, then recoil — looping forever.
 *
 * When `animated` is false the gloves are pinned at the edges (max gap)
 * and `impact` is always false, giving a static brand line for the
 * Running / Done / Error phases.
 *
 * Returns `{ text, impact }` where `impact` is true on the clash frame
 * (caller renders that frame in yellow + bold).
 */
export function formatSparBrandFrame({ frame = 0, width = 60, title = 'Spar', useEmoji = true, animated = true } = {}) {
  const SPARK = '\u2736';
  const glove = useEmoji ? SPAR_SPLASH_GLOVE_EMOJI : SPAR_SPLASH_GLOVE_FALLBACK;
  const gloveWidth = useEmoji ? 2 : SPAR_SPLASH_GLOVE_FALLBACK.length;
  const safeTitle = String(title ?? 'Spar');
  const titleW = displayWidth(safeTitle);
  const minWidth = titleW + gloveWidth * 2 + 4;
  const safeWidth = Math.max(minWidth, Math.floor(width) || minWidth);

  const safeFrame = Math.max(0, Math.floor(frame) || 0);
  const gapIndex = safeFrame % SPAR_SPLASH_GAPS.length;
  const gapBase = animated ? SPAR_SPLASH_GAPS[gapIndex] : SPAR_SPLASH_GAPS[0];
  const impact = animated && gapIndex === SPAR_SPLASH_IMPACT_INDEX;

  const halfRoom = Math.floor((safeWidth - titleW) / 2) - gloveWidth;
  const dist = impact ? 1 : Math.min(gapBase, Math.max(0, halfRoom));
  const leftFiller = impact ? `${SPARK} ` : ' '.repeat(Math.max(0, dist));
  const rightFiller = impact ? ` ${SPARK}` : ' '.repeat(Math.max(0, dist));
  const middleW = gloveWidth + displayWidth(leftFiller) + titleW + displayWidth(rightFiller) + gloveWidth;
  const totalEdge = Math.max(0, safeWidth - middleW);
  const leftEdge = Math.floor(totalEdge / 2);
  const rightEdge = totalEdge - leftEdge;

  const text = `${' '.repeat(leftEdge)}${glove}${leftFiller}${safeTitle}${rightFiller}${glove}${' '.repeat(rightEdge)}`;
  return { text, impact };
}

/**
 * Build a single text row of the SPAR boxing-gloves banner shown while
 * the engine is cold-starting agents. Two gloves approach each other
 * along one row, clash, recoil, and loop. Pure / deterministic so it
 * can be unit-tested without Ink.
 *
 * Returns `{ text, impact }` where `impact` is true on the gap-0 frame
 * (gloves clash → caller renders the row in yellow + bold + spark).
 *
 * The banner is rendered as a slim strip ABOVE the author/reviewer
 * panes — never as a full-screen splash — so users always retain the
 * mental model of "two agents are starting".
 */
export function formatSparSplashFrame({ frame = 0, width = 60, useEmoji = true } = {}) {
  const safeWidth = Math.max(20, Math.floor(width) || 20);
  const glove = useEmoji ? SPAR_SPLASH_GLOVE_EMOJI : SPAR_SPLASH_GLOVE_FALLBACK;
  // 🥊 displays as 2 columns wide in most terminals; the fallback is 3.
  const gloveWidth = useEmoji ? 2 : SPAR_SPLASH_GLOVE_FALLBACK.length;
  const safeFrame = Math.max(0, Math.floor(frame) || 0);
  const gapIndex = safeFrame % SPAR_SPLASH_GAPS.length;
  const gap = SPAR_SPLASH_GAPS[gapIndex];
  const impact = gapIndex === SPAR_SPLASH_IMPACT_INDEX;

  // Compose the strip: <glove><gap or spark><glove>, centered in width.
  const innerSpark = impact ? ' \u2736 ' : ' '.repeat(Math.max(1, gap));
  const stripCore = `${glove}${innerSpark}${glove}`;
  const stripDisplayWidth = gloveWidth * 2 + (impact ? 3 : Math.max(1, gap));
  const leftPad = Math.max(0, Math.floor((safeWidth - stripDisplayWidth) / 2));
  const text = `${' '.repeat(leftPad)}${stripCore}`;
  return { text, impact };
}

export function formatTuiTokenCount(tokens) {
  if (!Number.isFinite(tokens)) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.?0+$/, '')}K`;
  return String(tokens);
}

function formatCost(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return '';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTuiUsageLabel(usage) {
  const parts = [];
  const used = Number.isFinite(usage?.used) ? usage.used : 0;
  const size = Number.isFinite(usage?.size) ? usage.size : 0;
  if (used > 0 || size > 0) {
    parts.push(`ctx ${formatTuiTokenCount(used)}/${formatTuiTokenCount(size)}`);
  }

  const input = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
  const output = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0;
  const total = Number.isFinite(usage?.totalTokens) ? usage.totalTokens : input + output;
  if (total > 0 || input > 0 || output > 0) {
    const tokenParts = [];
    if (total > 0) tokenParts.push(`total ${formatTuiTokenCount(total)}`);
    if (input > 0) tokenParts.push(`in ${formatTuiTokenCount(input)}`);
    if (output > 0) tokenParts.push(`out ${formatTuiTokenCount(output)}`);
    parts.push(tokenParts.join(' '));
  }

  const cachedRead = Number.isFinite(usage?.cachedReadTokens) ? usage.cachedReadTokens : 0;
  const cachedWrite = Number.isFinite(usage?.cachedWriteTokens) ? usage.cachedWriteTokens : 0;
  if (cachedRead > 0 || cachedWrite > 0) {
    parts.push(`cache r${formatTuiTokenCount(cachedRead)} w${formatTuiTokenCount(cachedWrite)}`);
  }

  const thoughts = Number.isFinite(usage?.thoughtTokens) ? usage.thoughtTokens : 0;
  if (thoughts > 0) parts.push(`think ${formatTuiTokenCount(thoughts)}`);

  const cost = formatCost(usage?.cost);
  if (cost) parts.push(cost);

  return parts.join(' · ') || 'tokens --';
}
export function formatTuiTerminalTitle({ state, frame = 0, awaitingSetup = false, awaitingConfirm = false, editingTask = false, screen = 'flow', cancelled = false } = {}) {
  const spinner = TUI_TITLE_SPINNER_FRAMES[frame % TUI_TITLE_SPINNER_FRAMES.length];
  if (cancelled) return 'Spar · cancelled';
  if (editingTask) return 'Spar · editing task';
  if (awaitingSetup) return 'Spar · setup';
  if (awaitingConfirm) return 'Spar · confirm';
  if (state?.phase === Phase.Error) return 'Spar · error';
  if (state?.phase === Phase.Done) return state.result?.approved ? 'Spar · approved' : 'Spar · not approved';
  if (state?.phase === Phase.Launching) return `Spar ${spinner} · Launching`;

  const latestRound = state?.latest ?? state?.order?.[state.order.length - 1] ?? null;
  const roundText = latestRound != null ? `R${latestRound}` : 'R-';
  if (screen && screen !== 'flow') return `Spar ${spinner} · ${screen}`;
  return `Spar ${spinner} · ${roundText}`;
}

export function formatTuiAnimationLabel(status, frame = 0) {
  if (status === 'launching') return ` ${TUI_SPINNER_FRAMES[frame % TUI_SPINNER_FRAMES.length]}`;
  if (status === PaneStatus.Running) return ` ${TUI_PROGRESS_FRAMES[frame % TUI_PROGRESS_FRAMES.length]}`;
  if (status === PaneStatus.Pending) return ` ${TUI_WAIT_FRAMES[frame % TUI_WAIT_FRAMES.length]}`;
  return '';
}

export function formatTuiTaskEditorWaitingTitle() {
  return 'Opening task editor';
}

export function isTuiApprovalActionPending({ state, hasPendingApproval } = {}) {
  return Boolean(hasPendingApproval);
}

export function formatTuiForceContinueDecision(task) {
  return {
    continue: true,
    feedback: `The reviewer approved, but the user requested another round. Re-check the current task and make any further improvements needed:\n${task}`,
  };
}

/**
 * Ink-based TUI renderer.
 *
 * Design principles (the previous implementation violated all three):
 *   1. The TUI must always occupy exactly the visible terminal viewport.
 *      We pin the root <Box> to `stdout.rows` x `stdout.columns` so Ink
 *      never lays out beyond the screen edges.
 *   2. Content must NEVER overflow off-screen. Every container uses
 *      `overflow="hidden"`. Each pane has a fixed height computed from the
 *      remaining viewport budget; long pane content is scrolled internally
 *      via a per-pane scroll offset rather than by growing the layout.
 *   3. The TUI uses the alternate screen buffer (\x1b[?1049h / l) so it
 *      owns the screen for the duration of the run and leaves the user's
 *      scrollback intact when it exits.
 *
 * Lazy-imports `ink` and `react` so the plain CLI does not pay for them.
 * Returns 0 on approval, 1 otherwise.
 */
export async function runTui({ config }) {
  const startupProfiler = createStartupProfiler({ scope: 'tui-startup' });
  startupProfiler.mark({ phase: 'tui startup begin', detail: { cwd: config.cwd } });
  let ink;
  let React;
  try {
    [ink, React] = await Promise.all([import('ink'), import('react')]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Ink TUI mode requires the optional `ink` and `react` packages.\n'
        + `Install them or rerun with --cli.\nUnderlying error: ${detail}`,
    );
  }

  const { render, Box, Text, useApp, useInput, useStdout } = ink;
  const {
    createElement: h,
    useEffect,
    useState,
    useReducer,
    useMemo,
  } = React;

  let approvalResolver = null;
  let approvalBellRung = false;
  config.onApproved = () => new Promise((resolve) => {
    approvalResolver = resolve;
  });

  function resolveApproval(decision) {
    if (decision?.continue) approvalBellRung = false;
    const resolve = approvalResolver;
    approvalResolver = null;
    resolve?.(decision);
  }

  function hasPendingApproval() {
    return Boolean(approvalResolver);
  }

  function forceContinueAfterApproval() {
    resolveApproval(formatTuiForceContinueDecision(config.task));
  }

  let engine = null;

  // -- TTY guard -----------------------------------------------------------
  // The TUI requires a real terminal both to draw and to read confirmation;
  // refuse loudly on non-TTY before touching the screen so we never leave
  // half-rendered escape sequences in the user's pipeline output.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      '--tui requires an interactive terminal (stdin and stdout must be TTY).\n'
        + 'Re-run with --cli or attach a TTY.',
    );
  }

  // -- alt screen buffer ---------------------------------------------------
  let altScreenActive = false;
  function enterAltScreen() {
    if (!process.stdout.isTTY || altScreenActive) return;
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
    altScreenActive = true;
  }
  function leaveAltScreen() {
    if (!altScreenActive) return;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    altScreenActive = false;
  }
  function setTerminalTitle(title) {
    if (!process.stdout.isTTY) return;
    const safe = sanitizeDisplayText(title).replace(/[\u0007\u001b]/g, '').slice(0, 120);
    process.stdout.write(`\x1b]2;${safe}\x07`);
  }
  enterAltScreen();
  const restore = () => {
    setTerminalTitle('Spar · closed');
    leaveAltScreen();
  };
  const handleSigint = () => { restore(); process.exit(130); };
  const handleSigterm = () => { restore(); process.exit(143); };
  process.on('exit', restore);
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  // -- helpers -------------------------------------------------------------
  function paneStatusColor(status) {
    if (status === PaneStatus.Running) return 'yellow';
    if (status === PaneStatus.Completed) return 'green';
    if (status === PaneStatus.Failed) return 'red';
    return 'gray';
  }

  function toolStatusColor(status) {
    if (status === 'partial-failed') return '#ffa500';
    if (status === 'failed' || status === 'error') return 'red';
    if (status === 'completed' || status === 'done' || status === 'success') return 'green';
    return 'yellow';
  }

  function toolStatusLabel(status) {
    return status === 'completed' ? 'done' : status;
  }

  function line(child, key) {
    return h(Box, { key, height: 1, overflow: 'hidden' }, child);
  }

  function rowText(text, key, { clipped = view.wrap } = {}) {
    return line(h(Text, { wrap: clipped ? 'truncate-clip' : 'truncate-end' }, text), key);
  }

  function muted(text) {
    return h(Text, { dimColor: true }, text);
  }

  function shortcutLabel(text, color = 'cyan') {
    return h(Text, { color, bold: true }, text);
  }

  function shortcutLine(...parts) {
    return h(Text, { wrap: 'truncate-end' }, ...parts);
  }

  function shortcutItems(items) {
    return items.flatMap((item, index) => [
      index === 0 ? null : muted('  '),
      shortcutLabel(item.key),
      muted(` ${item.label}`),
    ]).filter(Boolean);
  }

  function normalizeDisplayText(text) {
    return sanitizeDisplayText(text).replace(/([.!?])(?=[A-Z`])/g, '$1 ');
  }

  function stringifyValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const seen = new WeakSet();
    return JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) || '';
  }

  function truncateText(text, max) {
    const value = compactWhitespace(text);
    return fitText(value, max, { ellipsis: true }).text;
  }

  function firstLine(text) {
    return String(text || '').split('\n')[0] || '';
  }

  function taskPreviewRows(task, cols, { prefix = 'task:     ', maxRows = 2 } = {}) {
    return renderTaskPreviewRows(task, cols, { prefix, maxRows });
  }

  function fixedTaskPreviewRows(task, cols, options = {}) {
    return renderFixedTaskPreviewRows(task, cols, options);
  }

  function ensureEngine() {
    if (!engine) engine = createLoopEngine({ config });
    return engine;
  }

  function configuredAgentsAvailable() {
    if (!config.authorSettings.agent || !config.reviewerSettings.agent) return [];
    const agentsToCheck = [config.authorSettings.agent, config.reviewerSettings.agent];
    const unique = [...new Map(agentsToCheck.map((a) => [a.id, a])).values()];
    return detectInstalledAgents(unique).filter((r) => !r.installed);
  }

  function formatMissingAgentError(missing) {
    return [
      ...missing.map(({ agent }) =>
        `agent "${agent.displayName}" is not available - neither "${agent.command}" nor any fallback command was found on PATH.`),
      'Install the missing agent(s) or pick a different installed agent.',
    ].join('\n');
  }

  function agentName(settings) {
    return settings.agent?.displayName ?? '(choose)';
  }

  function agentSummary(settings) {
    return settings.agent
      ? `${settings.agent.displayName} (${settings.agent.id})`
      : '(choose)';
  }

  function createEmptyEngineState() {
    return {
      phase: Phase.Idle,
      order: [],
      rounds: new Map(),
      statuses: { AUTHOR: 'launching', REVIEWER: 'launching' },
      trace: [],
      result: null,
      error: null,
    };
  }

  function findField(value, names, depth = 0) {
    if (value == null || depth > 4) return '';
    if (typeof value === 'string') return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findField(item, names, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const [key, item] of Object.entries(value)) {
      if (names.includes(key) && (typeof item === 'string' || typeof item === 'number')) {
        return String(item);
      }
    }
    for (const item of Object.values(value)) {
      const found = findField(item, names, depth + 1);
      if (found) return found;
    }
    return '';
  }

  function summarizeValue(value, max = 90) {
    if (value == null) return '';
    const command = findField(value, ['command', 'cmd', 'shellCommand', 'script']);
    if (command) return truncateText(command, max);
    const text = stringifyValue(value);
    return truncateText(text, max);
  }

  function summarizeTool(item, { compact = false } = {}) {
    const status = toolStatusLabel(item.status || 'running');
    const title = item.title || item.name || item.toolCallId || 'tool';
    const input = summarizeValue(item.input, compact ? 44 : 80);
    const output = summarizeValue(item.output, compact ? 36 : 70);
    const parts = [`${item.tag || '#?'} ${status}`, title];
    if (input) parts.push(`cmd: ${input}`);
    if (output) parts.push(`out: ${output}`);
    const size = formatTuiToolSize({ lines: lineCount(item.output), chars: item.chars });
    if (size) parts.push(size);
    return parts.join(' - ');
  }

  function toolRunStats(items) {
    const failed = items.filter((item) => item.status === 'failed' || item.status === 'error').length;
    const running = items.filter((item) => !item.status || item.status === 'running').length;
    const done = items.filter((item) => ['completed', 'done', 'success'].includes(item.status)).length;
    return { total: items.length, done, failed, running };
  }

  function mergedToolStatus(items) {
    const stats = toolRunStats(items);
    if (stats.failed === items.length) return 'failed';
    if (stats.failed > 0) return 'partial-failed';
    if (stats.running > 0) return 'running';
    return items[items.length - 1]?.status || 'completed';
  }

  function summarizeToolRun(items) {
    const status = mergedToolStatus(items);
    const stats = toolRunStats(items);
    const parts = [`Tools x${stats.total}`, toolStatusLabel(status)];
    if (stats.running > 0) parts.push(`${stats.running} running`);
    if (stats.done > 0) parts.push(`${stats.done} done`);
    if (stats.failed > 0) parts.push(`${stats.failed} failed`);
    return parts.join(' · ');
  }

  function formatUsage(usage) {
    return formatTuiUsageLabel(usage);
  }

  function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs)) return 'time --';
    if (durationMs < 1000) return `time ${Math.max(0, Math.round(durationMs))}ms`;
    const seconds = durationMs / 1000;
    if (seconds < 60) return `time ${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `time ${minutes}m${String(rest).padStart(2, '0')}s`;
  }

  function paneElapsedMs(pane) {
    if (!pane) return null;
    if (Number.isFinite(pane.durationMs)) return pane.durationMs;
    if (Number.isFinite(pane.startedAt)) {
      const end = Number.isFinite(pane.finishedAt) ? pane.finishedAt : Date.now();
      return Math.max(0, end - pane.startedAt);
    }
    return null;
  }

  function animationLabel(status, frame) {
    return formatTuiAnimationLabel(status, frame);
  }

  // Soft-wrap one logical line to display rows. Prefer word boundaries; only
  // hard-cut when a single token is wider than the pane.
  function wrapLine(line, cols) {
    return wrapDisplayLine(line, cols);
  }

  function editorCommand() {
    const raw = process.env.VISUAL || process.env.EDITOR;
    if (raw && raw.trim()) return parseEditorCommand(raw);
    if (process.platform === 'win32') return { command: 'notepad.exe', args: [] };
    return { command: 'vi', args: [] };
  }

  function editorTimeoutMs() {
    const parsed = Number.parseInt(process.env.ACP_REVIEW_EDITOR_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EDITOR_TIMEOUT_MS;
  }

  function editTaskText(currentTask) {
    let tempDir;
    let previousRawMode = process.stdin.isRaw;
    let terminalReleased = false;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-task-'));
      const taskFile = path.join(tempDir, 'task.txt');
      fs.writeFileSync(taskFile, currentTask || '', 'utf8');
      const { command, args } = editorCommand();
      const timeout = editorTimeoutMs();
      leaveAltScreen();
      terminalReleased = true;
      previousRawMode = process.stdin.isRaw;
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      const result = spawnSync(command, [...args, taskFile], { stdio: 'inherit', timeout });
      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          throw new Error(`${command} timed out after ${Math.round(timeout / 1000)} seconds.`);
        }
        throw result.error;
      }
      if (result.signal) throw new Error(`${command} exited after signal ${result.signal}.`);
      if (result.status && result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
      return fs.readFileSync(taskFile, 'utf8').trimEnd();
    } finally {
      try {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      } finally {
        if (terminalReleased) {
          if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(previousRawMode));
          enterAltScreen();
        }
      }
    }
  }

  const agentIdByProfileId = new Map(agentChoices.map(({ id, agent }) => [agent.id, id]));

  const userCliCommands = Object.freeze({
    claude: ['claude'],
    codex: ['codex'],
    copilot: ['copilot-language-server', 'copilot'],
    gemini: ['gemini'],
    opencode: ['opencode'],
    qwen: ['qwen'],
  });

  // Startup UI separates user CLI installation from ACP launch capability.
  // Users care whether their normal CLI is present; launch fallback details are
  // internal and are summarized as Ready / Via npx / Unavailable.
  function agentAvailability(agent) {
    const commandFound = isCommandOnPath(agent.command);
    const fallbackFound = (agent.fallbackCommands ?? []).some((fallback) => isCommandOnPath(fallback.command));
    if (commandFound) return { status: 'ready', launchKind: 'local', commandFound, fallbackFound };
    if (fallbackFound) return { status: 'auto', launchKind: 'fallback', commandFound, fallbackFound };
    return { status: 'unavailable', launchKind: 'none', commandFound, fallbackFound };
  }

  startupProfiler.mark({ phase: 'agent detection begin', detail: { mode: 'tui', agentCount: agentChoices.length } });
  const availabilityByAgentId = new Map(agentChoices.map(({ id, agent }) => [id, agentAvailability(agent)]));
  const userCliByAgentId = new Map(agentChoices.map(({ id }) => [
    id,
    (userCliCommands[id] ?? []).some((command) => isCommandOnPath(command)),
  ]));
  startupProfiler.mark({
    phase: 'agent detection end',
    detail: {
      mode: 'tui',
      available: [...availabilityByAgentId.entries()]
        .filter(([, availability]) => availability.status !== 'unavailable')
        .map(([id]) => id),
    },
  });

  function agentOptions() {
    return agentChoices.map(({ id, agent }) => {
      const availability = availabilityByAgentId.get(id) ?? { status: 'unavailable' };
      return {
        id,
        agent,
        label: agent.displayName,
        availability,
        userCliFound: userCliByAgentId.get(id) ?? false,
        disabled: availability.status === 'unavailable',
      };
    });
  }

  function launchableAgentOptions() {
    return agentOptions().filter((option) => !option.disabled);
  }

  function firstLaunchableAgentId(preferredId) {
    const options = launchableAgentOptions();
    if (options.some((option) => option.id === preferredId)) return preferredId;
    return options.find((option) => option.availability.status === 'ready')?.id ?? options[0]?.id;
  }

  function selectableIndex(options, preferredId) {
    const preferred = options.findIndex((option) => option.id === preferredId && !option.disabled);
    if (preferred >= 0) return preferred;
    return Math.max(0, options.findIndex((option) => !option.disabled));
  }

  function createInitialSetupState() {
    const configuredAuthorAgentId = config.authorSettings.agentId
      ?? agentIdByProfileId.get(config.authorSettings.agent?.id);
    const configuredReviewerAgentId = config.reviewerSettings.agentId
      ?? agentIdByProfileId.get(config.reviewerSettings.agent?.id);
    const authorAgentId = config.authorSettings.agentSource === 'env'
      ? configuredAuthorAgentId
      : firstLaunchableAgentId(configuredAuthorAgentId ?? 'copilot');
    const reviewerAgentId = config.reviewerSettings.agentSource === 'env'
      ? configuredReviewerAgentId
      : firstLaunchableAgentId(configuredReviewerAgentId ?? 'codex');
    const required = !configuredAuthorAgentId
      || !configuredReviewerAgentId
      || availabilityByAgentId.get(configuredAuthorAgentId)?.status === 'unavailable'
      || availabilityByAgentId.get(configuredReviewerAgentId)?.status === 'unavailable'
      || config.authorSettings.model === undefined
      || config.reviewerSettings.model === undefined;
    const setup = {
      required,
      mode: 'summary',
      activeRole: 'author',
      cursor: 0,
      error: null,
      selections: {
        authorAgentId,
        authorModel: config.authorSettings.model === undefined ? defaultModelForAgent(authorAgentId) : config.authorSettings.model,
        reviewerAgentId,
        reviewerModel: config.reviewerSettings.model === undefined ? defaultModelForAgent(reviewerAgentId) : config.reviewerSettings.model,
        save: true,
      },
    };
    setup.cursor = defaultCursorForStep(setup);
    return setup;
  }

  function setupStepOptions(setup) {
    const mode = setup.mode;
    if (mode === 'model') {
      const role = setup.activeRole;
      const agentId = setup.selections[`${role}AgentId`];
      const current = setup.selections[`${role}Model`];
      return modelChoicesForAgent(agentId, current).map((choice) => ({
        id: choice.id,
        label: choice.label,
        value: choice.value,
        disabled: false,
      }));
    }
    return [];
  }

  function defaultCursorForStep(setup) {
    if (setup.mode === 'summary') {
      const options = agentOptions();
      return selectableIndex(options, setup.selections[`${setup.activeRole}AgentId`]);
    }
    const options = setupStepOptions(setup);
    if (setup.mode === 'model') {
      const role = setup.activeRole;
      const current = setup.selections[`${role}Model`];
      const idx = options.findIndex((option) => option.value === current);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  }

  function advanceSetup(setup) {
    if (setup.mode === 'summary') return finishSetup(setup);

    const options = setupStepOptions(setup);
    const option = options[setup.cursor];
    if (!option || option.disabled) {
      return { ...setup, error: option ? `${option.label} is unavailable.` : 'No selectable option.' };
    }

    const selections = { ...setup.selections };
    if (setup.mode === 'model') {
      const role = setup.activeRole;
      selections[`${role}Model`] = option.value;
    }

    const next = { ...setup, mode: 'summary', selections, error: null };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function finishSetup(setup) {
    if (!setup.selections.authorAgentId || !setup.selections.reviewerAgentId) {
      return { ...setup, error: 'No launchable AUTHOR/REVIEWER agent is selectable.' };
    }
    const authorAvailability = availabilityByAgentId.get(setup.selections.authorAgentId)?.status;
    const reviewerAvailability = availabilityByAgentId.get(setup.selections.reviewerAgentId)?.status;
    if (authorAvailability === 'unavailable' || reviewerAvailability === 'unavailable') {
      return { ...setup, error: 'Selected AUTHOR/REVIEWER agent is unavailable.' };
    }
    return { ...setup, done: true, error: null };
  }

  function moveSetupCursor(setup, delta) {
    const options = setup.mode === 'summary' ? agentOptions() : setupStepOptions(setup);
    if (options.length === 0) return setup;
    let next = setup.cursor;
    for (let i = 0; i < options.length; i += 1) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    return { ...setup, cursor: next, error: null };
  }

  function backSetup(setup) {
    if (setup.mode === 'summary') return setup;
    return { ...setup, mode: 'summary', cursor: 0, error: null };
  }

  function enterModelMode(setup) {
    if (setup.activeRole === 'author' && config.authorSettings.modelSource === 'env') return { ...setup, error: 'AUTHOR_MODEL is set by environment.' };
    if (setup.activeRole === 'reviewer' && config.reviewerSettings.modelSource === 'env') return { ...setup, error: 'REVIEWER_MODEL is set by environment.' };
    const next = { ...setup, mode: 'model', error: null };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function enterCustomModelMode(setup) {
    if (setup.activeRole === 'author' && config.authorSettings.modelSource === 'env') return { ...setup, error: 'AUTHOR_MODEL is set by environment.' };
    if (setup.activeRole === 'reviewer' && config.reviewerSettings.modelSource === 'env') return { ...setup, error: 'REVIEWER_MODEL is set by environment.' };
    const role = setup.activeRole;
    return {
      ...setup,
      mode: 'customModel',
      customModelInput: setup.selections[`${role}Model`] ?? '',
      cursor: 0,
      error: null,
    };
  }

  function updateCustomModelInput(setup, input) {
    return { ...setup, customModelInput: input, error: null };
  }

  function appendCustomModelInput(setup, input) {
    if (!input || /[\r\n\t]/.test(input)) return setup;
    return updateCustomModelInput(setup, `${setup.customModelInput ?? ''}${input}`);
  }

  function backspaceCustomModelInput(setup) {
    return updateCustomModelInput(setup, String(setup.customModelInput ?? '').slice(0, -1));
  }

  function applyCustomModelInput(setup) {
    const role = setup.activeRole;
    const raw = String(setup.customModelInput ?? '').trim();
    const next = {
      ...setup,
      mode: 'summary',
      selections: {
        ...setup.selections,
        [`${role}Model`]: raw || null,
      },
      customModelInput: '',
      error: null,
    };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function toggleSetupRole(setup) {
    const next = { ...setup, activeRole: setup.activeRole === 'author' ? 'reviewer' : 'author', error: null };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function assignSelectedAgent(setup) {
    const role = setup.activeRole;
    if (role === 'author' && config.authorSettings.agentSource === 'env') return { ...setup, error: 'AUTHOR_AGENT is set by environment.' };
    if (role === 'reviewer' && config.reviewerSettings.agentSource === 'env') return { ...setup, error: 'REVIEWER_AGENT is set by environment.' };
    const option = agentOptions()[setup.cursor];
    if (!option || option.disabled) return { ...setup, error: option ? `${option.label} is unavailable.` : 'No selectable agent.' };
    return {
      ...setup,
      selections: {
        ...setup.selections,
        [`${role}AgentId`]: option.id,
        [`${role}Model`]: defaultModelForAgent(option.id),
      },
      error: null,
    };
  }

  function toggleSetupSave(setup) {
    return { ...setup, selections: { ...setup.selections, save: !setup.selections.save }, error: null };
  }

  function agentDisplayName(agentId) {
    return agentChoices.find((choice) => choice.id === agentId)?.agent.displayName ?? '(choose)';
  }

  function userCliLabel(found) {
    return found ? 'Found' : 'Missing';
  }

  function userCliColor(found) {
    return found ? 'green' : 'red';
  }

  function setupModelLabel(agentId, model, userCliFound) {
    if (!userCliFound) return 'X';
    return model ?? '(agent default)';
  }

  function setupSourceLabel(setup, role) {
    const settings = role === 'author' ? config.authorSettings : config.reviewerSettings;
    if (settings.agentSource === 'env' || settings.modelSource === 'env') return 'env lock';
    if (setup.selections[`${role}AgentId`] !== settings.agentId || setup.selections[`${role}Model`] !== settings.model) return 'edited';
    if (settings.modelSource === 'tui' || settings.agentSource === 'tui') return 'tui';
    if (settings.modelSource === 'config' || settings.agentSource === 'config') return 'saved';
    if (settings.modelSource === 'default' || settings.agentSource === 'default') return 'default';
    return 'choose';
  }

  function setupSourceColor(setup, role) {
    const settings = role === 'author' ? config.authorSettings : config.reviewerSettings;
    if (settings.agentSource === 'env' || settings.modelSource === 'env') return 'yellow';
    if (setup.selections[`${role}AgentId`] !== settings.agentId || setup.selections[`${role}Model`] !== settings.model) return 'green';
    if (settings.modelSource === 'tui' || settings.agentSource === 'tui') return 'green';
    if (settings.modelSource === 'config' || settings.agentSource === 'config') return 'cyan';
    return 'gray';
  }

  function defaultModelLabel(option) {
    if (!option.userCliFound) return 'X';
    return defaultModelForAgent(option.id) ?? '(agent default)';
  }

  function availabilityColor(availability) {
    if (availability?.status === 'ready') return 'green';
    if (availability?.status === 'auto') return 'yellow';
    return 'gray';
  }

  function setupRoleStatus(setup, role) {
    return availabilityByAgentId.get(setup.selections[`${role}AgentId`]);
  }

  function setupRoleCliFound(setup, role) {
    return userCliByAgentId.get(setup.selections[`${role}AgentId`]) ?? false;
  }

  function padCell(value, width) {
    const fitted = fitText(sanitizeDisplayText(value), width, { ellipsis: true });
    return fitted.text + ' '.repeat(Math.max(0, width - fitted.width));
  }

  function padWrappedCell(value, width) {
    const fitted = fitText(sanitizeDisplayText(value), width, { ellipsis: false });
    return fitted.text + ' '.repeat(Math.max(0, width - fitted.width));
  }

  function padCellWithoutEllipsis(value, width) {
    const fitted = fitText(sanitizeDisplayText(value), width, { ellipsis: false });
    return fitted.text + ' '.repeat(Math.max(0, width - fitted.width));
  }

  function applySetupSelections(setup) {
    commitSetupSelections(config, setup);
  }

  const initialSetup = createInitialSetupState();

  // -- view state (separate from engine state) -----------------------------
  const initialView = {
    selected: null,    // round number currently focused
    follow: true,      // auto-jump to latest round
    focus: 'AUTHOR',   // which pane is active for scrolling
    screen: 'flow',     // flow | trace | tool | taskConfirm | finishing
    setup: initialSetup,
    awaitingSetup: !config.skipConfirm || initialSetup.required,
    selectedTool: null, // { round, role, toolCallId } used by the tool detail view
    pendingTask: null,
    editFromConfirm: false,
    editFromSetup: false,
    editingTask: false,
    editError: null,
    scrollAuthor: 0,   // 0 = bottom; positive = scrolled up by N lines
    scrollReviewer: 0,
    scrollTrace: 0,
    scrollTool: 0,
    scrollTask: 0,
    scrollError: 0,
    scrollConfirm: 0,
    wrap: true,        // soft wrap pane content
    showHelp: false,
    awaitingConfirm: false,
    cancelled: false,  // user pressed n/Esc on the confirm overlay
    finishFrame: 0,
  };
  function viewReducer(s, a) {
    switch (a.type) {
      case 'setupMove':
        return { ...s, setup: moveSetupCursor(s.setup, a.delta) };
      case 'setupBack':
        return { ...s, setup: backSetup(s.setup) };
      case 'setupModelMode':
        return { ...s, setup: enterModelMode(s.setup) };
      case 'setupCustomModelMode':
        return { ...s, setup: enterCustomModelMode(s.setup) };
      case 'setupCustomModelInput':
        return { ...s, setup: updateCustomModelInput(s.setup, a.input) };
      case 'setupCustomModelAppend':
        return { ...s, setup: appendCustomModelInput(s.setup, a.input) };
      case 'setupCustomModelBackspace':
        return { ...s, setup: backspaceCustomModelInput(s.setup) };
      case 'setupCustomModelApply':
        return { ...s, setup: applyCustomModelInput(s.setup) };
      case 'setupToggleRole':
        return { ...s, setup: toggleSetupRole(s.setup) };
      case 'setupAssignAgent':
        return { ...s, setup: assignSelectedAgent(s.setup) };
      case 'setupToggleSave':
        return { ...s, setup: toggleSetupSave(s.setup) };
      case 'setupChoose': {
        const setup = advanceSetup(s.setup);
        if (!setup.done) return { ...s, setup };
        try {
          applySetupSelections(setup);
          const missing = configuredAgentsAvailable();
          if (missing.length > 0) {
            return {
              ...s,
              setup: { ...setup, done: false, error: formatMissingAgentError(missing) },
            };
          }
          return { ...s, setup, awaitingSetup: false };
        } catch (error) {
          return {
            ...s,
            setup: {
              ...setup,
              done: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      case 'confirm':
        return { ...s, awaitingConfirm: false };
      case 'cancel':
        return { ...s, awaitingSetup: false, awaitingConfirm: false, cancelled: true };
      case 'select': {
        if (a.order.length === 0) return s;
        const cur = s.selected ?? a.order[a.order.length - 1];
        const idx = Math.max(0, a.order.indexOf(cur));
        const next = Math.max(0, Math.min(a.order.length - 1, idx + a.delta));
        const sel = a.order[next];
        return {
          ...s,
          selected: sel,
          follow: sel === a.order[a.order.length - 1],
          scrollAuthor: 0,
          scrollReviewer: 0,
        };
      }
      case 'jumpLatest':
        if (a.order.length === 0) return s;
        return { ...s, selected: a.order[a.order.length - 1], follow: true, scrollAuthor: 0, scrollReviewer: 0 };
      case 'autoFollow': {
        if (!s.follow || a.order.length === 0) return s;
        const latest = a.order[a.order.length - 1];
        if (s.selected === latest) return s;
        return { ...s, selected: latest };
      }
      case 'scroll': {
        const key = s.screen === 'trace'
          ? 'scrollTrace'
          : s.screen === 'error' ? 'scrollError'
          : s.screen === 'task' ? 'scrollTask'
          : s.screen === 'tool' ? 'scrollTool'
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        const next = Math.max(0, s[key] + a.delta);
        return { ...s, [key]: next };
      }
      case 'scrollEnd': {
        const key = s.screen === 'trace'
          ? 'scrollTrace'
          : s.screen === 'error' ? 'scrollError'
          : s.screen === 'task' ? 'scrollTask'
          : s.screen === 'tool' ? 'scrollTool'
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        return { ...s, [key]: 0 };
      }
      case 'scrollConfirm':
        return { ...s, scrollConfirm: Math.max(0, s.scrollConfirm + a.delta) };
      case 'scrollConfirmTop':
        return { ...s, scrollConfirm: 0 };
      case 'toggleTrace':
        return { ...s, screen: s.screen === 'trace' ? 'flow' : 'trace', scrollTrace: 0 };
      case 'showError':
        return { ...s, screen: s.screen === 'error' ? 'flow' : 'error', scrollError: 0 };
      case 'selectTool':
        return { ...s, selectedTool: a.tool };
      case 'openTool':
        return a.tool ? { ...s, selectedTool: a.tool, screen: 'tool', scrollTool: 0 } : s;
      case 'closeTool':
        return { ...s, screen: 'flow' };
      case 'openTask':
        return { ...s, screen: 'task', scrollTask: 0 };
      case 'closeTask':
        return { ...s, screen: 'flow' };
      case 'taskEdited':
        return {
          ...s,
          screen: 'taskConfirm',
          pendingTask: a.task,
          editFromConfirm: Boolean(a.fromConfirm),
          editFromSetup: Boolean(a.fromSetup),
          editingTask: false,
          editError: null,
          awaitingSetup: false,
          awaitingConfirm: false,
          scrollConfirm: 0,
        };
      case 'taskEditFailed':
        return { ...s, editingTask: false, editError: a.error };
      case 'taskEditStarted':
        return { ...s, editingTask: true, editError: null };
      case 'confirmTask':
        return { ...s, screen: 'flow', pendingTask: null, awaitingSetup: s.editFromSetup, editFromConfirm: false, editFromSetup: false, editingTask: false, editError: null };
      case 'discardTask':
        return { ...s, screen: 'flow', pendingTask: null, awaitingSetup: s.editFromSetup, awaitingConfirm: s.editFromConfirm, editFromConfirm: false, editFromSetup: false, editingTask: false, editError: null };
      case 'toggleFocus':
        return { ...s, focus: s.focus === 'AUTHOR' ? 'REVIEWER' : 'AUTHOR' };
      case 'toggleWrap':
        return { ...s, wrap: !s.wrap, scrollAuthor: 0, scrollReviewer: 0, scrollTrace: 0, scrollTool: 0, scrollTask: 0, scrollError: 0 };
      case 'toggleHelp':
        return { ...s, showHelp: !s.showHelp };
      case 'startFinish':
        return { ...s, screen: 'finishing', showHelp: false, finishFrame: 0 };
      case 'finishTick':
        return { ...s, finishFrame: Math.min(FINISH_ANIMATION_FRAMES, s.finishFrame + 1) };
      default:
        return s;
    }
  }

  // -- the App component ---------------------------------------------------
  let runDone = false;
  let runStarted = false;
  let runFailure = null;
  let runResult = null;

  function phaseColor(phase, result) {
    if (phase === Phase.Done) return result?.approved ? 'green' : 'yellow';
    if (phase === Phase.Error) return 'red';
    if (phase === Phase.Running) return 'green';
    if (phase === Phase.Launching) return 'yellow';
    return 'cyan';
  }

  function shouldRenderEngineAction(nextState, action, viewState) {
    if (!action) return true;
    if (action.type === 'result' || action.type === 'error') return true;
    if (action.type === 'turnSnapshot') return false;
    if (action.type === 'traceEntry') return viewState.screen === 'trace';
    if (viewState.awaitingSetup || viewState.awaitingConfirm || viewState.editingTask || viewState.cancelled) return false;
    if (viewState.screen === 'trace') return false;
    if (viewState.screen === 'task' || viewState.screen === 'taskConfirm' || viewState.screen === 'error' || viewState.screen === 'finishing') return false;

    const latestRound = nextState?.order?.[nextState.order.length - 1] ?? null;
    const visibleRound = viewState.follow ? latestRound : (viewState.selected ?? latestRound);
    const actionRound = Number.isFinite(action.round) ? action.round : null;

    if (viewState.screen === 'tool') {
      const selected = viewState.selectedTool;
      if (!selected) return false;
      if (actionRound !== selected.round || action.role !== selected.role) return false;
      if (action.type === 'toolStart' || action.type === 'toolUpdate' || action.type === 'toolEnd') {
        return !action.toolCallId || action.toolCallId === selected.toolCallId;
      }
      return action.type === 'usageUpdate' || action.type === 'turnCompleted' || action.type === 'turnFailed' || action.type === 'turnEnd';
    }

    if (viewState.screen !== 'flow') return false;
    if (actionRound != null && visibleRound != null && actionRound !== visibleRound) return false;
    return true;
  }

  function writeAt(row, col, text) {
    if (!process.stdout.isTTY || !altScreenActive) return;
    const safeRow = Math.max(1, Math.floor(row));
    const safeCol = Math.max(1, Math.floor(col));
    process.stdout.write(`\x1b[${safeRow};${safeCol}H${text}`);
  }

  function findAnimationSlotStart(fullText, animationText) {
    if (!animationText) return -1;
    const index = fullText.indexOf(animationText.trimStart());
    if (index < 0) return -1;
    return index + Math.max(0, animationText.length - animationText.trimStart().length);
  }

  function patchChromeAnimations({ state, view, size }) {
    if (!shouldPatchTuiChrome({ state, view })) return;
    const frame = patchChromeAnimations.frame = ((patchChromeAnimations.frame ?? 0) + 1) | 0;
    const totalRows = Math.max(0, size.rows);
    const headerHeight = Math.min(6, totalRows);
    let remaining = totalRows - headerHeight;
    const navHeight = Math.min(3, remaining);
    remaining -= navHeight;
    const footerHeight = Math.min(state.phase === Phase.Error ? 4 : 0, remaining);
    remaining -= footerHeight;
    const paneOuter = remaining;
    const paneOuterCols = Math.max(4, Math.floor((Math.max(1, size.cols) - 1) / 2));
    const selectedRound = view.selected ?? state.order[state.order.length - 1] ?? null;
    const round = selectedRound != null ? state.rounds.get(selectedRound) : null;

    patchHeaderBrandRow({ state, selectedRound, width: Math.max(1, size.cols - 4), frame });


    if (paneOuter <= 0) return;
    patchPaneAnimationSlot({ role: 'AUTHOR', pane: round?.AUTHOR, col: 1, row: headerHeight + 1, width: paneOuterCols, frame, state });
    patchPaneAnimationSlot({ role: 'REVIEWER', pane: round?.REVIEWER, col: paneOuterCols + 2, row: headerHeight + 1, width: paneOuterCols, frame, state });
  }


  function patchHeaderBrandRow({ state, selectedRound, width, frame }) {
    if (state.phase !== Phase.Launching) return;
    const brandTitle = formatTuiDashboardTitle({
      phase: state.phase,
      result: state.result,
      selectedRound,
      totalRounds: state.order.length,
      maxRounds: state.result?.maxRounds ?? config.maxRounds,
    });
    const brandRow = formatSparBrandFrame({
      frame,
      width,
      title: brandTitle,
      useEmoji: !process.env.ACP_SPLASH_NO_EMOJI,
      animated: true,
    });
    writeAt(2, 3, padCellWithoutEllipsis(brandRow.text, width));
  }

  function patchPaneAnimationSlot({ role, pane, col, row, width, frame, state }) {
    const status = paneHasActivityForChrome(pane) ? pane.status : roleStatusToPaneStatusForChrome(state.statuses?.[role]);
    const animation = formatTuiAnimationLabel(status, frame);
    if (!animation) return;
    const settings = role === 'AUTHOR' ? config.authorSettings : config.reviewerSettings;
    const label = `${formatTuiPaneHeadlineFitted({
      role,
      round: state.order[state.order.length - 1] ?? null,
      status,
      agent: agentName(settings),
      model: settings.model || 'default',
      width: Math.max(1, width - 4 - TUI_ANIMATION_SLOT_WIDTH),
    })}${padCell(animation, TUI_ANIMATION_SLOT_WIDTH)}`;
    const safeWidth = Math.max(4, width);
    const labelWidth = Math.max(0, safeWidth - 4);
    const fitted = fitText(label, labelWidth, { ellipsis: true });
    const labelText = ` ${fitted.text} `;
    const slot = padCell(animation, TUI_ANIMATION_SLOT_WIDTH);
    const slotStart = findAnimationSlotStart(labelText, slot);
    if (slotStart < 0) return;
    const totalFill = Math.max(0, safeWidth - displayWidth(labelText) - 2);
    const leftFill = Math.floor(totalFill / 2);
    writeAt(row, col + 1 + leftFill + slotStart, slot);
  }

  function paneHasActivityForChrome(pane) {
    return Boolean(pane?.startedAt || pane?.finishedAt || pane?.flow?.length || pane?.lines?.length || pane?.current || pane?.tools?.length);
  }
  function roleStatusToPaneStatusForChrome(status) {
    if (status === 'ready') return PaneStatus.Completed;
    if (
      String(status).startsWith('launching')
      || String(status).startsWith('session ready')
      || String(status).startsWith('spawning')
      || String(status).startsWith('handshaking')
      || String(status).startsWith('new session')
    ) {
      return 'launching';
    }
    return PaneStatus.Pending;
  }
  function DashboardHeader({ phase, result, selectedRound, totalRounds, maxRounds, cwd, task, headerCols, height, frame }) {
    const safeHeaderCols = Math.max(1, headerCols);
    const taskPreview = fixedTaskPreviewRows(task, safeHeaderCols);
    const brandTitle = formatTuiDashboardTitle({
      phase,
      result,
      selectedRound,
      totalRounds,
      maxRounds,
    });
    const brandRow = formatSparBrandFrame({
      frame,
      width: Math.max(20, safeHeaderCols),
      title: brandTitle,
      useEmoji: !process.env.ACP_SPLASH_NO_EMOJI,
      animated: phase === Phase.Launching,
    });
    const color = phaseColor(phase, result);

    return h(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: color,
        paddingX: 1,
        height,
        overflow: 'hidden',
      },
      line(
        h(
          Text,
          {
            bold: true,
            color: brandRow.impact ? 'yellow' : color,
            wrap: 'truncate-clip',
          },
          brandRow.text,
        ),
        'title',
      ),
      line(h(Text, { color: 'yellow', wrap: 'truncate-end' }, `workspace: ${cwd}`), 'cwd'),
      ...taskPreview.rows.map((row, i) => line(h(Text, { color: i === 0 ? 'white' : 'cyan', wrap: 'truncate-end' }, row || ' '), `task-${i}`)),
    );
  }
  function App() {
    const app = useApp();
    const { stdout } = useStdout();

    // Mirror engine state into React state so we re-render on each event.
    const [, setTick] = useState(0);
      const [view, dispatchView] = useReducer(viewReducer, initialView);
      const [size, setSize] = useState({
        rows: stdout?.rows || 24,
        cols: stdout?.columns || 80,
      });
    useEffect(() => {
      const onResize = () => setSize({ rows: stdout.rows, cols: stdout.columns });
      stdout?.on?.('resize', onResize);
      return () => stdout?.off?.('resize', onResize);
    }, [stdout]);

    useEffect(() => {
      if (view.awaitingSetup) return undefined;
      let timeout = null;
      let pending = false;
      const flush = () => {
        timeout = null;
        if (!pending) return;
        pending = false;
        setTick((t) => (t + 1) | 0);
      };
      const schedule = (nextState, action) => {
        if (!shouldRenderEngineAction(nextState, action, view)) return;
        pending = true;
        if (action?.type === 'result' || action?.type === 'error') {
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          flush();
          return;
        }
        if (!timeout) timeout = setTimeout(flush, ENGINE_RENDER_FRAME_MS);
      };
      const off = ensureEngine().subscribe((nextState, action) => schedule(nextState, action));
      return () => {
        off();
        if (timeout) clearTimeout(timeout);
      };
    }, [
      view.awaitingSetup,
      view.awaitingConfirm,
      view.editingTask,
      view.cancelled,
      view.screen,
      view.follow,
      view.selected,
      view.selectedTool?.round,
      view.selectedTool?.role,
      view.selectedTool?.toolCallId,
    ]);

    useEffect(() => {
      if (view.screen !== 'finishing') return undefined;
      if (view.finishFrame >= FINISH_ANIMATION_FRAMES) {
        leaveAltScreen();
        app.exit();
        return undefined;
      }
      const timeout = setTimeout(() => dispatchView({ type: 'finishTick' }), FINISH_ANIMATION_FRAME_MS);
      return () => clearTimeout(timeout);
    }, [view.screen, view.finishFrame]);
    // Auto-follow: whenever a new round arrives keep the view pinned.
    const state = engine?.getState() ?? createEmptyEngineState();
    useEffect(() => {
      let frame = 0;
      const write = () => {
        const latestState = engine?.getState() ?? state;
        setTerminalTitle(formatTuiTerminalTitle({
          state: latestState,
          frame,
          awaitingSetup: view.awaitingSetup,
          awaitingConfirm: view.awaitingConfirm,
          editingTask: view.editingTask,
          screen: view.screen,
          cancelled: view.cancelled,
        }));
        patchChromeAnimations({ state: latestState, view, size });
        frame = (frame + 1) | 0;
      };
      write();
      if (view.screen === 'finishing' || view.cancelled || state.phase === Phase.Done || state.phase === Phase.Error) return undefined;
      const interval = setInterval(write, Math.min(TUI_TITLE_FRAME_MS, TUI_CHROME_FRAME_MS));
      return () => clearInterval(interval);
    }, [state.phase, state.latest, state.result?.approved, view.awaitingSetup, view.awaitingConfirm, view.editingTask, view.screen, view.cancelled, view.selected, view.focus, size.rows, size.cols]);
    useEffect(() => {
      dispatchView({ type: 'autoFollow', order: state.order });
    }, [state.order.length]);

    useEffect(() => {
      if (approvalBellRung || state.phase !== Phase.Done || !state.result?.approved) return;
      approvalBellRung = true;
      if (process.stdout.isTTY) process.stdout.write('\x07');
    }, [state.phase, state.result?.approved]);

    // Kick off the run exactly once, but only after the user confirms (or
    // immediately if --yes / ACP_REVIEW_YES skipped the prompt).
    useEffect(() => {
      if (runStarted || view.awaitingSetup || view.awaitingConfirm || view.cancelled || view.screen === 'taskConfirm') return;
      runStarted = true;
      ensureEngine().run()
        .then((r) => { runResult = r; })
        .catch((err) => { runFailure = err; })
        .finally(() => {
          runDone = true;
          setTick((t) => (t + 1) | 0);

        });
    }, [view.awaitingSetup, view.awaitingConfirm, view.cancelled, view.screen]);

    // If user cancels in the confirm overlay, treat the run as done so `q` exits.
    useEffect(() => {
      if (view.cancelled) {
        runDone = true;
        setTick((t) => (t + 1) | 0);
      }
    }, [view.cancelled]);

    useInput((input, key) => {
      const approvalPending = isTuiApprovalActionPending({ state, hasPendingApproval: hasPendingApproval() });
      const taskIsLong = taskPreviewRows(config.task, Math.max(1, size.cols - 4)).truncated;
      const openTaskEditor = () => {
        const fromConfirm = view.awaitingConfirm;
        const fromSetup = view.awaitingSetup;
        const currentTask = config.task;
        dispatchView({ type: 'taskEditStarted' });
        setTick((t) => (t + 1) | 0);
        setTimeout(() => {
          try {
            dispatchView({
              type: 'taskEdited',
              task: editTaskText(currentTask),
              fromConfirm,
              fromSetup,
            });
            setTick((t) => (t + 1) | 0);
          } catch (error) {
            dispatchView({ type: 'taskEditFailed', error: error instanceof Error ? error.message : String(error) });
          }
        }, 25);
      };

      if (view.editingTask) return;

      if (input === '?') {
        dispatchView({ type: 'toggleHelp' });
        return;
      }

      if (view.screen === 'task') {
        if (key.escape || input === 'q') dispatchView({ type: 'closeTask' });
        else if (input === 'e' || input === 'E') openTaskEditor();
        else if (input === 'g' || input === 'G') dispatchView({ type: 'scrollEnd' });
        else if (key.upArrow || input === 'k') dispatchView({ type: 'scroll', delta: 1 });
        else if (key.downArrow || input === 'j') dispatchView({ type: 'scroll', delta: -1 });
        else if (key.pageUp) dispatchView({ type: 'scroll', delta: 10 });
        else if (key.pageDown) dispatchView({ type: 'scroll', delta: -10 });
        return;
      }

      if (view.awaitingSetup) {
        if (view.setup.mode === 'summary') {
          if (key.return) {
            dispatchView({ type: 'setupChoose' });
          } else if (key.upArrow || input === 'k') {
            dispatchView({ type: 'setupMove', delta: -1 });
          } else if (key.downArrow || input === 'j') {
            dispatchView({ type: 'setupMove', delta: 1 });
          } else if (key.tab || input === '\t') {
            dispatchView({ type: 'setupToggleRole' });
          } else if (input === ' ') {
            dispatchView({ type: 'setupAssignAgent' });
          } else if (input === 'm' || input === 'M') {
            dispatchView({ type: 'setupModelMode' });
          } else if (input === 's' || input === 'S') {
            dispatchView({ type: 'setupToggleSave' });
          } else if (input === 'e' || input === 'E') {
            openTaskEditor();
          } else if ((input === 'v' || input === 'V') && taskIsLong) {
            dispatchView({ type: 'openTask' });
          } else if (input === 'q' || key.escape) {
            dispatchView({ type: 'cancel' });
          }
        } else if (view.setup.mode === 'customModel') {
          if (key.return) {
            dispatchView({ type: 'setupCustomModelApply' });
          } else if (key.escape) {
            dispatchView({ type: 'setupBack' });
          } else if (key.backspace || key.delete) {
            dispatchView({ type: 'setupCustomModelBackspace' });
          } else if (input === 'q' && !view.setup.customModelInput) {
            dispatchView({ type: 'cancel' });
          } else {
            dispatchView({ type: 'setupCustomModelAppend', input });
          }
        } else if (key.upArrow || input === 'k') {
          dispatchView({ type: 'setupMove', delta: -1 });
        } else if (key.downArrow || input === 'j') {
          dispatchView({ type: 'setupMove', delta: 1 });
        } else if (key.return || input === ' ') {
          dispatchView({ type: 'setupChoose' });
        } else if (input === 'c' || input === 'C') {
          dispatchView({ type: 'setupCustomModelMode' });
        } else if (key.escape || input === 'b' || input === 'B') {
          dispatchView({ type: 'setupBack' });
        } else if (input === 'q') {
          dispatchView({ type: 'cancel' });
        }
        return;
      }

      // Confirm overlay traps all input until resolved.
      if (view.awaitingConfirm) {
        if (input === 'y' || input === 'Y' || key.return) {
          dispatchView({ type: 'confirm' });
        } else if (input === 'e' || input === 'E') {
          openTaskEditor();
        } else if (input === 'n' || input === 'N' || key.escape || (input === 'q')) {
          dispatchView({ type: 'cancel' });
        }
        return;
      }

      if (view.screen === 'taskConfirm') {
        if (key.upArrow || input === 'k') {
          dispatchView({ type: 'scrollConfirm', delta: -1 });
        } else if (key.downArrow || input === 'j') {
          dispatchView({ type: 'scrollConfirm', delta: 1 });
        } else if (key.pageUp) {
          dispatchView({ type: 'scrollConfirm', delta: -10 });
        } else if (key.pageDown) {
          dispatchView({ type: 'scrollConfirm', delta: 10 });
        } else if (input === 'g' || input === 'G') {
          dispatchView({ type: 'scrollConfirmTop' });
        } else if (key.return || input === 'y' || input === 'Y') {
          const nextTask = view.pendingTask ?? config.task;
          const changed = nextTask !== config.task;
          config.task = nextTask;
          config.taskSource = { kind: 'edited' };
          if (approvalPending) {
            resolveApproval(changed
              ? {
                continue: true,
                feedback: `The task was edited after approval. Continue with the updated task:\n${config.task}`,
              }
              : { continue: false });
          }
          dispatchView({ type: 'confirmTask' });
          setTick((t) => (t + 1) | 0);
        } else if (key.escape || input === 'n' || input === 'N' || input === 'q') {
          dispatchView({ type: 'discardTask' });
        } else if (input === 'e' || input === 'E') {
          openTaskEditor();
        }
        return;
      }

      if (approvalPending && (input === 'f' || input === 'F')) {
        forceContinueAfterApproval();
      } else if (approvalPending && (key.return || input === 'q')) {
        resolveApproval({ continue: false });
        dispatchView({ type: 'startFinish' });
      } else if (state.phase === Phase.Error && (input === 'x' || input === 'X')) dispatchView({ type: 'showError' });
      else if (key.leftArrow) dispatchView({ type: 'select', delta: -1, order: state.order });
      else if (key.rightArrow)  dispatchView({ type: 'select', delta: 1, order: state.order });
      else if (view.screen === 'tool' && (key.escape || input === 'q')) dispatchView({ type: 'closeTool' });
      else if (view.screen === 'task' && (key.escape || input === 'q')) dispatchView({ type: 'closeTask' });
      else if (input === 'g')   dispatchView({ type: 'jumpLatest', order: state.order });
      else if (input === 'G')   dispatchView({ type: 'scrollEnd' });
      else if (key.upArrow)     dispatchView({ type: 'scroll', delta: 1 });
      else if (key.downArrow)   dispatchView({ type: 'scroll', delta: -1 });
      else if (key.pageUp)      dispatchView({ type: 'scroll', delta: 10 });
      else if (key.pageDown)    dispatchView({ type: 'scroll', delta: -10 });
      else if (input === 'k')   dispatchView({ type: 'scroll', delta: 1 });
      else if (input === 'j')   dispatchView({ type: 'scroll', delta: -1 });
      else if (key.tab || input === '\t') dispatchView({ type: 'toggleFocus' });
      else if (input === 't')   dispatchView({ type: 'toggleTrace' });
      else if (input === '[')   dispatchView({ type: 'selectTool', tool: moveToolSelection(-1) });
      else if (input === ']' || input === '/')   dispatchView({ type: 'selectTool', tool: moveToolSelection(1) });
      else if (key.return || input === 'd') dispatchView({ type: 'openTool', tool: currentToolSelection() });
      else if (input === 'e' || input === 'E') openTaskEditor();
      else if ((input === 'v' || input === 'V') && taskPreview.truncated) dispatchView({ type: 'openTask' });
      else if (input === 'w')   dispatchView({ type: 'toggleWrap' });
      else if (input === 'q' && runDone) {
        dispatchView({ type: 'startFinish' });
      }
    });

    // ---- layout budget -------------------------------------------------
    // The TUI must occupy EXACTLY size.rows (including the pathological
    // case of size.rows in {0, 1, 2, 3, ...}). Layout vertically:
    //
    //   header (headerHeight) + panes (paneOuter) + nav (navHeight) + footer (footerHeight) === size.rows
    //
    // No spacer rows are rendered, so none are subtracted. We allocate
    // strictly top-down, giving each component what's *left*, with no
    // minimum floors -- that way on a 1-row terminal we render only the
    // header (truncated to 1 row), and on 0 rows we render nothing. The
    // invariant header + pane + nav + footer === size.rows always holds.
    const totalRows = Math.max(0, size.rows);
    const idealHeader = 6;        // brand row + workspace + task preview
    const idealNav = 3;           // 1 line + 2 border
    const idealFooter = state.phase === Phase.Error ? 4 : 0;

    // Header is the highest-priority chunk; give it up to its ideal but
    // never more than the total. Nav comes next, then footer, then panes
    // get every remaining row.
    const headerHeight = Math.min(idealHeader, totalRows);
    let remaining = totalRows - headerHeight;
    const navHeight = Math.min(idealNav, remaining);
    remaining -= navHeight;
    const footerHeight = Math.min(idealFooter, remaining);
    remaining -= footerHeight;
    const paneOuter = remaining; // exactly fills the rest, may be 0

    // Pane internals: top border + bottom border. Role/round/status and token
    // usage live in the custom top border instead of consuming body rows.
    const paneInner = Math.max(0, paneOuter - Math.min(2, paneOuter));

    // Content width: each pane gets half of (cols - 1 spacer column),
    // minus border+padding (4) per pane.
    const paneOuterCols = Math.max(4, Math.floor((Math.max(1, size.cols) - 1) / 2));
    const paneCols = Math.max(1, paneOuterCols - 4);
    const headerCols = Math.max(1, size.cols - 4);

    // ---- panes ---------------------------------------------------------
    const selectedRound = view.selected ?? state.order[state.order.length - 1] ?? null;
    const round = selectedRound != null ? state.rounds.get(selectedRound) : null;
    const total = state.order.length;
    const idx = selectedRound == null ? -1 : state.order.indexOf(selectedRound);

    // ---- header --------------------------------------------------------
    const taskPreview = fixedTaskPreviewRows(config.task, headerCols);
    const header = h(DashboardHeader, {
      phase: state.phase,
      result: state.result,
      selectedRound,
      totalRounds: total,
      maxRounds: state.result?.maxRounds ?? config.maxRounds,
      cwd: config.cwd,
      task: config.task,
      headerCols,
      height: headerHeight,
      frame: 0,
    });

    function toolsForSelection() {
      const pane = view.focus === 'AUTHOR' ? round?.AUTHOR : round?.REVIEWER;
      return pane?.tools ?? [];
    }

    function currentToolSelection() {
      const tools = toolsForSelection();
      if (tools.length === 0 || selectedRound == null) return null;
      const selected = view.selectedTool?.round === selectedRound && view.selectedTool?.role === view.focus
        ? tools.find((tool) => tool.id === view.selectedTool.toolCallId)
        : null;
      const tool = selected ?? tools[tools.length - 1];
      return { round: selectedRound, role: view.focus, toolCallId: tool.id };
    }

    function moveToolSelection(delta) {
      const tools = toolsForSelection();
      if (tools.length === 0 || selectedRound == null) return null;
      const current = view.selectedTool?.round === selectedRound && view.selectedTool?.role === view.focus
        ? tools.findIndex((tool) => tool.id === view.selectedTool.toolCallId)
        : -1;
      const base = current >= 0 ? current : (delta < 0 ? tools.length : -1);
      const next = Math.max(0, Math.min(tools.length - 1, base + delta));
      return { round: selectedRound, role: view.focus, toolCallId: tools[next].id };
    }

    function roleStatusToPaneStatus(status) {
      if (status === 'ready') return PaneStatus.Completed;
      if (
        String(status).startsWith('launching')
        || String(status).startsWith('session ready')
        || String(status).startsWith('spawning')
        || String(status).startsWith('handshaking')
        || String(status).startsWith('new session')
      ) {
        return 'launching';
      }
      return PaneStatus.Pending;
    }

    function paneHasActivity(pane) {
      return Boolean(pane?.startedAt || pane?.finishedAt || pane?.flow?.length || pane?.lines?.length || pane?.current || pane?.tools?.length);
    }

    function visibleFlowRows(pane, width, selectedToolId) {
      if (!pane) return [];
      const rows = [];
      let reasoningBlockCount = 0;
      const flow = pane.flow?.length
        ? pane.flow
        : [{ id: 'snapshot-text', kind: 'text', text: [...pane.lines, pane.current].join('\n') }];
      for (let index = 0; index < flow.length; index += 1) {
        const item = flow[index];
        if (item.kind === 'tool') {
          const run = [item];
          const skipped = [];
          while (flow[index + 1]?.kind === 'tool' || isBlankTextFlow(flow[index + 1])) {
            index += 1;
            if (flow[index]?.kind === 'tool') run.push(flow[index]);
            else skipped.push(flow[index]);
          }
          if (run.length === 1) {
            for (const blank of skipped) rows.push({ key: blank.id, kind: 'text', text: blank.text || '' });
          }
          // If the user has selected a tool that lives inside this run,
          // un-fold the whole run inline so the selection is visible.
          // Otherwise we still fold runs of >1 to keep things compact.
          const selectionIsInRun = selectedToolId
            && run.some((tool) => tool.toolCallId === selectedToolId);
          if (run.length > 1 && !selectionIsInRun) {
            const status = mergedToolStatus(run);
            const runKey = run.map((tool) => tool.toolCallId || tool.id).join('-');
            const summary = fitText(`┌ ${summarizeToolRun(run)}`, width, { ellipsis: true }).text;
            rows.push({ key: `tool-run-${runKey}-summary`, kind: 'tool', status, text: summary });
            run.slice(0, 1).forEach((tool) => {
              const text = `├ ${summarizeTool(tool, { compact: true })}`;
              const preview = fitText(text, width, { ellipsis: true }).text;
              rows.push({ key: `tool-${tool.toolCallId || tool.id}-preview`, kind: 'tool', status: tool.status || status, text: preview, toolCallId: tool.toolCallId });
            });
            const folded = fitText(`└ ${run.length - 1} more · press ] to step into`, width, { ellipsis: true }).text;
            rows.push({ key: `tool-run-${runKey}-more`, kind: 'tool', status, text: folded });
          } else {
            for (const tool of run) {
              const status = tool.status || 'running';
              const text = summarizeTool(tool);
              const parts = view.wrap ? wrapLine(text, width) : [text];
              parts.forEach((part, partIndex) => rows.push({ key: `tool-${tool.toolCallId || tool.id}-${partIndex}`, kind: 'tool', status, text: part, toolCallId: tool.toolCallId }));
            }
          }
          continue;
        }
        // Render a reasoning block as a clearly framed section so users
        // can spot it among normal message text. We insert:
        //   ── thinking #N ──────────────
        //   ▎ <reasoning line 1>
        //   ▎ <reasoning line 2>
        // The frame appears once per reasoning item (each item is its own
        // `sourceId` block, see appendTextFlow). Inline-mixed reasoning
        // and message text remain in chronological order.
        if (item.kind === 'reasoning') {
          const previous = flow[index - 1];
          const isFirstOfBlock = !previous || previous.kind !== 'reasoning' || previous.sourceId !== item.sourceId;
          if (isFirstOfBlock) {
            reasoningBlockCount += 1;
            const label = formatTuiReasoningLabel(reasoningBlockCount);
            const fill = Math.min(12, Math.max(2, width - displayWidth(label) - 2));
            rows.push({
              key: `reasoning-header-${item.id}`,
              kind: 'reasoning-header',
              text: `─${label}${'─'.repeat(fill)}─`,
            });
          }
          const normalized = normalizeDisplayText(item.text || '');
          const logical = normalized.split('\n');
          logical.forEach((part, i) => {
            const isCursorLine = pane.status === PaneStatus.Running
              && i === logical.length - 1
              && item === flow[flow.length - 1];
            const value = isCursorLine ? `${part}\u258F` : part;
            const prefix = '\u258E ';
            const contentWidth = Math.max(1, width - displayWidth(prefix));
            const parts = view.wrap ? (value === '' ? [''] : wrapLine(value, contentWidth)) : [value];
            parts.forEach((text, partIndex) => rows.push({
              key: `${item.id || `flow-${index}`}-${i}-${partIndex}`,
              kind: 'reasoning',
              text: `${prefix}${text}`,
            }));
          });
          continue;
        }
        const normalized = normalizeDisplayText(item.text || '');
        const logical = normalized.split('\n');
        logical.forEach((part, i) => {
          const isCursorLine = pane.status === PaneStatus.Running
            && i === logical.length - 1
            && item === flow[flow.length - 1];
          const value = isCursorLine ? `${part}\u258F` : part;
          const contentWidth = Math.max(1, width);
          const parts = view.wrap ? (value === '' ? [''] : wrapLine(value, contentWidth)) : [value];
          parts.forEach((text, partIndex) => rows.push({
            key: `${item.id || `flow-${index}`}-${i}-${partIndex}`,
            kind: 'text',
            text,
          }));
        });
      }
      return rows;
    }

    function isBlankTextFlow(item) {
      if (!item) return false;
      return item.kind !== 'tool' && String(item.text ?? '').trim() === '';
    }

    function formatTraceRows(item) {
      const { role, entry } = item;
      if (entry.kind !== 'wire') return [];
      const prefix = `${new Date(entry.at).toLocaleTimeString()} ${role} ${entry.direction}`;
      const method = entry.method ? ` ${entry.method}` : '';
      const id = entry.id !== undefined ? ` #${entry.id}` : '';
      const header = `${prefix}${method}${id}`;
      const body = stringifyValue(entry.frame);
      if (!body) return [header];
      try {
        const pretty = JSON.stringify(JSON.parse(body), null, 2);
        return [header, ...pretty.split('\n').map((line) => `  ${line}`)];
      } catch {
        return [header, `  ${body}`];
      }
    }

    function Pane({ role, color, pane, active }) {
      const status = paneHasActivity(pane) ? pane.status : roleStatusToPaneStatus(state.statuses?.[role]);
      // Fixed footer rows keep pane height stable: one status row plus the
      // bottom border row that carries token usage.
      const footerRows = paneInner >= 2 ? 2 : paneInner;
      // Never let textBudget exceed what the pane actually has room for; if
      // the terminal is so small there's no room left after reserved footer rows, drop
      // text entirely (overflow:hidden on the pane keeps us inside bounds).
      const textBudget = Math.max(0, paneInner - footerRows);
      const scroll = role === 'AUTHOR' ? view.scrollAuthor : view.scrollReviewer;
      const selectedToolIdHere = view.selectedTool?.round === selectedRound
        && view.selectedTool?.role === role
        ? view.selectedTool.toolCallId
        : null;
      const expandedFlowRows = useMemo(
        () => visibleFlowRows(pane, paneCols, selectedToolIdHere),
        [pane?.flow, pane?.lines, pane?.current, pane?.status, paneCols, selectedToolIdHere, view.wrap],
      );

      let visible;
      let visibleStart = 0;
      if (textBudget === 0) {
        visible = [];
      } else if (!pane || ((pane.flow?.length ?? 0) === 0 && pane.lines.length === 0 && !pane.current)) {
        visible = [{
          kind: 'text',
          text: formatTuiEmptyState({
            role,
            pane,
            status,
            phase: state.phase,
            selectedRound,
            plan: state.plans?.[role],
            roleStatus: state.statuses?.[role],
          }),
        }];
        while (visible.length < textBudget) visible.push({ kind: 'text', text: '' });
      } else {
        // Scroll: 0 means pin to bottom (last `textBudget` lines visible).
        const end = Math.max(textBudget, expandedFlowRows.length - scroll);
        const start = Math.max(0, end - textBudget);
        visibleStart = start;
        visible = expandedFlowRows.slice(start, end);
      }
      while (visible.length < textBudget) visible.push({ kind: 'text', text: '' });

      const settings = role === 'AUTHOR' ? config.authorSettings : config.reviewerSettings;
      const agent = agentName(settings);
      const model = settings.model || 'default';
      const progress = animationLabel(status, 0);
      const headerLabel = `${formatTuiPaneHeadlineFitted({
        role,
        round: selectedRound,
        status,
        agent,
        model,
        width: Math.max(1, paneOuterCols - 4 - TUI_ANIMATION_SLOT_WIDTH),
      })}${progress}`;
      const usageLabel = formatUsage(pane?.usage);
      const timingLabel = formatDuration(paneElapsedMs(pane));
      const focused = active && view.focus === role;
      const borderColor = color;
      // When the pane is focused we draw the side rails with double-line
      // box characters (║) so the active pane stands out clearly from
      // the inactive one. The unfocused pane keeps the thin │ rail.
      const sideL = focused ? '║ ' : '│ ';
      const sideR = focused ? ' ║' : ' │';
      const innerWidth = paneOuterCols - 4;
      return h(
        Box,
        {
          flexDirection: 'column',
          width: paneOuterCols,
          height: paneOuter,
          overflow: 'hidden',
        },
        paneBorderTop(headerLabel, borderColor, focused, paneOuterCols),
        ...visible.map((row, i) => {
          const text = row.text === '' ? ' ' : row.text;
          if (row.kind === 'tool') {
            const selected = view.selectedTool?.round === selectedRound
              && view.selectedTool?.role === role
              && view.selectedTool?.toolCallId === row.toolCallId;
            // Selection marker: a bright ► arrow in the leftmost cell of
            // the line plus a bold, brighter row. This is far more
            // visible than `inverse:` over a single tool summary line.
            const marker = selected ? '\u25b6 ' : '  ';
            const cell = view.wrap ? padWrappedCell(`${marker}${text}`, innerWidth) : padCell(`${marker}${text}`, innerWidth);
            return line(
              h(
                Text,
                { wrap: view.wrap ? 'truncate-clip' : 'truncate-end' },
                h(Text, { color: borderColor, bold: focused }, sideL),
                h(
                  Text,
                  {
                    color: selected ? 'yellow' : toolStatusColor(row.status),
                    bold: selected,
                  },
                  cell,
                ),
                h(Text, { color: borderColor, bold: focused }, sideR),
              ),
              row.key ?? `l-${role}-${selectedRound ?? 'none'}-${visibleStart + i}`,
            );
          }
          const cell = view.wrap ? padWrappedCell(text, innerWidth) : padCell(text, innerWidth);
          return line(
            h(
              Text,
              { wrap: view.wrap ? 'truncate-clip' : 'truncate-end' },
              h(Text, { color: borderColor, bold: focused }, sideL),
              h(
                Text,
                {
                  color: row.kind === 'reasoning-header'
                    ? 'cyan'
                    : (row.kind === 'reasoning' ? 'gray' : 'white'),
                  italic: row.kind === 'reasoning',
                  bold: row.kind === 'reasoning-header',
                },
                cell,
              ),
              h(Text, { color: borderColor, bold: focused }, sideR),
            ),
            row.key ?? `l-${role}-${selectedRound ?? 'none'}-${visibleStart + i}`,
          );
        }),
        footerRows >= 2 ? paneStatusLine(pane, paneOuterCols, role, borderColor, state.plans?.[role]) : null,
        footerRows >= 1 ? paneBorderBottom(paneOuterCols, usageLabel, timingLabel, focused, borderColor) : null,
      );
    }

    function paneBorderTop(label, color, focused, width) {
      const safeWidth = Math.max(4, width);
      // Focused pane uses double-line corners (╔══ ══╗) so users can
      // tell active vs inactive at a glance. The inner glyph differs
      // too, so the whole frame visibly thickens around the active pane.
      const corners = focused ? { l: '\u2554', r: '\u2557', dash: '\u2550' } : { l: '\u256d', r: '\u256e', dash: '\u2500' };
      // Title is centered between the corners.
      const labelWidth = Math.max(0, safeWidth - 4);
      const fitted = fitText(label, labelWidth, { ellipsis: true });
      const labelText = ` ${fitted.text} `;
      const totalFill = Math.max(0, safeWidth - displayWidth(labelText) - 2);
      const leftFill = Math.floor(totalFill / 2);
      const rightFill = totalFill - leftFill;
      return line(
        h(
          Text,
          { wrap: 'truncate-end' },
          h(Text, { color, bold: focused }, corners.l),
          h(Text, { color, bold: focused }, corners.dash.repeat(leftFill)),
          h(Text, { color, bold: focused }, labelText),
          h(Text, { color, bold: focused }, corners.dash.repeat(rightFill)),
          h(Text, { color, bold: focused }, corners.r),
        ),
        `border-top-${color}-${focused ? 'focused' : 'idle'}`,
      );
    }

    function paneStatusLine(pane, width, role, borderColor, plan) {
      const statusLine = formatTuiPaneStatusLine({ pane, plan });
      // Side rail glyph mirrors the row above; status line appears
      // immediately above the bottom border, still inside the pane.
      const focused = view.focus === role;
      const sideL = focused ? '\u2551 ' : '\u2502 ';
      const sideR = focused ? ' \u2551' : ' \u2502';
      return line(
        h(
          Text,
          { wrap: 'truncate-end' },
          h(Text, { color: borderColor, bold: focused }, sideL),
          h(Text, { color: statusLine.color, dimColor: statusLine.dim }, padCell(statusLine.text, width - 4)),
          h(Text, { color: borderColor, bold: focused }, sideR),
        ),
        `${role}-status`,
      );
    }

    function paneBorderBottom(width, usageLabel, timingLabel, focused, borderColor) {
      const safeWidth = Math.max(4, width);
      const corners = focused ? { l: '\u255a', r: '\u255d', dash: '\u2550' } : { l: '\u2570', r: '\u256f', dash: '\u2500' };
      const maxTimingWidth = Math.max(0, Math.min(16, Math.floor(safeWidth * 0.24)));
      const fittedTiming = timingLabel ? fitText(timingLabel, maxTimingWidth, { ellipsis: true }) : { text: '', width: 0 };
      const timingText = fittedTiming.text ? ` ${fittedTiming.text} ` : '';
      const maxUsageWidth = Math.max(0, safeWidth - displayWidth(timingText) - 4);
      const fittedUsage = usageLabel ? fitText(usageLabel, maxUsageWidth, { ellipsis: true }) : { text: '', width: 0 };
      const usageText = fittedUsage.text ? ` ${fittedUsage.text} ` : '';
      const labelWidth = displayWidth(usageText) + displayWidth(timingText);
      const fill = Math.max(0, safeWidth - labelWidth - 2);
      return line(
        h(
          Text,
          { wrap: 'truncate-end' },
          h(Text, { color: borderColor, bold: focused }, `${corners.l}${corners.dash.repeat(fill)}`),
          usageText ? h(Text, { color: 'yellow', bold: focused }, usageText) : null,
          timingText ? h(Text, { color: 'cyan', bold: focused }, timingText) : null,
          h(Text, { color: borderColor, bold: focused }, corners.r),
        ),
        `border-bottom-${borderColor}-${focused ? 'focused' : 'idle'}`,
      );
    }

    const split = h(
      Box,
      { flexDirection: 'row', height: paneOuter, overflow: 'hidden' },
      h(Pane, { role: 'AUTHOR', color: 'cyan', pane: round?.AUTHOR, active: true }),
      h(Box, { width: 1 }),
      h(Pane, { role: 'REVIEWER', color: 'magenta', pane: round?.REVIEWER, active: true }),
    );

    function TraceView() {
      const traceRows = state.trace
        .flatMap(formatTraceRows)
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, traceRows.length - view.scrollTrace);
      const start = Math.max(0, end - bodyBudget);
      const visible = traceRows.length === 0
        ? ['No ACP wire messages captured yet.']
        : traceRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'yellow',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(h(Text, { bold: true, color: 'yellow' }, 'ACP Trace · redacted wire messages'), 'trace-header'),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `trace-${i}`)),
      );
    }

    function selectedToolRecord() {
      const selection = view.selectedTool;
      if (!selection) return null;
      const selected = state.rounds.get(selection.round)?.[selection.role];
      const tool = selected?.tools?.find((item) => item.id === selection.toolCallId);
      return tool ? { selection, tool } : null;
    }

    function formatToolDetailsRows() {
      const record = selectedToolRecord();
      if (!record) {
        return ['No tool call selected. Press [ or ] in the flow view to select one.'];
      }
      const { selection, tool } = record;
      const rows = [
        `${selection.role} Round ${selection.round} ${tool.tag || ''} ${toolStatusLabel(tool.status || 'running')}`.trim(),
        `id: ${tool.id}`,
        `name: ${tool.name || '(unknown)'}`,
        `title: ${tool.title || '(untitled)'}`,
        `status: ${tool.status || 'running'}`,
        `size: ${formatTuiToolSize({ lines: lineCount(tool.output), chars: tool.chars ?? 0 }) || '0 chars'}`,
        '',
        'input:',
        ...prettyValue(tool.input).map((line) => `  ${line}`),
        '',
        'output:',
        ...prettyValue(tool.output).map((line) => `  ${line}`),
      ];
      return rows;
    }

    function prettyValue(value) {
      if (value == null) return ['(empty)'];
      if (typeof value === 'string') return value.split('\n');
      try {
        return JSON.stringify(value, null, 2).split('\n');
      } catch {
        return [stringifyValue(value)];
      }
    }

    function ToolView() {
      const detailRows = formatToolDetailsRows()
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, detailRows.length - view.scrollTool);
      const start = Math.max(0, end - bodyBudget);
      const visible = detailRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: '#ffa500',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          shortcutLine(
            h(Text, { bold: true, color: '#ffa500' }, 'Selected Tool Call'),
            muted(' - '),
            shortcutLabel('[/]'),
            muted(' select, '),
            shortcutLabel('Esc/q'),
            muted(' back'),
          ),
          'tool-header',
        ),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `tool-${i}`)),
      );
    }

    function TaskView() {
      const taskRows = String(config.task || '(empty)')
        .split('\n')
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(4, paneOuter));
      const end = Math.max(bodyBudget, taskRows.length - view.scrollTask);
      const start = Math.max(0, end - bodyBudget);
      const visible = taskRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          shortcutLine(
            h(Text, { bold: true, color: 'cyan' }, 'Full Task Brief'),
            muted(' - '),
            shortcutLabel('e'),
            muted(' edit, '),
            shortcutLabel('Esc/q'),
            muted(' back, '),
            shortcutLabel('↑/↓'),
            muted(' scroll'),
          ),
          'task-header',
        ),
        line(shortcutLine(muted('Tip: press '), shortcutLabel('e'), muted(' here to edit the task.')), 'task-edit-tip'),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `task-full-${i}`)),
      );
    }

    function ErrorView() {
      const rows = String(state.error || 'error')
        .split('\n')
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, rows.length - view.scrollError);
      const start = Math.max(0, end - bodyBudget);
      const visible = rows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'double',
          borderColor: 'red',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          shortcutLine(
            h(Text, { bold: true, color: 'red' }, 'Startup Error'),
            muted(' - '),
            shortcutLabel('x'),
            muted(' back, '),
            shortcutLabel('\u2191/\u2193'),
            muted(' scroll'),
          ),
          'error-header',
        ),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `error-${i}`)),
      );
    }

    function FinishView() {
      const frame = Math.min(view.finishFrame, FINISH_ANIMATION_FRAMES);
      const progress = frame / FINISH_ANIMATION_FRAMES;
      const innerWidth = Math.max(12, Math.min(56, size.cols - 12));
      const filled = Math.min(innerWidth, Math.floor(innerWidth * progress));
      const block = String.fromCodePoint(0x2588);
      const line = String.fromCodePoint(0x2500);
      const pulse = ['   ', '.  ', '.. ', '...'][frame % 4];
      const bar = `${block.repeat(filled)}${line.repeat(innerWidth - filled)}`;
      const cardWidth = Math.max(24, Math.min(64, size.cols - 8));
      const topRule = `${String.fromCodePoint(0x256D)}${String.fromCodePoint(0x2500).repeat(cardWidth - 2)}${String.fromCodePoint(0x256E)}`;
      const bottomRule = `${String.fromCodePoint(0x2570)}${String.fromCodePoint(0x2500).repeat(cardWidth - 2)}${String.fromCodePoint(0x256F)}`;
      const topPad = Math.max(0, Math.floor((size.rows - 10) / 2));
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          alignItems: 'center',
          overflow: 'hidden',
        },
        ...Array.from({ length: topPad }, (_, i) => h(Text, { key: `finish-pad-${i}` }, '')),
        h(Text, { color: 'green', bold: true }, topRule),
        h(Text, { color: 'green', bold: true }, 'APPROVED'),
        h(Text, { color: 'cyan' }, 'Spar complete'),
        h(Text, { dimColor: true }, formatTuiFinishSummary({
          rounds: state.result?.rounds ?? state.order.length,
          maxRounds: state.result?.maxRounds ?? config.maxRounds,
        })),
        h(Text, { color: 'yellow' }, bar),
        h(Text, { dimColor: true }, `Closing TUI${pulse}`),
        h(Text, { color: 'green', bold: true }, bottomRule),
      );
    }

    if (view.screen === 'finishing') return h(FinishView);

    function keyBindingLine(keys, description) {
      const padding = ' '.repeat(Math.max(1, 12 - keys.length));
      return shortcutLine(
        muted('  '),
        shortcutLabel(keys),
        muted(`${padding}${description}`),
      );
    }

    if (view.showHelp) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, 'Keybindings'),
          h(Text, null, ''),
          ...formatTuiHelpKeybindings().map(([keys, description]) => keyBindingLine(keys, description)),
          h(Text, null, ''),
          shortcutLine(muted('Press '), shortcutLabel('?'), muted(' again to dismiss.')),
        ),
      );
    }

    const mainView = view.screen === 'trace'
      ? h(TraceView)
      : view.screen === 'tool' ? h(ToolView)
        : view.screen === 'task' ? h(TaskView)
          : view.screen === 'error' ? h(ErrorView)
            : split;

    // ---- nav -----------------------------------------------------------
    const navText = total === 0
      ? 'Waiting for first round...'
      : `Round ${selectedRound} (${idx + 1}/${total})`;
    const primaryFooterKeys = formatTuiPrimaryFooterKeys({
      phase: state.phase,
      taskTruncated: taskPreview.truncated,
    });
    const approvalActionPending = isTuiApprovalActionPending({ state, hasPendingApproval: hasPendingApproval() });
    const resultHint = state.phase === Phase.Done && state.result
      ? state.result.approved
        ? approvalActionPending
          ? shortcutLine(
            h(Text, { color: 'green', bold: true }, 'APPROVED'),
            muted(' - '),
            shortcutLabel('f'),
            muted(' force continue, '),
            shortcutLabel('e'),
            muted(' edit/resume, '),
            shortcutLabel('Enter'),
            muted(' accept, '),
            shortcutLabel('q'),
            muted(' accept+quit'),
          )
          : shortcutLine(
            h(Text, { color: 'green', bold: true }, 'APPROVED'),
            muted(' - '),
            shortcutLabel('q'),
            muted(' quit'),
          )
        : shortcutLine(
          muted(`Not approved after ${state.result.rounds}/${state.result.maxRounds}; `),
          shortcutLabel('q'),
          muted(' quit'),
        )
      : null;
    const nav = h(
      Box,
      {
        borderStyle: 'round',
        paddingX: 1,
        height: navHeight,
        overflow: 'hidden',
      },
      h(
        Text,
        { wrap: 'truncate-end' },
        resultHint || muted(navText),
        muted('   '),
        ...shortcutItems(primaryFooterKeys),
      ),
    );

    // ---- footer (only for errors; final status stays in nav to avoid layout jumps)
    let footer = null;
    if (state.phase === Phase.Error) {
      footer = h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'double',
          paddingX: 1,
          height: footerHeight,
          overflow: 'hidden',
        },
        h(Text, { color: 'red', wrap: 'truncate-end' }, firstLine(state.error || 'error')),
        shortcutLine(muted('Press '), shortcutLabel('x'), muted(' for details, '), shortcutLabel('q'), muted(' to quit.')),
      );
    }

    // ---- setup / start overlay ----------------------------------------
    if (view.editingTask) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'cyan',
            paddingX: 3,
            paddingY: 1,
            overflow: 'hidden',
          },
          h(Text, { color: 'cyan', bold: true }, formatTuiTaskEditorWaitingTitle()),
          h(Text, { dimColor: true }, 'The TUI is paused while your editor is active.'),
          h(Text, { dimColor: true }, 'Save and close the editor to return here.'),
        ),
      );
    }

    if (view.awaitingSetup) {
      const options = view.setup.mode === 'summary' ? agentOptions() : setupStepOptions(view.setup);
      const authorAgent = agentDisplayName(view.setup.selections.authorAgentId);
      const reviewerAgent = agentDisplayName(view.setup.selections.reviewerAgentId);
      const authorCliFound = setupRoleCliFound(view.setup, 'author');
      const reviewerCliFound = setupRoleCliFound(view.setup, 'reviewer');
      const authorModel = setupModelLabel(view.setup.selections.authorAgentId, view.setup.selections.authorModel, authorCliFound);
      const reviewerModel = setupModelLabel(view.setup.selections.reviewerAgentId, view.setup.selections.reviewerModel, reviewerCliFound);
      const innerCols = Math.max(24, size.cols - 8);
      const compact = size.cols < 84;
      const taskPreview = fixedTaskPreviewRows(config.task, Math.max(20, innerCols - 12), { prefix: 'Task        ' });
      const modeTitle = view.setup.mode === 'customModel'
        ? `Custom ${view.setup.activeRole.toUpperCase()} model`
        : view.setup.mode === 'model'
        ? `Choose ${view.setup.activeRole.toUpperCase()} model`
        : 'Prepare Spar run';
      const bodyBudget = Math.max(0, size.rows - (compact ? 21 : 23));
      const authorStatus = setupRoleStatus(view.setup, 'author');
      const reviewerStatus = setupRoleStatus(view.setup, 'reviewer');
      const roleRows = [
        { role: 'AUTHOR', roleKey: 'author', active: view.setup.activeRole === 'author', agent: authorAgent, model: authorModel, availability: authorStatus, userCliFound: authorCliFound },
        { role: 'REVIEWER', roleKey: 'reviewer', active: view.setup.activeRole === 'reviewer', agent: reviewerAgent, model: reviewerModel, availability: reviewerStatus, userCliFound: reviewerCliFound },
      ];
      const sourceWidth = compact ? 8 : 10;
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'cyan',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, modeTitle),
          h(Text, { dimColor: true }, 'Configure the two agents before launching the review loop.'),
          h(Text, null, ''),
          h(Text, { color: 'yellow', wrap: 'truncate-end' }, `Workspace   ${config.cwd}`),
          ...taskPreview.rows.map((row, i) =>
            h(Text, { key: `setup-task-${i}`, color: i === 0 ? 'white' : 'cyan', wrap: 'truncate-end' }, i === 0 ? '' : '            ', row),
          ),
          h(Text, null, ''),
          h(
            Box,
            {
              flexDirection: 'column',
              borderStyle: 'round',
              borderColor: 'cyan',
              paddingX: 1,
              overflow: 'hidden',
            },
            h(Text, { bold: true, color: 'cyan' }, 'Selected roles'),
            h(Text, { dimColor: true }, compact
              ? `${padCell('Role', 10)} ${padCell('Agent', 16)} ${padCell('Model', 14)} ${padCell('Source', sourceWidth)} Startup`
              : `${padCell('Role', 10)} ${padCell('Agent', 20)} ${padCell('Model', 18)} ${padCell('Source', sourceWidth)} ${padCell('CLI', 8)} Startup`),
            ...roleRows.map((row) => h(
              Text,
              { key: `role-${row.role}`, wrap: 'truncate-end' },
              h(Text, { color: row.active ? 'cyan' : undefined, bold: row.active }, `${row.active ? '>' : ' '} ${padCell(row.role, 8)} `),
              padCell(row.agent, compact ? 16 : 20),
              ' ',
              padCell(row.model, compact ? 14 : 18),
              ' ',
              h(Text, { color: setupSourceColor(view.setup, row.roleKey) }, padCell(setupSourceLabel(view.setup, row.roleKey), sourceWidth)),
              compact ? '' : ' ',
              compact ? null : h(Text, { color: userCliColor(row.userCliFound) }, padCell(userCliLabel(row.userCliFound), 8)),
              ' ',
               h(Text, { color: availabilityColor(row.availability) }, formatTuiAvailabilityLabel(row.availability)),
            )),
            h(Text, { dimColor: true, wrap: 'truncate-end' }, formatTuiPreferenceStatus({
              save: view.setup.selections.save,
              path: config.preferencesPath,
            })),
          ),
          h(Text, null, ''),
          h(Text, { color: 'gray', dimColor: true }, '─'.repeat(Math.max(8, Math.min(innerCols, 72)))),
          h(Text, { bold: true, color: 'green' }, view.setup.mode === 'summary' ? 'Available agents' : view.setup.mode === 'customModel' ? 'Type custom model' : 'Available models'),
          ...(view.setup.mode === 'summary'
            ? [
              h(Text, { key: 'agents-header', dimColor: true }, compact
                ? `${padCell('Agent', 18)} ${padCell('Default model', 14)} Startup`
                : `${padCell('Agent', 22)} ${padCell('Default model', 18)} ${padCell('CLI', 8)} Startup`),
              ...options.slice(0, bodyBudget).map((option, i) => h(
                Text,
                {
                  key: `agent-${option.id}`,
                  color: option.disabled ? 'gray' : i === view.setup.cursor ? 'green' : undefined,
                  inverse: i === view.setup.cursor && !option.disabled,
                  dimColor: option.disabled,
                  wrap: 'truncate-end',
                },
                `${i === view.setup.cursor ? '>' : ' '} ${padCell(option.label, compact ? 16 : 20)} ${padCell(defaultModelLabel(option), compact ? 14 : 18)} `,
                compact ? null : h(Text, { color: userCliColor(option.userCliFound) }, padCell(userCliLabel(option.userCliFound), 8)),
                ' ',
                h(Text, { color: availabilityColor(option.availability) }, formatTuiAvailabilityLabel(option.availability)),
              )),
            ]
            : view.setup.mode === 'customModel'
              ? [
                h(Text, { key: 'custom-help', dimColor: true, wrap: 'truncate-end' }, 'Enter a model id, or leave empty to use the agent default.'),
                h(Text, { key: 'custom-input', color: 'green', wrap: 'truncate-end' }, `> ${view.setup.customModelInput ?? ''}_`),
              ]
              : [
              h(Text, { key: 'models-header', dimColor: true }, `${padCell('Model', 28)} Applies to ${view.setup.activeRole.toUpperCase()}`),
              ...options.slice(0, bodyBudget).map((option, i) =>
                h(
                  Text,
                  {
                    key: option.id,
                    color: i === view.setup.cursor ? 'green' : undefined,
                    inverse: i === view.setup.cursor,
                    wrap: 'truncate-end',
                  },
                  `${i === view.setup.cursor ? '>' : ' '} ${option.label}`,
                ),
              ),
            ]),
          h(Text, null, ''),
          view.setup.error
            ? h(Text, { color: 'red', wrap: 'wrap' }, view.setup.error)
            : h(Text, { dimColor: true, wrap: 'truncate-end' }, 'CLI means the everyday agent command is on PATH. Startup shows whether this run starts directly, uses npx fallback, or is unavailable.'),
          view.setup.mode === 'summary'
            ? h(Text, null, ...formatTuiSetupFooterKeys({ mode: 'summary', taskTruncated: taskPreview.truncated }).flatMap((key, index) => [
              index === 0 ? null : '   ',
              shortcutLabel(key, key === 'q' ? 'red' : 'cyan'),
            ]).filter(Boolean))
            : view.setup.mode === 'customModel'
              ? h(Text, null, ...formatTuiSetupFooterKeys({ mode: 'customModel' }).flatMap((key, index) => [
                index === 0 ? null : '   ',
                shortcutLabel(key, key === 'q' ? 'red' : 'cyan'),
              ]).filter(Boolean))
              : h(Text, null, ...formatTuiSetupFooterKeys({ mode: 'model' }).flatMap((key, index) => [
                index === 0 ? null : '   ',
                shortcutLabel(key, key === 'q' ? 'red' : 'cyan'),
              ]).filter(Boolean)),
        ),
      );
    }

    if (view.screen === 'taskConfirm') {
      const confirmCols = Math.max(20, size.cols - 10);
      const taskLines = wrapLine(view.pendingTask || '(empty)', confirmCols);
      const bodyBudget = Math.max(0, size.rows - 8);
      const maxStart = Math.max(0, taskLines.length - bodyBudget);
      const start = Math.min(view.scrollConfirm, maxStart);
      const visibleLines = bodyBudget > 0 ? taskLines.slice(start, start + bodyBudget) : [];
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'yellow',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'yellow' }, 'Review updated task'),
          h(Text, null, ''),
          ...visibleLines.map((row, i) =>
            h(Text, { key: `task-confirm-${start}-${i}`, wrap: 'wrap' }, start + i === 0 ? 'task:     ' : '          ', row),
          ),
          h(Text, null, ''),
          h(
            Text,
            null,
            h(Text, { color: 'green', bold: true }, 'Enter'),
            ' apply   ',
            h(Text, { color: 'cyan', bold: true }, 'e'),
            ' edit again   ',
            h(Text, { color: 'red', bold: true }, 'Esc'),
            ' discard   ',
            shortcutLabel('\u2191/\u2193'),
            ' scroll',
          ),
        ),
      );
    }

    // ---- confirm overlay (first frame, blocks engine.run) -------------
    if (view.awaitingConfirm) {
      const confirmCols = Math.max(20, size.cols - 10);
      const taskLines = wrapLine(config.task || '(empty)', confirmCols);
      const lines = formatTuiConfirmSummaryRows({
        cwd: config.cwd,
        taskSource: config.taskSource,
        taskLines,
        author: agentSummary(config.authorSettings),
        authorModel: config.authorSettings.model,
        reviewer: agentSummary(config.reviewerSettings),
        reviewerModel: config.reviewerSettings.model,
        maxRounds: config.maxRounds,
      });
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'cyan',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, 'Launch Spar?'),
          h(Text, null, ''),
          ...lines.map((row, i) =>
            h(
              Text,
              { key: i, wrap: 'wrap' },
              h(Text, { dimColor: true }, row[0]),
              row[1],
            ),
          ),
          h(Text, null, ''),
          h(
            Text,
            null,
            h(Text, { color: 'green', bold: true }, 'y'),
            ' / ',
            h(Text, { color: 'green', bold: true }, 'Enter'),
            ' to start   ',
            h(Text, { color: 'cyan', bold: true }, 'e'),
            ' edit task   ',
            h(Text, { color: 'red', bold: true }, 'n'),
            ' / ',
            h(Text, { color: 'red', bold: true }, 'Esc'),
            ' to cancel',
          ),
          h(
            Text,
            { dimColor: true },
            'Tip: pass --yes (or set ACP_REVIEW_YES=1) to skip this prompt.',
          ),
        ),
      );
    }

    // ---- cancelled overlay --------------------------------------------
    if (view.cancelled) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'red',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { color: 'red', bold: true }, 'Cancelled.'),
          shortcutLine(muted('Press '), shortcutLabel('q'), muted(' to quit.')),
        ),
      );
    }

    return h(
      Box,
      {
        flexDirection: 'column',
        width: size.cols,
        height: size.rows,
        overflow: 'hidden',
      },
      header,
      mainView,
      nav,
      footer,
    );
  }

  // Disable Ink's own scrollback growth: we render in alt-screen, fixed size.
  const inkApp = render(h(App), {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: true,
    patchConsole: false,
  });

  try {
    await inkApp.waitUntilExit();
  } finally {
    process.off('exit', restore);
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    leaveAltScreen();
  }

  if (runFailure) throw runFailure;
  if (!runResult) return 1;
  return runResult.approved ? 0 : 1;
}
