import fs from 'node:fs/promises';
import { createSessionTurnManager } from '@acp-kit/core';
import { PaneStatus, Phase, initialState, reduce } from './engine/state.mjs';
import { closeRole, openRole } from './runtime/role.mjs';
import { createInitialRunRecoveryState, createRunRecoveryStore } from './runtime/run-recovery.mjs';
import { createSparSessionStore } from './runtime/spar-session.mjs';
import { createStartupProfiler } from './runtime/startup-profile.mjs';
import { createRunTraceRecorder } from './runtime/run-trace.mjs';
import { runTurn } from './runtime/turn.mjs';
import { createWorkspaceChangeTracker, formatWorkspaceChangeSummary } from './runtime/workspace-changes.mjs';
import { createFailureDiagnosticBundle, formatFailureDiagnosticBundle } from './runtime/diagnostic-bundle.mjs';

export { PaneStatus, Phase };

const EMPTY_REVIEWER_FEEDBACK = [
  'Reviewer returned an empty response.',
  '',
  'Do not assume approval. Re-run verification, summarize the current state clearly, and end with exactly one final verdict line: SPAR_VERDICT: APPROVED or SPAR_VERDICT: REJECTED.',
].join('\n');

const AMBIGUOUS_APPROVAL_FEEDBACK = [
  'Reviewer response was treated as NOT APPROVED because it mixed APPROVED with conflicting issue text.',
  '',
  'Keep SPAR_VERDICT: APPROVED consistent with the rest of the review. If any required fixes remain, use SPAR_VERDICT: REJECTED instead.',
].join('\n');

const DEFAULT_VERDICT_REPAIR_MAX_RETRIES = 3;
const MACHINE_VERDICT_LINE = /^SPAR_VERDICT\s*:\s*(APPROVED|REJECTED)\s*$/i;
const ANSI_ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const APPROVAL_NEGATIVE_SIGNAL = /\b(?:fail(?:s|ed|ing)?|broken|missing|issue|problem|todo|remaining|regress(?:ion|ed|ing)?|blocked|incomplete|unverified|cannot|can't|won't|does(?:\s+not|n't)\s+work|timed?\s*out|timeout|error(?:s)?|crash(?:ed|es|ing)?|hang(?:s|ing)?|stuck|loop(?:s|ing)?)\b/;
const APPROVAL_STATUS_SUBJECT = /^(?:the\s+)?(?:verification|validation|review|checks?|tests?|test suite|build|startup|restart(?: recovery)?|recovery|resume|interruption|windows|linux|macos|path handling|persistence|state|flow|loop|output|session|tooling?|high latency|latency)\b/;
const APPROVAL_RECOVERY_SIGNAL = /\b(?:fixed|resolved|verified|passed|passing|working|ready|green|clean|stable|succeeds?|successful)\b/;

function sanitizeReviewerText(text) {
  return String(text ?? '')
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '');
}

function isApprovedVerdictLine(line) {
  const normalized = line.replace(/\s+/g, ' ').trim();
  if (!/^APPROVED\b/i.test(normalized)) return false;
  const trailing = normalized
    .replace(/^APPROVED\b/i, '')
    .replace(/^[\s:;,.!_\-–—]+/, '')
    .trim();
  if (!trailing) return true;
  if (/^(?:if|but|however|except|unless|pending|assuming|subject\s+to)\b/i.test(trailing)) return false;
  return !isConflictingApprovalLine(trailing);
}

function isConflictingApprovalLine(line) {
  const normalized = line.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  const prefixStripped = normalized.replace(/^(?:[-*]|\d+[.)])\s*/, '');
  if (isResolvedHistoricalFailure(prefixStripped)) return false;
  if (isCleanApprovalNote(prefixStripped)) return false;
  if (/\b(?:not approved|cannot approve|can't approve|do not approve|rejected)\b/.test(prefixStripped)) return true;
  if (/^(?:issues?|problems?|remaining(?: issues?)?|fix(?:es)?|todo)\b/.test(prefixStripped)) return true;
  if (/^(?:[-*]|\d+[.)])\s*(?:fix|missing|issue|problem|todo|remaining|still|cannot|can't|do not approve|not approved|rejected)\b/.test(normalized)) return true;
  if (/\b(?:however|but|except|although|though|yet)\b/.test(prefixStripped) && APPROVAL_NEGATIVE_SIGNAL.test(prefixStripped)) return true;
  if (/\b(?:still|remains?|remaining)\b.*\b(?:fail(?:s|ed|ing)?|broken|missing|issue|problem|todo|regress(?:ion|ed|ing)?|blocked|incomplete|unverified)\b/.test(prefixStripped)) return true;
  if (APPROVAL_STATUS_SUBJECT.test(prefixStripped) && APPROVAL_NEGATIVE_SIGNAL.test(prefixStripped)) return true;
  if (prefixStripped !== normalized && APPROVAL_NEGATIVE_SIGNAL.test(prefixStripped)) return true;
  if (hasUnresolvedCurrentFailure(prefixStripped)) return true;
  return false;
}

function hasUnresolvedCurrentFailure(line) {
  if (!APPROVAL_NEGATIVE_SIGNAL.test(line)) return false;
  if (APPROVAL_RECOVERY_SIGNAL.test(line)) return false;
  return /\b(?:is|are|was|were|keeps?|causes?|leaves?|shows?|hits?|reproduces?|returns?|throws?|reports?)\b.*\b(?:fail(?:s|ed|ing)?|broken|missing|issue|problem|todo|remaining|regress(?:ion|ed|ing)?|blocked|incomplete|unverified|cannot|can't|won't|does(?:\s+not|n't)\s+work|timed?\s*out|timeout|error(?:s)?|crash(?:ed|es|ing)?|hang(?:s|ing)?|stuck|loop(?:s|ing)?)\b/.test(line)
    || /\b(?:fail(?:s|ed|ing)?|broken|missing|regress(?:ion|ed|ing)?|blocked|incomplete|unverified|timed?\s*out|timeout|error(?:s)?|crash(?:ed|es|ing)?|hang(?:s|ing)?|stuck|loop(?:s|ing)?)\b.*\b(?:under|during|after|when|with|on)\b/.test(line);
}

function isCleanApprovalNote(line) {
  if (/\b(?:however|but|except|although|though|yet)\b/.test(line)) return false;
  const cleaned = line.split(/(?<=[.!?])\s+/).map((sentence) => sentence
    .replace(/\bno\s+(?:known\s+|open\s+|new\s+|remaining\s+)?(?:issues?|problems?|todos?|failures?|errors?|regressions?|blockers?|crashes?|timeouts?)\b/g, '')
    .replace(/\bno\s+(?:failing|broken|missing|blocked|incomplete|unverified)\s+[a-z0-9_-]+\b/g, '')
    .replace(/^(?:issues?|problems?|todos?|failures?|errors?|regressions?|blockers?)\s*[:—-]?\s*(?:none|resolved|fixed|closed|clear)\.?/g, '')
    .trim()).join(' ').trim();
  return cleaned !== line && !APPROVAL_NEGATIVE_SIGNAL.test(cleaned);
}

function isResolvedHistoricalFailure(line) {
  return /\b(?:previously|formerly|once|earlier)\b.*\b(?:fail(?:ed|ing)?|broken|missing|regress(?:ed|ing)?|blocked|incomplete|unverified)\b.*\b(?:fixed|resolved|verified|passed|working|ready)\b/.test(line)
    || /\b(?:fixed|resolved|verified|passed|working|ready)\b.*\b(?:previously|formerly|once|earlier)\b.*\b(?:fail(?:ed|ing)?|broken|missing|regress(?:ed|ing)?|blocked|incomplete|unverified)\b/.test(line);
}

function interpretReviewerReply(text) {
  const feedback = sanitizeReviewerText(text).trim();
  const meaningfulLines = feedback
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (meaningfulLines.length === 0) {
    return { status: 'invalid', approved: false, feedback: EMPTY_REVIEWER_FEEDBACK, reason: 'empty response' };
  }

  const machineVerdicts = meaningfulLines
    .map((line, index) => {
      const verdict = line.match(MACHINE_VERDICT_LINE)?.[1]?.toUpperCase();
      return verdict ? { verdict, index } : null;
    })
    .filter(Boolean);
  if (machineVerdicts.length === 1) {
    const [{ verdict, index }] = machineVerdicts;
    if (index !== meaningfulLines.length - 1) {
      return { status: 'invalid', approved: false, feedback, reason: 'machine verdict line must be last' };
    }

    const leadingLines = meaningfulLines.slice(0, index);
    if (verdict === 'APPROVED') {
      const conflictingLine = leadingLines.find(isConflictingApprovalLine);
      if (conflictingLine) {
        return {
          status: 'rejected',
          approved: false,
          feedback: `${feedback}\n\n${AMBIGUOUS_APPROVAL_FEEDBACK}`,
        };
      }
      return { status: 'approved', approved: true, feedback };
    }

    return { status: 'rejected', approved: false, feedback };
  }
  if (machineVerdicts.length > 1) {
    return { status: 'invalid', approved: false, feedback, reason: 'multiple machine verdict lines' };
  }

  if (!isApprovedVerdictLine(meaningfulLines[0])) {
    if (isLegacyRejectionReply(meaningfulLines)) {
      return { status: 'rejected', approved: false, feedback };
    }
    if (containsApprovalIntent(feedback) && !APPROVAL_NEGATIVE_SIGNAL.test(feedback.toLowerCase())) {
      return { status: 'invalid', approved: false, feedback, reason: 'approval-like response without machine verdict' };
    }
    return { status: 'rejected', approved: false, feedback };
  }

  const conflictingLine = meaningfulLines.slice(1).find(isConflictingApprovalLine);
  if (conflictingLine) {
    return {
      status: 'rejected',
      approved: false,
      feedback: `${feedback}\n\n${AMBIGUOUS_APPROVAL_FEEDBACK}`,
    };
  }

  return { status: 'approved', approved: true, feedback };
}

function isLegacyRejectionReply(lines) {
  const first = lines[0]?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
  if (/^not approved\b/.test(first)) return true;
  if (APPROVAL_NEGATIVE_SIGNAL.test(lines.join('\n').toLowerCase())) return true;
  if (/^(?:[-*]|\d+[.)])\s+/.test(first) && APPROVAL_NEGATIVE_SIGNAL.test(first)) return true;
  if (/^(?:issues?|problems?|remaining(?: issues?)?|fix(?:es)?|todo)\b/.test(first)) return true;
  return !containsApprovalIntent(lines.join('\n'));
}

function containsApprovalIntent(text) {
  return /\bapproved\b|\bapprove\b|\blooks\s+good\b|\blgtm\b|\bready\s+(?:to|for)\b/i.test(String(text ?? ''));
}

export function createLoopEngine({ config }) {
  let state = initialState();
  const listeners = new Set();
  const eventListeners = new Set();
  let nextFlowId = 1;
  let nextTraceId = 1;
  let runTrace = null;
  const sparSessionStore = config.sparSession?.store || createSparSessionStore({ ...(config.sparSession || {}), config });
  const recoveryStore = config.runRecovery?.store || createRunRecoveryStore({ ...(config.runRecovery || {}), config });
  const loadedRecoveryState = recoveryStore.load?.() || null;
  let recoveryState = loadedRecoveryState || createInitialRunRecoveryState(config);

  function dispatch(action) {
    state = reduce(state, action);
    for (const fn of listeners) fn(state, action);
  }

  function emit(event) {
    for (const fn of eventListeners) fn(event);
  }

  const publish = (event, action = event) => {
    if (action) dispatch(action);
    runTrace?.record('event', { event, action });
    emit(event);
  };

  const innerRenderer = {
    onLaunching: () => publish({ type: 'launching' }),
    onRoleStatus: (event) => publish({ type: 'roleStatus', ...event }),
    onTurnStart: (event) => publish({ type: 'turnStart', ...event }),
    onTurnSnapshot: (event) => publish(
      { type: 'turnSnapshot', ...event },
      { type: 'turnSnapshot', round: event.round, role: event.role, snapshot: event.snapshot },
    ),
    onMessageDelta: (event) => publish(
      { type: 'delta', ...event },
      { type: 'delta', flowId: nextFlowId++, ...event },
    ),
    onReasoningDelta: (event) => publish(
      { type: 'reasoningDelta', ...event },
      { type: 'reasoningDelta', flowId: nextFlowId++, ...event },
    ),
    onReasoningCompleted: (event) => publish(
      { type: 'reasoningCompleted', ...event },
      { type: 'reasoningCompleted', ...event },
    ),
    onPlanUpdate: (event) => publish(
      { type: 'planUpdate', ...event },
      { type: 'planUpdate', at: Date.now(), ...event },
    ),
    onToolStart: (event) => publish(
      { type: 'toolStart', ...event },
      { type: 'toolStart', status: PaneStatus.Running, flowId: nextFlowId++, ...event },
    ),
    onToolUpdate: (event) => publish(
      { type: 'toolUpdate', ...event },
      { type: 'toolUpdate', flowId: nextFlowId++, ...event },
    ),
    onToolEnd: (event) => publish(
      { type: 'toolEnd', ...event },
      { type: 'toolEnd', flowId: nextFlowId++, ...event },
    ),
    onTraceEntry: (event) => publish(
      { type: 'traceEntry', ...event },
      { type: 'traceEntry', traceId: nextTraceId++, ...event },
    ),
    onUsageUpdate: (event) => publish(
      { type: 'usageUpdate', ...event },
      { type: 'usageUpdate', ...event },
    ),
    onTurnCompleted: (event) => publish({ type: 'turnCompleted', ...event }, { type: 'turnCompleted', ...event }),
    onTurnFailed: (event) => publish({ type: 'turnFailed', ...event }, { type: 'turnFailed', ...event }),
    onTurnEnd: (event) => publish({ type: 'turnEnd', ...event }, { type: 'turnEnd', ...event }),
    onApprovalPending: (result) => publish(
      { type: 'approvalPending', result },
      { type: 'approvalPending', result },
    ),
    onApprovalContinued: (event) => publish(
      { type: 'approvalContinued', ...event },
      { type: 'approvalContinued', ...event },
    ),
    onResult: (result) => publish({ type: 'result', result }, { type: 'result', result }),
  };

  function writeRecovery(nextState) {
    recoveryState = cloneJson(nextState);
    recoveryStore.write?.(recoveryState);
  }

  function updateRecovery(update) {
    const nextState = cloneJson(recoveryState);
    update(nextState);
    writeRecovery(nextState);
  }

  function clearRecovery() {
    recoveryStore.clear?.();
  }

  async function run() {
    const { cwd, maxRounds, trace, tui, authorSettings, reviewerSettings } = config;
    runTrace = createRunTraceRecorder({ ...(config.runTrace || {}), cwd, config });
    const captureTrace = Boolean(trace || tui || runTrace.enabled);
    const openRoleFn = config.openRole || openRole;
    const closeRoleFn = config.closeRole || closeRole;
    const retiredRoles = new Set();

    let startup;
    let authorManager;
    let reviewerManager;
    let result;
    let runError;
    try {
      await fs.mkdir(cwd, { recursive: true });
      sparSessionStore.start?.();
      innerRenderer.onLaunching();
      startup = startRoles({
        authorSettings,
        reviewerSettings,
        cwd,
        trace,
        captureTrace,
        renderer: innerRenderer,
        recoveryState,
        openRole: openRoleFn,
      });
      authorManager = createRoleSessionManager({
        role: 'AUTHOR',
        settings: authorSettings,
        getInitialRole: () => startup.getAuthor(),
        openRole: openRoleFn,
        closeRole: closeRoleFn,
        cwd,
        trace,
        captureTrace,
        renderer: innerRenderer,
        maxTurns: authorSettings.sessionTurns,
        recovery: recoveryState.roles?.AUTHOR,
        retiredRoles,
      });
      reviewerManager = createRoleSessionManager({
        role: 'REVIEWER',
        settings: reviewerSettings,
        getInitialRole: () => startup.getReviewer(),
        openRole: openRoleFn,
        closeRole: closeRoleFn,
        cwd,
        trace,
        captureTrace,
        renderer: innerRenderer,
        maxTurns: reviewerSettings.sessionTurns,
        recovery: recoveryState.roles?.REVIEWER,
        retiredRoles,
      });

      result = await runRounds({
        authorManager,
        reviewerManager,
        maxRounds,
        cwd,
        config,
        authorSettings,
        reviewerSettings,
        recoveryState,
        updateRecovery,
        clearRecovery,
        renderer: innerRenderer,
      });
    } catch (error) {
      runError = await normalizeStartupError({ startup, author: authorManager?.getActive(), error });
      const message = formatErrorMessage(runError);
      if (hasRecoverableRunProgress(recoveryState, loadedRecoveryState)) {
        updateRecovery((nextState) => {
          nextState.loop.error = message;
        });
      } else {
        clearRecovery();
      }
      const diagnostics = createFailureDiagnosticBundle({ config, runTrace, recoveryStore, state, error: runError, recoveryState });
      runTrace?.record('failureDiagnostics', { diagnostics });
      dispatch({ type: 'error', error: `${message}\n\n${formatFailureDiagnosticBundle(diagnostics)}` });
      runTrace?.record('event', {
        event: { type: 'error', error: runError },
        action: { type: 'error', error: message, diagnostics },
      });
      emit({ type: 'error', error: runError });
    }

    const startedRoles = await collectStartedRoles({ startup, managers: [authorManager, reviewerManager] });
    const stopLateRoleCleanup = closeLateStartingRoles({
      startup,
      closeRoleFn,
      ignoredStates: startedRoles,
      retiredRoles,
    });

    const closeError = await closeRoles(
      closeRoleFn,
      startedRoles.filter((state) => !retiredRoles.has(state)),
    );
    if (!runError || startup?.rolesSettled?.()) stopLateRoleCleanup();
    const finalError = runError && closeError
      ? new AggregateError(
        [runError, ...toErrorList(closeError)],
        'Author-reviewer loop failed and cleanup also failed.',
      )
      : runError || closeError;
    if (finalError) {
      sparSessionStore.fail?.(finalError);
      runTrace?.close({
        status: 'failed',
        error: finalError,
        runError,
        closeError,
        finalState: summarizeFinalState(state),
      });
    } else {
      sparSessionStore.complete?.(result);
      runTrace?.close({
        status: 'completed',
        result,
        finalState: summarizeFinalState(state),
      });
    }
    if (finalError) throw finalError;
    return result;
  }

  return {
    config,
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onEvent: (fn) => {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    run,
  };
}

async function runRounds({ authorManager, reviewerManager, maxRounds, cwd, config, authorSettings, reviewerSettings, recoveryState, updateRecovery, clearRecovery, renderer }) {
  maxRounds = normalizeRoundLimit(maxRounds);
  let feedback = typeof recoveryState?.loop?.feedback === 'string' ? recoveryState.loop.feedback : '';
  let workspaceChangeSummary = typeof recoveryState?.loop?.workspaceChangeSummary === 'string'
    ? recoveryState.loop.workspaceChangeSummary
    : '';
  let approved = false;
  let lastRound = Math.max(0, Number(recoveryState?.loop?.pending?.round) - 1 || 0);
  let roundLimit = normalizeRoundLimit(recoveryState?.loop?.roundLimit ?? maxRounds);
  let approvalContinuations = normalizeApprovalContinuationLimit(recoveryState?.loop?.approvalContinuations, 0);
  let pending = normalizePendingRecovery(recoveryState?.loop?.pending);
  const continuationLimit = normalizeApprovalContinuationLimit(config.maxApprovalContinuations, maxRounds);
  const hardRoundLimit = maxRounds + continuationLimit;

  for (let round = pending.round; round <= roundLimit; round++) {
    lastRound = round;
    if (pending.type === 'approval-decision' && pending.round === round) {
      const approvedResult = pending.result;
      const resumedResult = await settleApprovedResult({
        result: approvedResult,
        round,
        hardRoundLimit,
        continuationLimit,
        approvalContinuations,
        roundLimit,
        config,
        maxRounds,
        clearRecovery,
        updateRecovery,
        renderer,
      });
      if (resumedResult.done) return resumedResult.result;
      ({ approved, feedback, approvalContinuations, roundLimit, pending } = resumedResult);
      continue;
    }

    let authorReply;
    if (pending.type === 'reviewer-turn' && pending.round === round && typeof pending.authorReply === 'string') {
      authorReply = pending.authorReply;
      workspaceChangeSummary = typeof pending.workspaceChangeSummary === 'string'
        ? pending.workspaceChangeSummary
        : workspaceChangeSummary;
    } else {
      const author = await authorManager.getForTurn();
      const workspaceChangeTracker = createWorkspaceChangeTracker({ cwd });
      updateRecovery((nextState) => {
        writeRoleRecovery(nextState, authorManager, reviewerManager);
        nextState.loop.roundLimit = roundLimit;
        nextState.loop.approvalContinuations = approvalContinuations;
        nextState.loop.feedback = feedback;
        nextState.loop.workspaceChangeSummary = workspaceChangeSummary;
        nextState.loop.pending = { type: 'author-turn', round, started: true };
        delete nextState.loop.error;
      });
      authorReply = await runTurnWithAcpRecovery({
        round,
        role: 'AUTHOR',
        manager: authorManager,
        state: author,
        authorManager,
        reviewerManager,
        prompt: authorSettings.prompt({ round, feedback }),
        renderer,
        updateRecovery,
      });
      workspaceChangeSummary = formatWorkspaceChangeSummary(workspaceChangeTracker.summarize());
    }

    let reviewer = await reviewerManager.getForTurn();
    updateRecovery((nextState) => {
      writeRoleRecovery(nextState, authorManager, reviewerManager);
      nextState.loop.roundLimit = roundLimit;
      nextState.loop.approvalContinuations = approvalContinuations;
      nextState.loop.feedback = feedback;
      nextState.loop.workspaceChangeSummary = workspaceChangeSummary;
      nextState.loop.pending = { type: 'reviewer-turn', round, started: true, authorReply, workspaceChangeSummary };
      delete nextState.loop.error;
    });
    let reply = await runTurnWithAcpRecovery({
      round,
      role: 'REVIEWER',
      manager: reviewerManager,
      state: reviewer,
      authorManager,
      reviewerManager,
      prompt: reviewerSettings.prompt({ round, feedback, authorReply, workspaceChangeSummary }),
      renderer,
      updateRecovery,
    });

    let verdict = interpretReviewerReply(reply);
    if (verdict.status === 'invalid') {
      verdict = await repairReviewerVerdict({
        initialReply: reply,
        initialVerdict: verdict,
        round,
        reviewerManager,
        authorManager,
        maxRetries: config.verdictRepairMaxRetries,
        renderer,
        updateRecovery,
      });
      reply = verdict.feedback;
    }

    ({ approved, feedback } = verdict);
    if (approved && config.dangerIgnoreApproval && round < roundLimit) {
      pending = { type: 'author-turn', round: round + 1, started: false };
      updateRecovery((nextState) => {
        writeRoleRecovery(nextState, authorManager, reviewerManager);
        nextState.loop.roundLimit = roundLimit;
        nextState.loop.approvalContinuations = approvalContinuations;
        nextState.loop.feedback = feedback;
        nextState.loop.workspaceChangeSummary = workspaceChangeSummary;
        nextState.loop.pending = pending;
        nextState.loop.dangerIgnoreApproval = true;
        delete nextState.loop.error;
      });
      continue;
    }

    if (!approved) {
      pending = { type: 'author-turn', round: round + 1, started: false };
      updateRecovery((nextState) => {
        writeRoleRecovery(nextState, authorManager, reviewerManager);
        nextState.loop.roundLimit = roundLimit;
        nextState.loop.approvalContinuations = approvalContinuations;
        nextState.loop.feedback = feedback;
        nextState.loop.workspaceChangeSummary = workspaceChangeSummary;
        nextState.loop.pending = pending;
        delete nextState.loop.error;
      });
      continue;
    }

    const result = { approved: true, feedback, maxRounds: roundLimit, rounds: lastRound, cwd };
    if (config.dangerIgnoreApproval) {
      clearRecovery();
      renderer.onResult(result);
      return result;
    }

    updateRecovery((nextState) => {
      writeRoleRecovery(nextState, authorManager, reviewerManager);
      nextState.loop.roundLimit = roundLimit;
      nextState.loop.approvalContinuations = approvalContinuations;
      nextState.loop.feedback = feedback;
      nextState.loop.workspaceChangeSummary = workspaceChangeSummary;
      nextState.loop.pending = { type: 'approval-decision', round, started: true, result };
      delete nextState.loop.error;
    });

    const approvalResult = await settleApprovedResult({
      result,
      round,
      hardRoundLimit,
      continuationLimit,
      approvalContinuations,
      roundLimit,
      config,
      maxRounds,
      clearRecovery,
      updateRecovery,
      renderer,
    });
    if (approvalResult.done) return approvalResult.result;
    ({ approved, feedback, approvalContinuations, roundLimit, pending } = approvalResult);
  }

  const result = { approved, feedback, maxRounds: roundLimit, rounds: lastRound, cwd };
  clearRecovery();
  renderer.onResult(result);
  return result;
}

/**
 * Normalize the base round budget for programmatic callers.
 * Positive integers are preserved. Any zero, negative, fractional, or
 * non-finite value falls back to at least one executable round.
 */
function normalizeRoundLimit(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (Number.isFinite(value)) return Math.max(1, Math.trunc(value));
  return 1;
}

/**
 * Normalize post-approval continuation budgets.
 * Only non-negative integers are accepted. Any fractional, negative, or
 * non-finite value falls back to the already-normalized base round budget so
 * reopened approval loops stay deterministic for programmatic callers.
 */
function normalizeApprovalContinuationLimit(value, fallback) {
  if (Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

function startRoles({ authorSettings, reviewerSettings, cwd, trace, captureTrace, renderer, recoveryState, openRole: openRoleFn = openRole }) {
  const startupProfile = createStartupProfiler({ scope: 'loop-startup' });
  let author;
  let reviewer;
  let authorError;
  let reviewerError;
  let authorSettled = false;
  let reviewerSettled = false;
  const settledListeners = new Set();

  function notifyRoleSettled(event) {
    for (const listener of settledListeners) listener(event);
  }

  const authorPromise = Promise.resolve()
    .then(() => openRoleFn({ role: 'AUTHOR', settings: authorSettings, cwd, trace, captureTrace, renderer, recovery: recoveryState?.roles?.AUTHOR }))
    .then((state) => {
      author = state;
      authorSettled = true;
      notifyRoleSettled({ role: 'AUTHOR', state });
      return state;
    }, (error) => {
      authorError = toError(error);
      authorSettled = true;
      notifyRoleSettled({ role: 'AUTHOR', error: authorError });
      throw error;
    });

  const reviewerPromise = Promise.resolve()
    .then(() => openRoleFn({ role: 'REVIEWER', settings: reviewerSettings, cwd, trace, captureTrace, renderer, recovery: recoveryState?.roles?.REVIEWER }))
    .then((state) => {
      reviewer = state;
      reviewerSettled = true;
      notifyRoleSettled({ role: 'REVIEWER', state });
      startupProfile.mark({
        phase: 'reviewer role ready',
        detail: {
          reviewerAgent: reviewer?.session?.agent?.displayName ?? reviewerSettings.agent?.displayName,
        },
      });
      return state;
    }, (error) => {
      reviewerError = toError(error);
      reviewerSettled = true;
      notifyRoleSettled({ role: 'REVIEWER', error: reviewerError });
      throw error;
    });

  const bothReadyPromise = Promise.all([authorPromise, reviewerPromise]).then(([readyAuthor, readyReviewer]) => {
    startupProfile.mark({
      phase: 'both roles ready',
      detail: {
        authorAgent: readyAuthor?.session?.agent?.displayName ?? authorSettings.agent?.displayName,
        reviewerAgent: readyReviewer?.session?.agent?.displayName ?? reviewerSettings.agent?.displayName,
      },
    });
  });
  bothReadyPromise.catch(() => undefined);

  return {
    async getAuthor() {
      return authorPromise;
    },
    async getReviewer() {
      return reviewerPromise;
    },
    getStartedRoles() {
      return [author, reviewer].filter(Boolean);
    },
    rolesSettled() {
      return authorSettled && reviewerSettled;
    },
    async settleStartedRoles() {
      if (!authorSettled || !reviewerSettled) {
        await Promise.allSettled([authorPromise, reviewerPromise]);
      }
      return [author, reviewer].filter(Boolean);
    },
    async getStartupFailures({ waitForPending = true } = {}) {
      if (waitForPending && (!authorSettled || !reviewerSettled)) {
        await Promise.allSettled([authorPromise, reviewerPromise]);
      }
      return [authorError, reviewerError].filter(Boolean);
    },
    onRoleSettled(listener) {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },
  };
}

function createRoleSessionManager({ role, settings, getInitialRole, openRole: openRoleFn, closeRole: closeRoleFn, cwd, trace, captureTrace, renderer, maxTurns, recovery, retiredRoles }) {
  const manager = createSessionTurnManager({
    maxTurns,
    recovery,
    getInitial: getInitialRole,
    open: () => openRoleFn({ role, settings, cwd, trace, captureTrace, renderer }),
    close: async (state) => {
      await closeRoleFn(state);
      if (state) retiredRoles.add(state);
    },
    getSessionId: (state) => state?.session?.sessionId,
    onRefresh: ({ turnLimit }) => {
      renderer.onRoleStatus?.({ role, message: 'refreshing session after ' + turnLimit + ' turn(s)...' });
    },
    onRecover: () => {
      renderer.onRoleStatus?.({ role, message: 'recovering session after ACP internal error...' });
    },
    onCloseError: (_error, state) => {
      if (state) retiredRoles.add(state);
    },
  });

  return {
    getForTurn: () => manager.getForTurn(),
    recoverForRetry: () => manager.recoverForRetry(),
    getActive: () => manager.getActive(),
    getStartedRoles: () => manager.getStarted(),
    getRecoverySnapshot: () => manager.getRecoverySnapshot(),
  };
}

async function settleApprovedResult({ result, round, hardRoundLimit, continuationLimit, approvalContinuations, roundLimit, config, maxRounds, clearRecovery, updateRecovery, renderer }) {
  if (config.onApproved) renderer.onApprovalPending(result);
  const decision = await config.onApproved?.(result);
  if (!decision?.continue) {
    clearRecovery();
    renderer.onResult(result);
    return { done: true, result };
  }

  if (approvalContinuations >= continuationLimit || round >= hardRoundLimit) {
    const cappedResult = {
      ...result,
      maxRounds: hardRoundLimit,
      continuationLimitReached: true,
      feedback: `${result.feedback}\n\nApproval continuation limit reached after ${approvalContinuations} continuation(s).`,
    };
    clearRecovery();
    renderer.onResult(cappedResult);
    return { done: true, result: cappedResult };
  }

  const nextApprovalContinuations = approvalContinuations + 1;
  const nextRoundLimit = round === roundLimit ? Math.min(roundLimit + 1, hardRoundLimit) : roundLimit;
  const nextFeedback = decision.feedback || `The task changed after approval. Continue with the updated task:\n${config.task}`;
  const nextPending = { type: 'author-turn', round: round + 1, started: false };
  renderer.onApprovalContinued?.({ round, feedback: nextFeedback });
  updateRecovery((nextState) => {
    nextState.loop.roundLimit = nextRoundLimit;
    nextState.loop.approvalContinuations = nextApprovalContinuations;
    nextState.loop.feedback = nextFeedback;
    nextState.loop.pending = nextPending;
    delete nextState.loop.error;
  });
  return {
    done: false,
    approved: false,
    feedback: nextFeedback,
    approvalContinuations: nextApprovalContinuations,
    roundLimit: nextRoundLimit,
    pending: nextPending,
  };
}

function writeRoleRecovery(nextState, authorManager, reviewerManager) {
  nextState.roles = nextState.roles || {};
  assignRoleRecovery(nextState.roles, 'AUTHOR', authorManager?.getRecoverySnapshot?.());
  assignRoleRecovery(nextState.roles, 'REVIEWER', reviewerManager?.getRecoverySnapshot?.());
}

async function runTurnWithAcpRecovery({ round, role, manager, state, authorManager, reviewerManager, prompt, renderer, updateRecovery }) {
  updateRecovery((nextState) => {
    writeRoleRecovery(nextState, authorManager, reviewerManager);
  });
  try {
    return await runTurn({ round, role, state, prompt, renderer });
  } catch (error) {
    if (!isAcpInternalError(error)) throw error;
    const retryState = await manager.recoverForRetry();
    updateRecovery((nextState) => {
      writeRoleRecovery(nextState, authorManager, reviewerManager);
      delete nextState.loop.error;
    });
    return runTurn({ round, role, state: retryState, prompt, renderer });
  }
}

async function repairReviewerVerdict({ initialReply, initialVerdict, round, reviewerManager, authorManager, maxRetries, renderer, updateRecovery }) {
  let latestReply = initialReply;
  let latestVerdict = initialVerdict;
  const retryLimit = normalizeVerdictRepairMaxRetries(maxRetries);
  for (let attempt = 1; attempt <= retryLimit; attempt++) {
    const reviewer = await reviewerManager.getForTurn();
    latestReply = await runTurnWithAcpRecovery({
      round,
      role: 'REVIEWER',
      manager: reviewerManager,
      state: reviewer,
      authorManager,
      reviewerManager,
      prompt: createVerdictRepairPrompt({ attempt, maxRetries: retryLimit, previousReply: latestReply, reason: latestVerdict?.reason }),
      renderer,
      updateRecovery,
    });
    latestVerdict = interpretReviewerReply(latestReply);
    if (latestVerdict.status === 'approved') return latestVerdict;
    if (latestVerdict.status === 'rejected') {
      return {
        ...latestVerdict,
        feedback: initialVerdict?.feedback || latestVerdict.feedback,
      };
    }
  }

  const error = new Error([
    `Reviewer did not provide a valid SPAR_VERDICT after ${retryLimit} repair attempt(s).`,
    '',
    'Expected exactly one final verdict line:',
    'SPAR_VERDICT: APPROVED',
    'or',
    'SPAR_VERDICT: REJECTED',
    '',
    'Last reviewer reply:',
    String(latestReply ?? '').trim() || '<empty>',
  ].join('\n'));
  error.name = 'ReviewerVerdictError';
  throw error;
}

function createVerdictRepairPrompt({ attempt, maxRetries, previousReply, reason }) {
  return [
    `Your previous review did not include a valid machine-readable Spar verdict (${attempt}/${maxRetries}).`,
    reason ? `Parser reason: ${reason}.` : null,
    '',
    'Do not continue reviewing. Do not add new analysis. Do not modify files.',
    'Keep your decision consistent with your previous review, and reply with exactly one of these two lines:',
    '',
    'SPAR_VERDICT: APPROVED',
    'SPAR_VERDICT: REJECTED',
    '',
    'Choose APPROVED only if your previous review meant the task is complete and no concrete fixes remain.',
    'Choose REJECTED if your previous review listed any remaining required fix, uncertainty, blocker, or missing validation.',
    '',
    'No markdown. No bullet list. No explanation. Output exactly one line.',
    '',
    'Previous review:',
    '---',
    String(previousReply ?? '').trim() || '<empty>',
    '---',
  ].filter(Boolean).join('\n');
}

function normalizeVerdictRepairMaxRetries(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  return DEFAULT_VERDICT_REPAIR_MAX_RETRIES;
}

function assignRoleRecovery(target, role, snapshot) {
  if (!snapshot?.sessionId) {
    delete target[role];
    return;
  }
  target[role] = {
    sessionId: snapshot.sessionId,
    turnsOnActiveSession: Math.max(0, Number(snapshot.turnsOnActiveSession) || 0),
  };
}

function isAcpInternalError(error) {
  const text = formatCompactErrorMessage(error).toLowerCase();
  const name = error instanceof Error ? String(error.name || '').toLowerCase() : '';
  return text.includes('internal error') && (name.includes('request') || text.includes('requesterror') || text.includes('json-rpc') || text.includes('acp'));
}

function formatCompactErrorMessage(error) {
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  return String(error);
}

function hasRecoverableRunProgress(state, loadedState) {
  if (loadedState) return true;
  const pending = state?.loop?.pending;
  if (!pending || typeof pending !== 'object') return false;
  if (pending.started) return true;
  if (pending.type !== 'author-turn' || pending.round !== 1) return true;
  return Boolean(state?.roles?.AUTHOR?.sessionId || state?.roles?.REVIEWER?.sessionId);
}

function normalizePendingRecovery(value) {
  if (!value || typeof value !== 'object') return { type: 'author-turn', round: 1, started: false };
  if (!['author-turn', 'reviewer-turn', 'approval-decision'].includes(value.type)) {
    return { type: 'author-turn', round: 1, started: false };
  }
  return {
    ...value,
    round: Number.isInteger(value.round) && value.round >= 1 ? value.round : 1,
    started: Boolean(value.started),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function normalizeStartupError({ startup, author, error }) {
  if (!startup || author) return error;
  const failures = await startup.getStartupFailures({ waitForPending: false });
  if (failures.length > 1) return new AggregateError(failures, 'Role startup failed.');
  return failures[0] ?? error;
}

async function collectStartedRoles({ startup, managers = [] }) {
  const managerRoles = managers.flatMap((manager) => manager?.getStartedRoles?.() ?? []);
  if (!startup) return Array.from(new Set(managerRoles.filter(Boolean)));
  return Array.from(new Set([...startup.getStartedRoles(), ...managerRoles].filter(Boolean)));
}

function closeLateStartingRoles({ startup, closeRoleFn, ignoredStates = [], retiredRoles = new Set() }) {
  if (!startup?.onRoleSettled) return () => {};
  if (startup.rolesSettled?.()) return () => {};
  const ignored = new Set(ignoredStates.filter(Boolean));
  let stopped = false;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
  };
  unsubscribe = startup.onRoleSettled(({ state }) => {
    if (!state || ignored.has(state) || retiredRoles.has(state)) {
      if (startup.rolesSettled?.()) stop();
      return;
    }
    ignored.add(state);
    Promise.resolve()
      .then(() => closeRoleFn(state))
      .catch(() => undefined)
      .finally(() => {
        if (startup.rolesSettled?.()) stop();
      });
  });
  if (startup.rolesSettled?.()) stop();
  return stop;
}
async function closeRoles(closeRoleFn, states) {
  const activeStates = states.filter(Boolean);
  if (activeStates.length === 0) return null;
  const results = await Promise.allSettled(
    activeStates.map((state) => Promise.resolve().then(() => closeRoleFn(state))),
  );
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length === 0) return null;
  if (errors.length === 1) return toError(errors[0]);
  return new AggregateError(errors.map((error) => toError(error)), 'Failed to close author/reviewer roles.');
}

function summarizeFinalState(state) {
  return {
    phase: state?.phase,
    rounds: state?.order?.length ?? 0,
    selected: state?.selected ?? null,
    traceEntries: state?.trace?.length ?? 0,
    hasError: Boolean(state?.error),
    result: state?.result ?? null,
  };
}

function toErrorList(error) {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors.map((item) => toError(item));
  }
  return [toError(error)];
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function formatErrorMessage(error) {
  if (error instanceof Error && error.name === 'ConfigurationError') return error.message;
  return error instanceof Error ? error.stack || error.message : String(error);
}
