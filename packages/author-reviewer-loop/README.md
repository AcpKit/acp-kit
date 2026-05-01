# Spar

**Spar** is a CLI that runs two ACP agents — an author and a reviewer —
over the same workspace, and keeps them sparring until the work is
approved. Built on [`@acp-kit/core`](https://www.npmjs.com/package/@acp-kit/core).

Published on npm as **`@acp-kit/spar`**. The previous name
`@acp-kit/author-reviewer-loop` is deprecated; please prefer the new name.

A split-context ACP Kit demo that hosts two ACP agents over the same workspace:

- **AUTHOR** modifies files for the requested task.
- **REVIEWER** inspects the working tree in a separate context and replies `APPROVED` or a numbered list of issues.

The two agents share the same workspace, but not the same conversation history. Each role reuses its ACP session across turns until its configured session turn limit is reached. Spar also persists resumable loop state locally and attempts to resume matching ACP sessions after an interrupted run when the agent still exposes them. The CLI loops until the reviewer approves the result or `MAX_ROUNDS` is reached. The deliverable is the working tree on disk, not pasted code.

## Run With One Command

```bash
npx @acp-kit/spar ./demo-workspace "Create a Node.js CLI that counts word frequency from stdin"
```

PowerShell:

```powershell
npx @acp-kit/spar .\demo-workspace "Create a Node.js CLI that counts word frequency from stdin"
```

Use an empty or disposable directory. The AUTHOR agent is allowed to create and modify files under the target workspace.

The task argument may be inline text or a relative/absolute path to a UTF-8 text file. If it resolves to a file, the task is read once at startup and that in-memory text is used for the rest of the run.

After the initial confirmation, the demo approves agent file-system and terminal requests for the selected workspace so the loop can run unattended. Use a disposable workspace and only run agents you trust.

When `codex` is selected, Spar launches `codex-acp` with `sandbox_mode="danger-full-access"` and `approval_policy="never"` so Codex writes to the real workspace that AUTHOR and REVIEWER share instead of a temporary sandbox write layer.

Before launching agents, the CLI shows the full run configuration and asks for confirmation. Pass `--yes` or set `ACP_REVIEW_YES=1` to skip the prompt in scripts.

## Requirements

- Node.js >= 20.11
- ACP-capable agent CLIs available on `PATH`
- Login/auth already completed for the selected agents

Plain CLI defaults:

| Role | Agent | Model |
| --- | --- | --- |
| AUTHOR | GitHub Copilot | `gpt-5.4` |
| REVIEWER | Codex | `gpt-5.5` |

TUI mode opens a startup screen before the first run unless `--yes` / `ACP_REVIEW_YES=1` is set. The screen combines confirmation and setup: use `Tab` to switch AUTHOR/REVIEWER, `↑` / `↓` to pick an agent, `Space` to assign it to the active role, `m` to change that role's model, `e` to edit the task, `s` to toggle saving defaults, and `Enter` to start.

Agent status is intentionally user-facing:

| Status | Meaning |
| --- | --- |
| `Ready` | The agent can start immediately from a local command. |
| `Will prepare` | The agent can be prepared automatically on first launch; network access may be needed. |
| `Unavailable` | The agent cannot be launched in this environment. |

Implementation details such as the exact helper package or fallback command are kept internal; the TUI only shows whether the agent is ready, can be prepared automatically, or is unavailable.

TUI model choices are predefined per agent:

| Agent id | Model choices |
| --- | --- |
| `codex` | `gpt-5.5`, `gpt-5.4/medium`, `gpt-5.4/high`, `gpt-5.5/xhigh` |
| `claude` | `opus`, `default (agent default)` |
| `copilot` | `gpt-5.4`, `gpt-5.5`, `claude-sonnet-4.6`, `claude-opus-4.7`, `claude-opus-4.7-1m` |
| `gemini`, `qwen`, `opencode` | `default (agent default)` |

The first listed model is the TUI default for that agent. If a model from the environment or saved config is not in the predefined list, the TUI keeps it as a selected custom option instead of discarding it.

Override with environment variables:

```bash
AUTHOR_AGENT='copilot' AUTHOR_MODEL='claude-opus-4.7' REVIEWER_AGENT='codex' REVIEWER_MODEL='gpt-5.5' \
  npx @acp-kit/spar ./demo-workspace "Build a small CLI"
```

PowerShell:

```powershell
$Env:AUTHOR_AGENT='copilot'
$Env:AUTHOR_MODEL='claude-opus-4.7'
$Env:REVIEWER_AGENT='codex'
$Env:REVIEWER_MODEL='gpt-5.5'
npx @acp-kit/spar .\demo-workspace "Build a small CLI"
```

Set `AUTHOR_MODEL=''` or `REVIEWER_MODEL=''` to use that agent's default model. When an agent reports its available models, the CLI validates the configured model before Round 1 starts. If the configured model is not available, startup fails with the agent's model list and an environment variable example formatted for the current shell (`$Env:NAME='value'` in PowerShell, `export NAME='value'` in Unix-like shells).

After a TUI setup selection, the startup screen can save the selection to `~/.acp-author-reviewer-loop.json`. Startup precedence is:

1. Environment variables (`AUTHOR_AGENT`, `AUTHOR_MODEL`, `REVIEWER_AGENT`, `REVIEWER_MODEL`)
2. `~/.acp-author-reviewer-loop.json`
3. Built-in defaults (plain `--cli` mode only for agent/model)

Supported built-in agent ids: `copilot`, `claude`, `codex`, `gemini`, `qwen`, `opencode`.

## Options

```bash
npx @acp-kit/spar <cwd> <task-or-task-file> [--yes] [--cli] [--quality prod|dev]
```

The Ink-based fullscreen TUI is the default renderer. Pass `--cli` (or set `ACP_REVIEW_CLI=1`) to use the plain line-based renderer instead. `--tui` and `ACP_REVIEW_TUI=1` are still accepted for compatibility.

- The TUI uses the terminal's alternate screen buffer, so it always occupies the entire visible viewport and never grows past the bottom of the screen. Your scrollback is restored on exit.
- A split view shows AUTHOR on the left and REVIEWER on the right; each pane has a fixed height computed from the current terminal size and scrolls internally as new output arrives.
- The header shows `cwd`, the task, max rounds, and a combined AUTHOR/REVIEWER status row with agent and model names.
- Each AUTHOR/REVIEWER pane header shows the agent's reported token usage. Two distinct numbers can appear:
  - `ctx 12K/200K Tk` &mdash; current **context-window** usage from ACP `usage_update` (tokens currently in context vs. context window size).
  - `Σ in:1.2K out:3.4K` &mdash; **cumulative session totals** from ACP `PromptResponse.usage` (sum of input/output tokens across all turns so far).

  When both are reported they are shown together: `ctx 12K/200K Tk · Σ in:1.2K out:3.4K`. The plain renderer prints the same string on a `[role usage] …` line.
- Pane output soft-wraps by default and is pre-wrapped to whole words before rendering.
- Tool-call rows include the command/input preview and output preview when available. Bursts of more than three continuous tool-call rows are collapsed into a compact success/failure summary so tool-heavy turns do not flood the pane.
- Press `[` / `]` to select a concrete tool call in the focused pane, then `Enter` or `d` to inspect its full input and output. `Esc` or `q` returns to the flow view.
- The raw ACP trace view pretty-prints each wire frame as readable multi-line JSON instead of a single long line.
- TUI mode captures ACP wire messages for the trace view automatically; `ACP_REVIEW_TRACE=1` is only needed when you also want startup-failure traces printed to stderr.
- Resizing the terminal re-flows the layout immediately.

Keybindings:

| Key | Action |
| --- | --- |
| `←` / `→` | Move between rounds |
| `↑` / `↓` (or `j`/`k`) | Scroll the focused pane by one line |
| `PgUp` / `PgDn` | Scroll the focused pane by ten lines |
| `Tab` | Switch focus between AUTHOR and REVIEWER |
| `g` | Jump to the latest round and re-enable follow-mode |
| `G` | Reset scroll to the bottom of the focused pane |
| `[` / `]` | Select previous/next tool call in the focused pane |
| `Enter` / `d` | Open the selected tool call detail view |
| `Esc` / `q` | Return from the tool call detail view |
| `t` | Toggle the raw ACP trace view |
| `w` | Toggle soft-wrap for long lines |
| `?` | Toggle the help overlay |
| `f` | Force another AUTHOR/REVIEWER round after reviewer approval |
| `q` | Quit (only after the run has completed) |

The plain console renderer also includes tool command/output previews and collapses continuous tool-event bursts after three lines.

## Prompt Contract

- The AUTHOR prompt is intentionally opinionated: it asks the coding agent to turn vague quality bars into concrete work on disk, use adversarial thinking before implementation, prefer meaningful unit/integration/scenario/E2E coverage over vanity tests, and fix real bugs at the root cause when testing exposes them.
- Pass `--quality dev` or set `SPAR_QUALITY=dev` for a lighter development prompt that keeps the AUTHOR/REVIEWER loop but asks for the normal code-agent workflow: inspect, implement, validate when practical, and summarize.
- The REVIEWER prompt evaluates the whole workspace against that same bar instead of rubber-stamping local diffs or happy-path checks.
- The failure-oriented checklist that informed these prompts lives in [`docs/adversarial-scenarios.md`](../../docs/adversarial-scenarios.md).

## Architecture

The package is split into a renderer-agnostic engine and a thin renderer layer:

- `lib/engine.mjs` exposes `createLoopEngine({ config })`, which owns the AUTHOR/REVIEWER business loop, normalized event stream, and a reduced state tree (`engine.getState()` / `engine.subscribe(fn)` / `engine.onEvent(fn)`). It contains no presentation logic.
- `lib/renderers/plain.mjs` subscribes to engine events and prints them as a scrolling line log.
- `lib/renderers/tui.mjs` subscribes to engine events and state and draws a fullscreen Ink view.
- `lib/cli/` contains argument parsing, env parsing, confirmation, run summaries, and error formatting.
- `lib/runtime/` contains ACP role/session startup and per-turn event normalization.
- `lib/config/` contains built-in agent/default settings.
- `lib/config/shell.mjs` formats shell-appropriate environment variable examples for startup errors.
- `lib/runtime/loop.mjs` keeps the legacy `runAuthorReviewerLoop({ config, renderer })` signature working for callers that pass a renderer object with `onTurnStart`, `onMessageDelta`, etc.

To add a new renderer (HTML report, JSONL log, web dashboard), subscribe to `engine.onEvent` and/or read `engine.getState()`. No engine changes are needed.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTHOR_AGENT` | TUI: saved/choose; CLI: `copilot` | Agent that writes/modifies files. |
| `AUTHOR_MODEL` | TUI: saved/choose; CLI: `gpt-5.4` | Model id passed via ACP `session/set_model`; set empty to skip. |
| `REVIEWER_AGENT` | TUI: saved/choose; CLI: `codex` | Agent that reviews the working tree. |
| `REVIEWER_MODEL` | TUI: saved/choose; CLI: `gpt-5.5` | Model id passed via ACP `session/set_model`; set empty to skip. |
| `SPAR_QUALITY` | `prod` | Prompt quality mode. `prod` keeps the production-grade/adversarial prompt; `dev` uses a lighter development prompt. |
| `MAX_ROUNDS` | `20` | Maximum author/reviewer iterations. |
| `AUTHOR_SESSION_TURNS` | `20` | Maximum AUTHOR turns to run in one ACP session before opening a fresh AUTHOR session. |
| `REVIEWER_SESSION_TURNS` | `20` | Maximum REVIEWER turns to run in one ACP session before opening a fresh REVIEWER session. |
| `SPAR_SESSION_RECORD` | on (off under Vitest) | Persist one Spar session lifecycle record under `~/.acp-kit/spar/sessions`. A Spar session is one invocation for one cwd/task lifecycle. |
| `SPAR_RUN_RECOVERY` | on (off under Vitest) | Persist run recovery checkpoints under `~/.acp-kit/spar/run-recovery` and attempt interruption recovery on the next matching run. |
| `SPAR_RUN_TRACE` | on (off under Vitest) | Persist diagnostic run traces under `~/.acp-kit/spar/run-traces`. |
| `ACP_REVIEW_YES` | unset | Set to `1` to skip the confirmation prompt. |
| `ACP_REVIEW_CLI` | unset | Set to `1` to use the plain line-based renderer (same as `--cli`). |
| `ACP_REVIEW_TUI` | unset | Compatibility flag for the default Ink TUI renderer (same as `--tui`). |
| `ACP_REVIEW_TRACE` | unset | Set to `1` to print the runtime inspector JSONL trace on startup failures. |
| `ACP_REVIEW_EDITOR_TIMEOUT_MS` | `1800000` | Maximum time the TUI waits for the external task editor before restoring the screen and reporting an error. |

## What It Shows

- Two `createAcpRuntime(...)` instances, one per agent process.
- Two sessions pointed at the same `cwd`, with separate author/reviewer contexts.
- Independent per-role session refresh limits via `AUTHOR_SESSION_TURNS` and `REVIEWER_SESSION_TURNS` (default `20` each).
- Spar session records for each invocation lifecycle, stored separately from run recovery checkpoints.
- Local run recovery that checkpoints the next pending author/reviewer/approval step and resumes matching ACP role sessions through ACP `session/load` when the agent still has them.
- Per-session model selection via ACP `session/set_model`.
- Startup model validation against each agent's advertised model list when available.
- Handler-map dispatch over normalized `RuntimeSessionEvent`s.
- `collectTurnResult(...)` from `@acp-kit/core`, used to collect a single streamed turn into text/tool/status snapshots for renderers.
- Startup diagnostics through `isAcpStartupError(...)` and `formatStartupDiagnostics(...)`.
- Runtime inspectors for supportable debugging without adding ad hoc logs.

## Exit Codes

- `0`: reviewer approved the result.
- `1`: maximum rounds reached without approval, startup failed, or a turn failed.
