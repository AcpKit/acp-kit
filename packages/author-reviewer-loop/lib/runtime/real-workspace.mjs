const codexRealWorkspaceArgs = Object.freeze([
  '-c', 'sandbox_mode="danger-full-access"',
  '-c', 'approval_policy="never"',
]);

const policies = Object.freeze({
  'codex-cli': Object.freeze({
    launchArgs: codexRealWorkspaceArgs,
  }),
  'claude-code': Object.freeze({
    env: Object.freeze({ IS_SANDBOX: '1' }),
    sessionMode: 'bypassPermissions',
  }),
});

export function withRealWorkspaceDefaults(agent) {
  const policy = realWorkspacePolicyForAgent(agent);
  if (!policy) return agent;

  return {
    ...agent,
    args: [...(agent.args ?? []), ...(policy.launchArgs ?? [])],
    env: policy.env ? { ...(agent.env ?? {}), ...policy.env } : agent.env,
    fallbackCommands: (agent.fallbackCommands ?? []).map((fallback) => ({
      ...fallback,
      args: [...fallback.args, ...(policy.launchArgs ?? [])],
    })),
  };
}

export async function enforceRealWorkspaceSession({ role, session, settings, emitRoleStatus }) {
  const modeId = realWorkspaceSessionModeForAgent(settings?.agent);
  if (!modeId) return;

  const modes = getAvailableModes(session);
  if (modes.length > 0 && !modes.some((mode) => mode.id === modeId)) {
    throw createConfigurationError(
      `${role} agent "${settings.agent.displayName}" cannot be forced into real-workspace mode "${modeId}". Available modes: ${modes.map((mode) => mode.id).join(', ') || '<none>'}.`,
    );
  }

  emitRoleStatus?.(`session ready, setting real-workspace mode ${modeId}...`);
  try {
    await session.setMode(modeId);
  } catch (error) {
    throw createConfigurationError(
      `${role} agent "${settings.agent.displayName}" rejected real-workspace mode "${modeId}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function summarizeRealWorkspacePolicy(agent) {
  const policy = realWorkspacePolicyForAgent(agent);
  if (!policy) return null;
  return {
    launchArgs: policy.launchArgs ? [...policy.launchArgs] : undefined,
    env: policy.env ? { ...policy.env } : undefined,
    sessionMode: policy.sessionMode ?? undefined,
  };
}

export function realWorkspacePolicyForAgent(agent) {
  return policies[agent?.id] ?? null;
}

export function realWorkspaceSessionModeForAgent(agent) {
  return realWorkspacePolicyForAgent(agent)?.sessionMode ?? null;
}

function getAvailableModes(session) {
  const available = session?.transcript?.session?.modes?.availableModes;
  if (!Array.isArray(available)) return [];
  return available
    .map((mode) => ({ id: typeof mode?.id === 'string' ? mode.id : '' }))
    .filter((mode) => mode.id);
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}
