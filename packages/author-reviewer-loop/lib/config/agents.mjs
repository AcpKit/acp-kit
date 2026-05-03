import {
  ClaudeCode,
  CodexCli,
  GeminiCli,
  GitHubCopilot,
  OpenCode,
  QwenCode,
  withRealWorkspaceDefaults,
} from '@acp-kit/core';

export const baseAgents = Object.freeze({
  claude: ClaudeCode,
  codex: CodexCli,
  copilot: GitHubCopilot,
  gemini: GeminiCli,
  opencode: OpenCode,
  qwen: QwenCode,
});

export const SparClaudeCode = withRealWorkspaceDefaults(ClaudeCode);
export const SparCodexCli = withRealWorkspaceDefaults(CodexCli);

export const agents = Object.freeze({
  ...baseAgents,
  claude: SparClaudeCode,
  codex: SparCodexCli,
});

export function agentsForRealWorkspace(realWorkspace = true) {
  return realWorkspace ? agents : baseAgents;
}

export const agentChoices = Object.freeze(Object.entries(agents).map(([id, agent]) => ({
  id,
  agent,
})));

export const modelChoices = Object.freeze({
  claude: [
    { id: 'opus', label: 'opus', value: 'opus' },
    { id: 'default', label: 'default (agent default)', value: null },
  ],
  codex: [
    { id: 'gpt-5.5', label: 'gpt-5.5', value: 'gpt-5.5' },
    { id: 'gpt-5.4/medium', label: 'gpt-5.4/medium', value: 'gpt-5.4/medium' },
    { id: 'gpt-5.4/high', label: 'gpt-5.4/high', value: 'gpt-5.4/high' },
    { id: 'gpt-5.5/xhigh', label: 'gpt-5.5/xhigh', value: 'gpt-5.5/xhigh' },
  ],
  copilot: [
    { id: 'gpt-5.4', label: 'gpt-5.4', value: 'gpt-5.4' },
    { id: 'gpt-5.5', label: 'gpt-5.5', value: 'gpt-5.5' },
    { id: 'claude-sonnet-4.6', label: 'claude-sonnet-4.6', value: 'claude-sonnet-4.6' },
    { id: 'claude-opus-4.7', label: 'claude-opus-4.7', value: 'claude-opus-4.7' },
    { id: 'claude-opus-4.7-1m', label: 'claude-opus-4.7-1m', value: 'claude-opus-4.7-1m' },
  ],
  gemini: [
    { id: 'default', label: 'default (agent default)', value: null },
  ],
  opencode: [
    { id: 'default', label: 'default (agent default)', value: null },
  ],
  qwen: [
    { id: 'default', label: 'default (agent default)', value: null },
  ],
});

export const defaults = {
  authorAgent: 'copilot',
  authorModel: 'gpt-5.4',
  reviewerAgent: 'codex',
  reviewerModel: 'gpt-5.5',
  maxRounds: 20,
  sessionTurns: 20,
};

export function defaultModelForAgent(agentId) {
  return modelChoices[agentId]?.[0]?.value ?? null;
}

export function modelChoicesForAgent(agentId, currentModel) {
  const choices = [...(modelChoices[agentId] ?? [{ id: 'default', label: 'default (agent default)', value: null }])];
  const hasCurrent = choices.some((choice) => choice.value === currentModel);
  if (!hasCurrent && currentModel != null && String(currentModel).length > 0) {
    choices.unshift({
      id: `custom:${currentModel}`,
      label: `${currentModel} (custom)`,
      value: currentModel,
      custom: true,
    });
  }
  return choices;
}
