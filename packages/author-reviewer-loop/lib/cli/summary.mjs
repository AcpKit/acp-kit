export function formatRunSummary({ cwd, task, taskSource, authorSettings, reviewerSettings, maxRounds, trace, tui, realWorkspace = true }) {
  return `Run configuration
  cwd:            ${cwd}
  task source:    ${taskSource?.kind === 'file' ? taskSource.path : '(inline text)'}
  task:           ${task}
  author:         ${formatAgent(authorSettings)}
  author model:   ${authorSettings.model || '(agent default)'}
  author session: ${authorSettings.sessionTurns} turn(s)
  reviewer:       ${formatAgent(reviewerSettings)}
  reviewer model: ${reviewerSettings.model || '(agent default)'}
  reviewer session: ${reviewerSettings.sessionTurns} turn(s)
  max rounds:     ${maxRounds}
  real workspace: ${realWorkspace ? 'enabled' : 'disabled'}
  trace:          ${trace ? 'enabled' : 'disabled'}
  renderer:       ${tui ? 'tui (ink)' : 'plain'}
`;
}

function formatAgent(settings) {
  if (!settings.agent) return '(choose in TUI)';
  return `${settings.agent.displayName} (${settings.agent.id})`;
}

export function printRunSummary(config) {
  console.log(formatRunSummary(config));
}
