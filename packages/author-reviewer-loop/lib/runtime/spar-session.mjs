import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { sparDataDir } from './run-trace.mjs';

export const SPAR_SESSION_DIR_NAME = 'sessions';
export const SPAR_SESSION_RECORD_ENV = 'SPAR_SESSION_RECORD';

const SPAR_SESSION_RECORD_VERSION = 1;

export function sparSessionDirectory({ home = os.homedir() } = {}) {
  return path.join(sparDataDir({ home }), SPAR_SESSION_DIR_NAME);
}

export function createSparSessionId({ now = Date.now, random = Math.random, pid = process.pid } = {}) {
  const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const suffix = Math.floor(random() * 0x1000000).toString(16).padStart(6, '0');
  return `${timestamp}-${pid}-${suffix}`;
}

export function sparSessionFilePath({ home = os.homedir(), sparSessionId = createSparSessionId() } = {}) {
  return path.join(sparSessionDirectory({ home }), `${sparSessionId}.json`);
}

export function sparSessionRecordingEnabled(env = process.env) {
  const value = String(env?.[SPAR_SESSION_RECORD_ENV] ?? '').trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  if (env?.VITEST && value === '') return false;
  return true;
}

export function createSparSessionStore({
  enabled = sparSessionRecordingEnabled(),
  home = os.homedir(),
  config,
  sparSessionId = createSparSessionId(),
  filePath = sparSessionFilePath({ home, sparSessionId }),
  now = Date.now,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  let active = Boolean(enabled);
  let record = null;

  function write(nextRecord) {
    if (!active) return false;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(nextRecord, null, 2)}\n`, 'utf8');
      return true;
    } catch {
      active = false;
      return false;
    }
  }

  function update(status, detail = {}) {
    if (!record) return false;
    record = {
      ...record,
      status,
      updatedAt: now(),
      ...detail,
    };
    return write(record);
  }

  return {
    sparSessionId,
    filePath,
    get enabled() {
      return active;
    },
    get current() {
      return record ? cloneJson(record) : null;
    },
    start() {
      record = createSparSessionRecord({ config, sparSessionId, now });
      write(record);
      return record;
    },
    complete(result) {
      return update('completed', { result: cloneJson(result ?? null) });
    },
    fail(error) {
      return update('failed', { error: summarizeError(error) });
    },
  };
}

export function createSparSessionRecord({ config = {}, sparSessionId = createSparSessionId(), now = Date.now } = {}) {
  const at = now();
  return {
    version: SPAR_SESSION_RECORD_VERSION,
    sparSessionId,
    status: 'running',
    createdAt: at,
    updatedAt: at,
    pid: process.pid,
    cwd: path.resolve(String(config.cwd ?? process.cwd())),
    task: String(config.task ?? ''),
    taskSource: config.taskSource ?? { kind: 'text' },
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
    agentName: settings.agent?.displayName ?? null,
    model: settings.model ?? null,
    sessionTurns: normalizePositiveInt(settings.sessionTurns, 20),
  };
}

function summarizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function normalizePositiveInt(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function normalizeRoundLimit(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (Number.isFinite(value)) return Math.max(1, Math.trunc(value));
  return 1;
}

function normalizeOptionalInt(value) {
  return Number.isInteger(value) ? value : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
