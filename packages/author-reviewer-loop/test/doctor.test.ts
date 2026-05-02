import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { agents } from '../lib/config/agents.mjs';
import { createDoctorReport, formatDoctorReport } from '../lib/cli/doctor.mjs';

const TEMP_DIRS: string[] = [];
const CLI_BIN = path.resolve('packages', 'author-reviewer-loop', 'bin', 'acp-author-reviewer-loop.mjs');

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-doctor-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function config(cwd = tempDir()) {
  return {
    cwd,
    version: '0.0.0-test',
    authorSettings: { agent: agents.codex },
    reviewerSettings: { agent: agents.claude },
  };
}

describe('spar doctor', () => {
  it('reports local readiness, real-workspace policy, and version checks', () => {
    const report = createDoctorReport(config(), {
      nodeVersion: '20.11.0',
      detectAgents: (agentList) => agentList.map((agent) => ({ agent, installed: true })),
    });

    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain('PASS Node.js: 20.11.0 meets required >= 20.11');
    expect(formatDoctorReport(report)).toContain('AUTHOR real workspace: launch args');
    expect(formatDoctorReport(report)).toContain('REVIEWER real workspace: env IS_SANDBOX=1; session mode bypassPermissions');
    expect(formatDoctorReport(report)).toContain('PASS Spar version: 0.0.0-test');
  });

  it('fails when a configured agent is unavailable', () => {
    const report = createDoctorReport(config(), {
      nodeVersion: '20.11.0',
      detectAgents: (agentList) => agentList.map((agent) => ({ agent, installed: agent.id !== agents.claude.id })),
    });

    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toContain('FAIL REVIEWER agent');
  });

  it('is exposed by the real CLI entry point without starting a Spar run', () => {
    const cwd = tempDir();
    const result = spawnSync(process.execPath, [CLI_BIN, cwd, 'diagnose environment', '--doctor', '--cli'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTHOR_AGENT: 'codex',
        REVIEWER_AGENT: 'codex',
        AUTHOR_MODEL: '',
        REVIEWER_MODEL: '',
        SPAR_NO_UPDATE_CHECK: '1',
      },
    });

    expect(result.stdout).toContain('Spar doctor');
    expect(result.stdout).toContain('Spar version');
    expect(result.stdout).not.toContain('Run configuration');
  });
});
