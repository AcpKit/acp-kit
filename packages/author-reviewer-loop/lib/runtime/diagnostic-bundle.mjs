import { summarizeRealWorkspacePolicy } from './real-workspace.mjs';

export function createFailureDiagnosticBundle({ config = {}, runTrace, recoveryStore, state = {}, error, recoveryState } = {}) {
  return {
    cwd: config.cwd,
    taskSource: config.taskSource,
    maxRounds: config.maxRounds,
    quality: config.quality,
    renderer: config.tui ? 'tui' : 'plain',
    runTracePath: runTrace?.enabled ? runTrace.filePath : null,
    recoveryPath: recoveryStore?.enabled === false ? null : recoveryStore?.filePath ?? null,
    author: summarizeRole(config.authorSettings),
    reviewer: summarizeRole(config.reviewerSettings),
    lastWorkspaceChangeSummary: recoveryState?.loop?.workspaceChangeSummary || null,
    recentToolCalls: recentToolCalls(state),
    error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
  };
}

export function formatFailureDiagnosticBundle(bundle) {
  const lines = ['Spar failure diagnostics'];
  if (bundle.runTracePath) lines.push(`run trace: ${bundle.runTracePath}`);
  if (bundle.recoveryPath) lines.push(`recovery checkpoint: ${bundle.recoveryPath}`);
  if (bundle.lastWorkspaceChangeSummary) lines.push(`workspace changes: ${bundle.lastWorkspaceChangeSummary}`);
  lines.push(`author: ${formatRole(bundle.author)}`);
  lines.push(`reviewer: ${formatRole(bundle.reviewer)}`);
  if (bundle.recentToolCalls?.length) {
    lines.push(`recent tools: ${bundle.recentToolCalls.map((tool) => `${tool.role} R${tool.round} ${tool.title} ${tool.status}`).join('; ')}`);
  }
  return lines.join('\n');
}

function summarizeRole(settings = {}) {
  return {
    agent: settings.agent?.id ?? null,
    agentName: settings.agent?.displayName ?? null,
    model: settings.model ?? null,
    realWorkspace: summarizeRealWorkspacePolicy(settings.agent),
  };
}

function formatRole(role) {
  const base = `${role?.agentName || role?.agent || '(unset)'}${role?.model ? ` (${role.model})` : ''}`;
  const policy = role?.realWorkspace?.summary || role?.realWorkspace?.sessionMode || null;
  return policy ? `${base}; ${policy}` : base;
}

function recentToolCalls(state) {
  const rounds = state?.rounds instanceof Map ? Array.from(state.rounds.entries()) : [];
  const tools = [];
  for (const [round, byRole] of rounds) {
    for (const role of ['AUTHOR', 'REVIEWER']) {
      for (const tool of byRole?.[role]?.tools ?? []) {
        tools.push({ round, role, title: tool.title || tool.name || tool.id, status: tool.status || 'unknown' });
      }
    }
  }
  return tools.slice(-8);
}
