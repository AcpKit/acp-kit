import fs from 'node:fs';
import process from 'node:process';
import { detectInstalledAgents } from '@acp-kit/core';
import { summarizeRealWorkspacePolicy } from '../runtime/real-workspace.mjs';

const MIN_NODE = Object.freeze({ major: 20, minor: 11 });

export function createDoctorReport(config, { detectAgents = detectInstalledAgents, nodeVersion = process.versions.node, fsImpl = fs } = {}) {
  const checks = [
    checkNodeVersion(nodeVersion),
    checkCwdWritable(config.cwd, fsImpl),
    ...checkAgents(config, detectAgents),
    ...checkRealWorkspacePolicies(config),
    checkSparVersion(config),
  ];
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

export function formatDoctorReport(report) {
  const lines = ['Spar doctor'];
  for (const check of report.checks ?? []) {
    lines.push(`${statusMark(check.status)} ${check.label}: ${check.message}`);
  }
  lines.push(`Result: ${report.ok ? 'ok' : 'failed'}`);
  return `${lines.join('\n')}\n`;
}

function checkNodeVersion(version) {
  const [major, minor] = String(version || '').split('.').map((part) => Number(part));
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return {
    status: ok ? 'pass' : 'fail',
    label: 'Node.js',
    message: `${version || '<unknown>'} ${ok ? 'meets' : 'does not meet'} required >= 20.11`,
  };
}

function checkCwdWritable(cwd, fsImpl) {
  const file = `${cwd}/.spar-doctor-${process.pid}-${Date.now()}.tmp`;
  try {
    fsImpl.mkdirSync(cwd, { recursive: true });
    fsImpl.writeFileSync(file, 'ok', 'utf8');
    fsImpl.rmSync(file, { force: true });
    return { status: 'pass', label: 'Workspace', message: `${cwd} is writable` };
  } catch (error) {
    try { fsImpl.rmSync(file, { force: true }); } catch {}
    return { status: 'fail', label: 'Workspace', message: `${cwd} is not writable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function checkAgents(config, detectAgents) {
  const roles = [
    ['AUTHOR', config.authorSettings],
    ['REVIEWER', config.reviewerSettings],
  ];
  const agents = roles.map(([, settings]) => settings?.agent).filter(Boolean);
  const detected = new Map(detectAgents(agents).map((entry) => [entry.agent.id, entry.installed]));
  return roles.map(([role, settings]) => {
    const agent = settings?.agent;
    if (!agent) return { status: 'fail', label: `${role} agent`, message: 'not configured' };
    const installed = detected.get(agent.id) === true;
    return {
      status: installed ? 'pass' : 'fail',
      label: `${role} agent`,
      message: `${agent.displayName} (${agent.command}) ${installed ? 'is available' : 'is not available on PATH or fallback PATH'}`,
    };
  });
}

function checkRealWorkspacePolicies(config) {
  return [
    ['AUTHOR', config.authorSettings],
    ['REVIEWER', config.reviewerSettings],
  ].map(([role, settings]) => {
    const summary = summarizeRealWorkspacePolicy(settings?.agent);
    if (!summary) {
      return { status: 'warn', label: `${role} real workspace`, message: 'no Spar-specific real-workspace policy for this agent' };
    }
    const parts = [];
    if (summary.launchArgs?.length) parts.push(`launch args ${summary.launchArgs.join(' ')}`);
    if (summary.env) parts.push(`env ${Object.entries(summary.env).map(([key, value]) => `${key}=${value}`).join(' ')}`);
    if (summary.sessionMode) parts.push(`session mode ${summary.sessionMode}`);
    return { status: 'pass', label: `${role} real workspace`, message: parts.join('; ') || summary.summary || 'configured' };
  });
}

function checkSparVersion(config) {
  return {
    status: 'pass',
    label: 'Spar version',
    message: config.version ? String(config.version) : 'available via spar --version',
  };
}

function statusMark(status) {
  if (status === 'pass') return 'PASS';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}
