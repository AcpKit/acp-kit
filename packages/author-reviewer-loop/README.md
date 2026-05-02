# Spar

**Spar** runs two ACP agents over one workspace: an **AUTHOR** changes files and a separate-context **REVIEWER** inspects the result until it replies `APPROVED` or the round limit is reached. It is built on [`@acp-kit/core`](https://www.npmjs.com/package/@acp-kit/core).

Published on npm as **`@acp-kit/spar`**. The previous package name, `@acp-kit/author-reviewer-loop`, is deprecated.

Use Spar when a coding task benefits from independent review: bug fixes, refactors, release prep, docs/code consistency checks, and other work where “the agent says it is done” is not enough. The deliverable is the working tree on disk, not pasted code.

## Quick Start

```bash
npx @acp-kit/spar ./demo-workspace "Create a Node.js CLI that counts word frequency from stdin"
```

PowerShell:

```powershell
npx @acp-kit/spar .\demo-workspace "Create a Node.js CLI that counts word frequency from stdin"
```

Use an empty or disposable directory. After confirmation, Spar allows the selected agents to use filesystem and terminal tools in that workspace.

The task can be inline text or a relative/absolute UTF-8 text file. If the argument resolves to a file, Spar reads it once at startup.

## Requirements

- Node.js >= 20.11
- ACP-capable agent CLIs available on `PATH`
- Login/auth already completed for selected agents

Plain CLI defaults:

| Role | Agent | Model |
| --- | --- | --- |
| AUTHOR | GitHub Copilot | `gpt-5.4` |
| REVIEWER | Codex | `gpt-5.5` |

Supported agent ids: `copilot`, `claude`, `codex`, `gemini`, `qwen`, `opencode`.

Override roles with environment variables:

```bash
AUTHOR_AGENT='copilot' AUTHOR_MODEL='claude-opus-4.7' \
REVIEWER_AGENT='codex' REVIEWER_MODEL='gpt-5.5' \
  npx @acp-kit/spar ./demo-workspace "Build a small CLI"
```

Set `AUTHOR_MODEL=''` or `REVIEWER_MODEL=''` to use the agent default model.

## Common Commands

Run local preflight diagnostics without starting agents:

```bash
npx @acp-kit/spar ./demo-workspace --doctor
```

Use the line-based renderer instead of the default fullscreen TUI:

```bash
npx @acp-kit/spar ./demo-workspace "Fix the flaky parser test" --cli
```

Use the lighter development prompt:

```bash
npx @acp-kit/spar ./demo-workspace "Add CSV export" --quality dev
```

Skip the ordinary start prompt in scripts:

```bash
npx @acp-kit/spar ./demo-workspace "Update docs" --yes
```

Danger mode: ignore reviewer approval and run every configured `MAX_ROUNDS` round. This is invocation-only state, is not saved to preferences, and requires interactive double confirmation even with `--yes`.

```bash
MAX_ROUNDS=5 npx @acp-kit/spar ./demo-workspace "Stress-test the implementation" --danger-ignore-approval
```

## Important Behavior

- AUTHOR and REVIEWER share the same real workspace but not the same conversation history.
- Codex runs with `sandbox_mode="danger-full-access"` and `approval_policy="never"` so edits land in the shared workspace. Claude Code is switched to `bypassPermissions` before the first turn for the same reason.
- After each AUTHOR turn, Spar checks whether files changed on disk. Git workspaces use git status/diff, index blob checks, and dirty-file content checks; non-git workspaces use a filesystem snapshot.
- Interrupted runs can be resumed when matching ACP sessions are still available. Recovery asks before resuming; the default is to start fresh.
- Failure diagnostics include run trace path, recovery checkpoint path, real-workspace policy, recent tool calls, and the latest workspace-change summary.

## Options

```bash
npx @acp-kit/spar <cwd> <task-or-task-file> [--yes] [--cli] [--tui] [--quality prod|dev] [--doctor] [--danger-ignore-approval]
```

Key environment variables:

| Variable | Meaning |
| --- | --- |
| `AUTHOR_AGENT`, `AUTHOR_MODEL` | AUTHOR agent and model override. |
| `REVIEWER_AGENT`, `REVIEWER_MODEL` | REVIEWER agent and model override. |
| `MAX_ROUNDS` | Maximum author/reviewer iterations. Default: `20`. |
| `AUTHOR_SESSION_TURNS`, `REVIEWER_SESSION_TURNS` | Per-role ACP session refresh limits. Default: `20`. |
| `SPAR_QUALITY` | `prod` or `dev`. |
| `ACP_REVIEW_YES=1` | Skip the ordinary start prompt. |
| `ACP_REVIEW_CLI=1` | Use the line-based renderer. |
| `SPAR_RUN_RECOVERY`, `SPAR_RUN_TRACE`, `SPAR_SESSION_RECORD` | Enable/disable local recovery, trace, and session records. |

TUI startup can save role/model defaults to `~/.acp-kit/spar/preferences.json`. Environment variables take precedence over saved preferences.

## More Documentation

- Full site docs: <https://acpkit.github.io/acp-kit/spar>
- TUI design notes: <https://github.com/AcpKit/acp-kit/blob/main/packages/author-reviewer-loop/docs/tui-design-spec.md>
- Prompt/testing rationale: <https://github.com/AcpKit/acp-kit/blob/main/packages/author-reviewer-loop/docs/adversarial-scenarios.md>
- Package changelog: [`CHANGELOG.md`](CHANGELOG.md)

## Exit Codes

- `0`: reviewer approved the result.
- `1`: maximum rounds reached without approval, startup failed, or a turn failed.
