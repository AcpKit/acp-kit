import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

import { sparDataDir } from './run-trace.mjs';

export const RUN_RECOVERY_DIR_NAME = 'run-recovery';
export const RUN_RECOVERY_ENV = 'SPAR_RUN_RECOVERY';

const RECOVERY_STATE_VERSION = 1;

export function runRecoveryDirectory({ home = os.homedir() } = {}) {
  return path.join(sparDataDir({ home }), RUN_RECOVERY_DIR_NAME);
}

export function runRecoveryEnabled(env = process.env) {
  const value = String(env?.[RUN_RECOVERY_ENV] ?? '').trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  if (env?.VITEST && value === '') return false;
  return true;
}

export function createInitialRunRecoveryState(config = {}) {
  return {
    version: RECOVERY_STATE_VERSION,
    identity: runRecoveryIdentity(config),
    identityHash: createRunRecoveryId({ config }),
    updatedAt: Date.now(),
    loop: {
      roundLimit: normalizeRoundLimit(config.maxRounds),
      approvalContinuations: 0,
      feedback: '',
      pending: {
        type: 'author-turn',
        round: 1,
        started: false,
      },
    },
    roles: {},
  };
}

export function createRunRecoveryId({ config } = {}) {
  return createHash('sha256')
    .update(JSON.stringify(runRecoveryIdentity(config)))
    .digest('hex')
    .slice(0, 24);
}

export function runRecoveryFilePath({
  home = os.homedir(),
  config,
  recoveryId = createRunRecoveryId({ config }),
} = {}) {
  return path.join(runRecoveryDirectory({ home }), `${recoveryId}.json`);
}

export function createRunRecoveryStore({
  enabled = runRecoveryEnabled(),
  home = os.homedir(),
  config,
  filePath = runRecoveryFilePath({ home, config }),
  now = Date.now,
  mkdirSync = fs.mkdirSync,
  readFileSync = fs.readFileSync,
  renameSync = fs.renameSync,
  rmSync = fs.rmSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  let active = Boolean(enabled);

  const store = {
    filePath,
    get enabled() {
      return active;
    },
    load() {
      if (!active) return null;
      try {
        const text = readFileSync(filePath, 'utf8');
        const loaded = normalizeLoadedRunRecovery(JSON.parse(text), { config });
        if (!loaded) {
          quarantineInvalidRecoveryFile({ filePath, now, renameSync, rmSync });
          return null;
        }
        return loaded;
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
          return null;
        }
        quarantineInvalidRecoveryFile({ filePath, now, renameSync, rmSync });
        return null;
      }
    },
    write(state) {
      if (!active) return false;
      const payload = {
        version: RECOVERY_STATE_VERSION,
        identity: runRecoveryIdentity(config),
        identityHash: createRunRecoveryId({ config }),
        updatedAt: now(),
        loop: cloneJson(state?.loop ?? {}),
        roles: cloneJson(state?.roles ?? {}),
      };
      const tempPath = `${filePath}.tmp-${process.pid}-${Math.max(0, Number(now()) || Date.now())}`;
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        renameSync(tempPath, filePath);
        return true;
      } catch {
        active = false;
        try {
          rmSync(tempPath, { force: true });
        } catch {
          // Ignore cleanup failures after a disabled recovery write.
        }
        return false;
      }
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Recovery cleanup is best-effort and must never affect the run.
      }
    },
  };

  return store;
}

export function normalizeLoadedRunRecovery(value, { config } = {}) {
  if (!value || typeof value !== 'object') return null;
  if (value.version !== RECOVERY_STATE_VERSION) return null;

  const expectedIdentityHash = createRunRecoveryId({ config });
  if (value.identityHash !== expectedIdentityHash) return null;

  const loop = normalizeLoopState(value.loop);
  if (!loop) return null;

  return {
    version: RECOVERY_STATE_VERSION,
    identity: runRecoveryIdentity(config),
    identityHash: expectedIdentityHash,
    updatedAt: normalizeNonNegativeInt(value.updatedAt, Date.now()),
    loop,
    roles: normalizeRolesState(value.roles),
  };
}

export function runRecoveryIdentity(config = {}) {
  return {
    cwd: path.resolve(String(config.cwd ?? process.cwd())),
    task: String(config.task ?? ''),
    quality: config.quality === 'dev' ? 'dev' : 'prod',
    maxRounds: normalizeRoundLimit(config.maxRounds),
    maxApprovalContinuations: normalizeOptionalInt(config.maxApprovalContinuations),
    author: summarizeRoleSettings(config.authorSettings),
    reviewer: summarizeRoleSettings(config.reviewerSettings),
  };
}

function summarizeRoleSettings(settings = {}) {
  return {
    agent: settings.agent?.id ?? null,
    model: settings.model ?? null,
    sessionTurns: normalizePositiveInt(settings.sessionTurns, 20),
  };
}

function normalizeLoopState(value) {
  if (!value || typeof value !== 'object') return null;
  const pending = normalizePendingAction(value.pending);
  if (!pending) return null;

  return {
    roundLimit: normalizePositiveInt(value.roundLimit, null),
    approvalContinuations: normalizeNonNegativeInt(value.approvalContinuations, 0),
    feedback: typeof value.feedback === 'string' ? value.feedback : '',
    pending,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}

function normalizeRolesState(value) {
  const next = {};
  if (!value || typeof value !== 'object') return next;

  for (const role of ['AUTHOR', 'REVIEWER']) {
    const normalized = normalizeRoleState(value[role]);
    if (normalized) next[role] = normalized;
  }

  return next;
}

function normalizeRoleState(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0) return null;
  return {
    sessionId: value.sessionId,
    turnsOnActiveSession: normalizeNonNegativeInt(value.turnsOnActiveSession, 0),
  };
}

function normalizePendingAction(value) {
  if (!value || typeof value !== 'object') return null;
  if (!['author-turn', 'reviewer-turn', 'approval-decision'].includes(value.type)) return null;

  const pending = {
    type: value.type,
    round: normalizePositiveInt(value.round, null),
    started: Boolean(value.started),
  };
  if (!pending.round) return null;

  if (value.type === 'reviewer-turn') {
    if (typeof value.authorReply !== 'string') return null;
    pending.authorReply = value.authorReply;
  }

  if (value.type === 'approval-decision') {
    const result = normalizeApprovalResult(value.result);
    if (!result) return null;
    pending.result = result;
  }

  return pending;
}

function normalizeApprovalResult(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.approved !== 'boolean') return null;
  return {
    approved: value.approved,
    feedback: typeof value.feedback === 'string' ? value.feedback : '',
    maxRounds: normalizePositiveInt(value.maxRounds, null),
    rounds: normalizePositiveInt(value.rounds, null),
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    continuationLimitReached: Boolean(value.continuationLimitReached),
  };
}

function quarantineInvalidRecoveryFile({ filePath, now, renameSync, rmSync }) {
  const corruptPath = filePath.replace(/\.json$/u, '') + `.corrupt-${Math.max(0, Number(now()) || Date.now())}.json`;
  try {
    renameSync(filePath, corruptPath);
  } catch {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Ignore cleanup failures for invalid recovery files.
    }
  }
}

function normalizePositiveInt(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function normalizeRoundLimit(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (Number.isFinite(value)) return Math.max(1, Math.trunc(value));
  return 1;
}

function normalizeNonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeOptionalInt(value) {
  return Number.isInteger(value) ? value : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
