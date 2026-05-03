import type { AgentProfile } from './agents.js';
import type { RuntimeSession } from './session.js';

const codexRealWorkspaceArgs = Object.freeze([
  '-c', 'sandbox_mode="danger-full-access"',
  '-c', 'approval_policy="never"',
]);

export interface RealWorkspacePolicy {
  readonly id: string;
  readonly launchArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly sessionMode?: string;
  adaptLaunchProfile(agent: AgentProfile): AgentProfile;
  setupSession(params: RealWorkspaceSessionSetup): Promise<void>;
  diagnosticsSummary(): RealWorkspacePolicySummary;
}

export interface RealWorkspaceSessionSetup {
  role?: string;
  session: Pick<RuntimeSession, 'setMode'> & Pick<Partial<RuntimeSession>, 'transcript'>;
  settings?: { agent?: AgentProfile };
  agent?: AgentProfile;
  emitRoleStatus?: (message: string) => void;
}

export interface RealWorkspacePolicySummary {
  launchArgs?: string[];
  env?: Record<string, string>;
  sessionMode?: string;
  summary: string;
}

export const realWorkspacePolicyRegistry: Readonly<Record<string, RealWorkspacePolicy>> = Object.freeze({
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

export function withRealWorkspaceDefaults(agent: AgentProfile): AgentProfile {
  const policy = realWorkspacePolicyForAgent(agent);
  if (!policy) return agent;
  return policy.adaptLaunchProfile(agent);
}

export async function enforceRealWorkspaceSession(params: RealWorkspaceSessionSetup): Promise<void> {
  const agent = params.agent ?? params.settings?.agent;
  const policy = realWorkspacePolicyForAgent(agent);
  await policy?.setupSession?.(params);
}

export function summarizeRealWorkspacePolicy(agent: AgentProfile | undefined | null): RealWorkspacePolicySummary | null {
  const policy = realWorkspacePolicyForAgent(agent);
  if (!policy) return null;
  return policy.diagnosticsSummary();
}

export function realWorkspacePolicyForAgent(agent: AgentProfile | undefined | null): RealWorkspacePolicy | null {
  return realWorkspacePolicyRegistry[agent?.id ?? ''] ?? null;
}

export function realWorkspaceSessionModeForAgent(agent: AgentProfile | undefined | null): string | null {
  return realWorkspacePolicyForAgent(agent)?.sessionMode ?? null;
}

function createRealWorkspacePolicy({
  id,
  launchArgs,
  env,
  sessionMode,
  diagnostics,
}: {
  id: string;
  launchArgs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  sessionMode?: string;
  diagnostics: string;
}): RealWorkspacePolicy {
  return Object.freeze({
    id,
    adaptLaunchProfile(agent: AgentProfile): AgentProfile {
      return {
        ...agent,
        args: [...(agent.args ?? []), ...(launchArgs ?? [])],
        env: env ? { ...(agent.env ?? {}), ...env } : agent.env,
        fallbackCommands: (agent.fallbackCommands ?? []).map((fallback: { command: string; args: string[] }) => ({
          ...fallback,
          args: [...fallback.args, ...(launchArgs ?? [])],
        })),
      };
    },
    async setupSession({ role, session, settings, agent, emitRoleStatus }: RealWorkspaceSessionSetup): Promise<void> {
      if (!sessionMode) return;
      await setRequiredSessionMode({
        role,
        session,
        agent: agent ?? settings?.agent,
        modeId: sessionMode,
        emitRoleStatus,
      });
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

async function setRequiredSessionMode({
  role,
  session,
  agent,
  modeId,
  emitRoleStatus,
}: {
  role?: string;
  session: RealWorkspaceSessionSetup['session'];
  agent?: AgentProfile;
  modeId: string;
  emitRoleStatus?: (message: string) => void;
}): Promise<void> {
  const modes = getAvailableModes(session);
  const roleLabel = role ?? 'ACP';
  const agentName = agent?.displayName ?? agent?.id ?? 'agent';
  if (modes.length > 0 && !modes.some((mode) => mode.id === modeId)) {
    throw createConfigurationError(
      `${roleLabel} agent "${agentName}" cannot be forced into real-workspace mode "${modeId}". Available modes: ${modes.map((mode) => mode.id).join(', ') || '<none>'}.`,
    );
  }

  emitRoleStatus?.(`session ready, setting real-workspace mode ${modeId}...`);
  try {
    await session.setMode(modeId);
  } catch (error) {
    throw createConfigurationError(
      `${roleLabel} agent "${agentName}" rejected real-workspace mode "${modeId}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getAvailableModes(session: Pick<Partial<RuntimeSession>, 'transcript'>): Array<{ id: string }> {
  const available = session?.transcript?.session?.modes?.availableModes;
  if (!Array.isArray(available)) return [];
  return available
    .map((mode) => ({ id: typeof mode?.id === 'string' ? mode.id : '' }))
    .filter((mode) => mode.id);
}

function createConfigurationError(message: string): Error {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}
