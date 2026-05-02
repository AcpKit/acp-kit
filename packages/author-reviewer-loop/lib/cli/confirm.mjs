import process from 'node:process';
import { createInterface } from 'node:readline/promises';

export async function confirmRun() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'Refusing to start without confirmation in a non-interactive terminal. '
        + 'Pass --yes or set ACP_REVIEW_YES=1 to proceed.',
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Start run? [y/N] ');
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function confirmRunRecovery(recoveryState) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'Found an interrupted Spar run, but recovery requires interactive confirmation. '
        + 'Re-run in an interactive terminal to resume or disable run recovery explicitly to start fresh.',
    );
    return null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const summary = formatRecoveryPromptSummary(recoveryState);
    if (summary) console.log(summary);
    const answer = await rl.question('Resume interrupted Spar run? [y/N] ');
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function confirmDangerIgnoreApproval({ maxRounds } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'Refusing --danger-ignore-approval in a non-interactive terminal. '
        + 'This mode requires explicit double confirmation and cannot be bypassed with --yes.',
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(formatDangerIgnoreApprovalWarning({ maxRounds }));
    const first = await rl.question('Type RUN ALL ROUNDS to continue: ');
    if (first.trim() !== 'RUN ALL ROUNDS') return false;
    const second = await rl.question('Type IGNORE APPROVAL to confirm: ');
    return second.trim() === 'IGNORE APPROVAL';
  } finally {
    rl.close();
  }
}

export function formatDangerIgnoreApprovalWarning({ maxRounds } = {}) {
  return [
    'DANGER: --danger-ignore-approval is enabled.',
    `Spar will ignore REVIEWER approval and run all ${Number.isFinite(maxRounds) ? maxRounds : 'configured'} round(s).`,
    'This can overwrite already-approved work and spend more agent time than necessary.',
    'This confirmation is required even when --yes or ACP_REVIEW_YES=1 is set.',
  ].join('\n');
}

export function formatRecoveryPromptSummary(recoveryState) {
  const pending = recoveryState?.loop?.pending;
  if (!pending) return '';
  const round = Number.isFinite(pending.round) ? pending.round : '?';
  const type = typeof pending.type === 'string' ? pending.type : 'unknown';
  const updatedAt = Number.isFinite(recoveryState?.updatedAt)
    ? new Date(recoveryState.updatedAt).toISOString()
    : null;
  return [
    'Found an interrupted Spar run checkpoint.',
    `Pending step: ${type} round ${round}.`,
    updatedAt ? `Updated at: ${updatedAt}.` : null,
    'Default is no: start fresh and discard this checkpoint.',
  ].filter(Boolean).join('\n');
}
