---
title: Spar
description: Two ACP agents — an author and a reviewer — sparring over the same workspace until the work is approved.
---

# Spar

**Spar** is a CLI that runs two ACP agents over the same workspace and keeps
them sparring until one approves the other's work:

- **AUTHOR** modifies files for the requested task.
- **REVIEWER** inspects the working tree in a separate context and replies
  `APPROVED` or a numbered list of issues.

The two agents share the same workspace, but **not** the same conversation
history. Each role reuses its ACP session across turns until its configured session turn limit is reached. Spar also persists resumable loop state locally and attempts to resume matching ACP sessions after an interrupted run. Spar loops until the reviewer approves the result or `MAX_ROUNDS`
is reached. The deliverable is the working tree on disk, not pasted code.

Spar is built on top of [`@acp-kit/core`](./getting-started.md) and ships as
its own runnable npm package.

## Why this is useful

A single coding agent rarely catches its own mistakes. Once it has decided a
piece of code is correct, the same context that produced the bug is also the
context being asked to find the bug &mdash; the agent tends to re-justify
what it just wrote, miss obvious regressions, hallucinate that tests pass,
and overlook files it didn't touch in this turn.

Spar addresses that with **context isolation**: the REVIEWER runs in a
completely separate ACP session with no memory of how the AUTHOR reasoned.
It only sees the original task, the AUTHOR's summary of what they changed
this round, and the actual files on disk. That is enough to consistently
catch issues that the AUTHOR alone cannot, including:

- Logic errors and off-by-one mistakes the AUTHOR convinced itself were fine.
- Missing edge cases, error handling, and validation.
- Tests that were skipped, deleted, or never actually run.
- Files the AUTHOR forgot to update when refactoring an API.
- Drift between docs/changelog and the code that was actually shipped.

It is a practical pattern for any task where correctness matters more than
speed: bug-fix passes, refactors, security-sensitive changes, library
upgrades, and pre-merge audits of agent-generated code.

## Run with one command

```bash
npx @acp-kit/spar ./demo-workspace \
  "Create a Node.js CLI that counts word frequency from stdin"
```

PowerShell:

```powershell
npx @acp-kit/spar .\demo-workspace `
  "Create a Node.js CLI that counts word frequency from stdin"
```

Use an empty or disposable directory. The AUTHOR agent is allowed to create
and modify files under the target workspace.

The task argument may be inline text or a relative/absolute path to a UTF-8
text file. If it resolves to a file, the task is read once at startup and that
in-memory text is used for the rest of the run.

After the initial confirmation, the demo approves agent file-system and
terminal requests for the selected workspace so the loop can run unattended.
**Use a disposable workspace and only run agents you trust.**

When `codex` is selected, Spar launches `codex-acp` with
`sandbox_mode="danger-full-access"` and `approval_policy="never"` so Codex
writes to the real workspace that AUTHOR and REVIEWER share instead of a
temporary sandbox write layer.

When `claude` is selected, Spar starts Claude Code with `IS_SANDBOX=1` and
switches the session to `bypassPermissions` before the first turn. This keeps
Claude edits on the shared workspace disk as well.

Pass `--yes` or set `ACP_REVIEW_YES=1` to skip the confirmation prompt in
scripts.

Pass `--doctor` to run local diagnostics for the selected workspace and role
configuration without starting AUTHOR or REVIEWER agents:

```bash
npx @acp-kit/spar ./demo-workspace --doctor
```

## Requirements

- Node.js >= 20.11
- ACP-capable agent CLIs available on `PATH`
- Login/auth already completed for the selected agents

Plain CLI defaults:

| Role     | Agent          | Model     |
| -------- | -------------- | --------- |
| AUTHOR   | GitHub Copilot | `gpt-5.4` |
| REVIEWER | Codex          | `gpt-5.5` |

Supported built-in agent ids: `copilot`, `claude`, `codex`, `gemini`, `qwen`,
`opencode`.

Codex model presets are `gpt-5.5`, `gpt-5.4/medium`, `gpt-5.4/high`, and `gpt-5.5/xhigh`; `gpt-5.5` is the default Codex reviewer model.

Override per role with environment variables:

```bash
AUTHOR_AGENT='copilot' AUTHOR_MODEL='claude-opus-4.7' \
REVIEWER_AGENT='codex' REVIEWER_MODEL='gpt-5.5' \
  npx @acp-kit/spar ./demo-workspace "Build a small CLI"
```

Set `AUTHOR_MODEL=''` or `REVIEWER_MODEL=''` to use that agent's default
model. When an agent reports an available model list, the CLI validates the
configured model before Round 1 starts and prints the available list with a
shell-appropriate environment variable example if the configured model is not
available.

Runtime controls:

| Variable | Default | Effect |
| --- | --- | --- |
| `SPAR_QUALITY` | `prod` | Prompt quality mode. `prod` keeps the production-grade/adversarial prompt; `dev` uses a lighter development prompt. |
| `MAX_ROUNDS` | `20` | Maximum author/reviewer iterations. |
| `AUTHOR_SESSION_TURNS` | `20` | Maximum AUTHOR turns to run in one ACP session before opening a fresh AUTHOR session. |
| `REVIEWER_SESSION_TURNS` | `20` | Maximum REVIEWER turns to run in one ACP session before opening a fresh REVIEWER session. |
| `SPAR_SESSION_RECORD` | on (off under Vitest) | Persist one Spar session lifecycle record under `~/.acp-kit/spar/sessions`. A Spar session is one invocation for one cwd/task lifecycle. |
| `SPAR_RUN_RECOVERY` | on (off under Vitest) | Persist run recovery checkpoints under `~/.acp-kit/spar/run-recovery` and attempt interruption recovery on the next matching run. |
| `SPAR_RUN_TRACE` | on (off under Vitest) | Persist diagnostic run traces under `~/.acp-kit/spar/run-traces`. |
| `SPAR_WRAP_ENABLED` / `ACP_REVIEW_WRAP` | TUI on, CLI off | Explicitly enable or disable soft wrapping. |

## Renderers

The Ink-based fullscreen TUI is the default renderer. Pass `--cli` (or set
`ACP_REVIEW_CLI=1`) to use the plain line-based renderer instead. `--tui` and
`ACP_REVIEW_TUI=1` are still accepted for compatibility.

### TUI

- Uses the terminal's alternate screen buffer, so it always occupies the
  entire visible viewport and never grows past the bottom of the screen. Your
  scrollback is restored on exit.
- A split view shows AUTHOR on the left and REVIEWER on the right; each pane
  has a fixed height computed from the current terminal size and scrolls
  internally as new output arrives.
- The header shows `cwd`, the task, max rounds, and a combined
  AUTHOR/REVIEWER status row with agent and model names.
- Each pane header shows the agent's reported token usage. Two distinct
  numbers can appear:
  - `ctx 12K/200K Tk` &mdash; current **context-window** usage from ACP
    `usage_update` (tokens currently in context vs. context window size).
  - `Σ in:1.2K out:3.4K` &mdash; **cumulative session totals** from ACP
    `PromptResponse.usage` (sum of input/output tokens across all turns so
    far).

  When both are reported they are shown together:
  `ctx 12K/200K Tk · Σ in:1.2K out:3.4K`. The plain renderer prints the same
  string on a `[role usage] …` line.
- Tool-call rows include the command/input preview and output preview when
  available. Bursts of more than three continuous tool-call rows are
  collapsed into a compact success/failure summary so tool-heavy turns do not
  flood the pane.
- Press `[` / `]` to select a concrete tool call, then `Enter` or `d` to
  inspect its full input and output. `Esc` or `q` returns to the flow view.
- Engine-driven re-renders are batched during streaming to avoid lower-half flicker; terminal-title and pane-title animations are updated separately from full React renders.
- TUI mode captures ACP wire messages for the trace view automatically.
  `ACP_REVIEW_TRACE=1` is only needed when you also want startup-failure
  traces printed to stderr.

### Plain CLI

Subscribes to the same engine event stream as the TUI and prints them as a
scrolling line log. Tool-event bursts are collapsed after three lines.
Token-usage updates appear as `[role usage] …` lines, deduplicated against
the previous line for the same role.

## How the loop works

Each round consists of two turns:

1. **AUTHOR turn.** AUTHOR receives the task (round 1) or the previous
   reviewer feedback (round 2+) and uses its filesystem and terminal tools to
   modify the workspace.
2. **REVIEWER turn.** REVIEWER receives the original task, its own previous
   feedback, **and the AUTHOR's reply for this round** (the AUTHOR's summary
   of what they changed). The default reviewer prompt explicitly tells the
   REVIEWER to re-read every file the AUTHOR claims to have changed before
   judging, so the reviewer will not assume the codebase is unchanged just
   because earlier rounds looked different.

The loop stops when REVIEWER replies `APPROVED` on its own line, when
`MAX_ROUNDS` is reached, or when the user cancels. AUTHOR and REVIEWER sessions refresh independently after `AUTHOR_SESSION_TURNS` / `REVIEWER_SESSION_TURNS` turns. If the process is interrupted, Spar persists the pending author turn, reviewer turn, or approval decision and tries to resume matching ACP sessions on the next run; if a saved session is stale, Spar falls back to a fresh session instead of failing startup. Pressing `f` after
approval forces another round in the TUI.

After every AUTHOR turn, Spar summarizes observed disk changes and passes that
summary into the REVIEWER prompt. In git workspaces it uses `git status`,
`git diff --name-only`, index blob checks, and content signatures for dirty
files, so changes are still reported when the AUTHOR commits and leaves a clean
working tree or edits a file that was already dirty before the turn. Outside git
workspaces, Spar compares filesystem snapshots.

For stress runs, `--danger-ignore-approval` intentionally ignores REVIEWER
approval and runs all configured `MAX_ROUNDS` rounds. This flag is not saved to
preferences and cannot be enabled non-interactively; startup requires typing
both `RUN ALL ROUNDS` and `IGNORE APPROVAL`, even when `--yes` is present.

## Diagnostics

| Variable                  | Effect                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `ACP_REVIEW_TRACE=1`      | Print inspector trace on startup failures.                                                        |
| `ACP_REVIEW_DEBUG_USAGE=1` | Write each received `session.usage.updated` event to stderr, useful when debugging missing token counts. |

Failure output also includes the run trace path, recovery checkpoint path,
real-workspace policy summary, recent tool calls, and the latest workspace
change summary when those are available. Interrupted-run recovery asks before
resuming and defaults to starting fresh.

## Architecture

The package is split into a renderer-agnostic engine and a thin renderer
layer:

- `lib/engine.mjs` &mdash; `createLoopEngine({ config })` owns the
  AUTHOR/REVIEWER business loop, normalized event stream, and a reduced state
  tree (`engine.getState()` / `engine.subscribe(fn)` / `engine.onEvent(fn)`).
- `lib/renderers/plain.mjs` &mdash; line-based renderer.
- `lib/renderers/tui.mjs` &mdash; fullscreen Ink renderer.
- `lib/cli/` &mdash; argument parsing, env parsing, confirmation, run
  summaries, and error formatting.
- `lib/runtime/` &mdash; ACP role/session startup and per-turn event
  normalization.
- `lib/config/` &mdash; built-in agent/default settings.

To add a new renderer (HTML report, JSONL log, web dashboard), subscribe to
`engine.onEvent` and/or read `engine.getState()`. No engine changes are
needed.

For full CLI flag, environment variable, and keybinding reference, see the
[Spar package README on GitHub](https://github.com/AcpKit/acp-kit/tree/main/packages/author-reviewer-loop#readme).

::: tip Note
Spar publishes as both **`@acp-kit/spar`** (the new name; install command is `spar`) and **`@acp-kit/author-reviewer-loop`** (deprecated alias kept for backwards compatibility). Prefer the new name in fresh installs.
:::
