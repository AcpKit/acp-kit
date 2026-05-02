const codexRealWorkspaceArgs = Object.freeze([
  '-c', 'sandbox_mode="danger-full-access"',
  '-c', 'approval_policy="never"',
]);

export const realWorkspacePolicyRegistry = Object.freeze({
  'codex-cli': createRealWorkspacePolicy({
    id: 'codex-cli',
    launchArgs: codexRealWorkspaceArgs,
    diagnostics: 'Codex runs with sandbox_mode="danger-full-access" and approval_policy="never".',
  }),
  'claude-code': createRealWorkspacePolicy({
    id: 'claude-code',
    env: Object.freeze({ IS_SANDBOX: '1' }),
    sessionMode: 'bypassPermissions',
    diagnostics: 'Claude Code runs with IS_SANDBOX=1 and session mode bypassPermissions.',
  }),
});

function createRealWorkspacePolicy({ id, launchArgs, env, sessionMode, diagnostics }) {
  return Object.freeze({
    id,
    adaptLaunchProfile(agent) {
      return {
        ...agent,
        args: [...(agent.args ?? []), ...(launchArgs ?? [])],
        env: env ? { ...(agent.env ?? {}), ...env } : agent.env,
        fallbackCommands: (agent.fallbackCommands ?? []).map((fallback) => ({
          ...fallback,
          args: [...fallback.args, ...(launchArgs ?? [])],
        })),
      };
    },
    async setupSession({ role, session, settings, emitRoleStatus }) {
      if (!sessionMode) return;
      await setRequiredSessionMode({ role, session, settings, modeId: sessionMode, emitRoleStatus });
    },
    diagnosticsSummary() {
      return {
        launchArgs: launchArgs ? [...launchArgs] : undefined,
        env: env ? { ...env } : undefined,
        sessionMode: sessionMode ?? undefined,
        summary: diagnostics,
      };
    },
    launchArgs,
    env,
    sessionMode,
  });
}

export function withRealWorkspaceDefaults(agent) {
  const policy = realWorkspacePolicyForAgent(agent);
  if (!policy) return agent;
  return policy.adaptLaunchProfile(agent);
}

export async function enforceRealWorkspaceSession({ role, session, settings, emitRoleStatus }) {
  const policy = realWorkspacePolicyForAgent(settings?.agent);
  await policy?.setupSession?.({ role, session, settings, emitRoleStatus });
}

async function setRequiredSessionMode({ role, session, settings, modeId, emitRoleStatus }) {
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
  return policy.diagnosticsSummary();
}

export function realWorkspacePolicyForAgent(agent) {
  return realWorkspacePolicyRegistry[agent?.id] ?? null;
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
