# Changelog

All notable changes to `@acp-kit/author-reviewer-loop` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows the repository's `0.x` Semantic Versioning policy: minor versions may include breaking changes, while patch versions remain backward compatible.

## [Unreleased]

## [0.6.16] - 2026-05-02

### Fixed

- Spar now closes ACP sessions gracefully before force-killing leftover terminal processes, reducing spurious tool-call interruption reports.
- Fixed TUI/plain renderer regressions around split streaming words, wrapped long lines showing truncation dots, and tool-call summaries missing output line counts.

## [0.6.15] - 2026-04-30

### Changed

- Spar user files now live under `~/.acp-kit/spar`, including preferences, startup profiling, and update-check cache data, so ACP Kit uses one top-level home directory.
- Startup profiling is enabled by default and writes to `~/.acp-kit/spar/startup-profile.log`; set `ACP_STARTUP_PROFILE=0` to disable it.
- The always-visible TUI footer now stays focused on primary controls while advanced controls remain available through help.

### Fixed

- Fixed TUI regressions around setup/confirmation animation, trace state leaking into confirmation, boxing-glove truncation dots, model-title closing parentheses, and approval force-continue handling.

## [0.6.14] - 2026-04-30

### Changed

- AUTHOR and REVIEWER sessions are now refreshed independently after `AUTHOR_SESSION_TURNS` / `REVIEWER_SESSION_TURNS` turns, defaulting to 20 turns per role instead of restarting the reviewer every round.
- Codex model presets now default to `gpt-5.5` and list `gpt-5.5`, `gpt-5.4/medium`, `gpt-5.4/high`, and `gpt-5.5/xhigh`.
- Spar now defaults to 20 review rounds instead of 10, keeps wrap enabled by default in TUI runs, and updates terminal-title, pane-title, and launch boxing-glove animations without full-screen redraw churn.

### Fixed

- Fixed relative task-file resolution, reviewer prompt scope, approval continuation UI behavior, startup status duplication, long plain-renderer line wrapping, thinking/text delta stitching, TUI model-title truncation, startup-profile TUI noise, and several launch/wait/run status regressions.

## [0.6.13] - 2026-04-30

### Added

- Startup profiling now reports role startup, fallback adapter preparation, and first-turn latency details for diagnosing slow ACP adapter launches.

### Changed

- The AUTHOR role now begins the first turn as soon as it is ready while the REVIEWER role keeps launching in the background, reducing startup wait time when the REVIEWER adapter is slower.

### Fixed

- TUI regressions around task wrapping, thinking text rendering, tool-call folding, token usage display, terminal title animation, approval exit behavior, and distinct launch/wait/run animation states were tightened.
- Startup failure handling still aggregates both role failures when both roles cannot launch, while allowing delayed REVIEWER startup failures to surface after the AUTHOR's first turn and cleaning up any opened roles.

## [0.6.12] - 2026-04-29

### Added

- The CLI has been **renamed on npm** from `@acp-kit/author-reviewer-loop` to **`@acp-kit/spar`**, with a single shorter `spar` bin. The old package name will be deprecated on npm; existing installs keep working but new installs should use `npm i -g @acp-kit/spar`.
- `spar` performs a best-effort startup update check against the npm registry. When a newer stable release is available it prompts `Update now via npm install -g @acp-kit/spar? [y/N]` and runs the global install if the user presses `y`. The check is silent on failure, skipped on non-TTY stdio and under CI, bypassable via `SPAR_NO_UPDATE_CHECK=1`, and cached locally for 6 hours.

## [0.6.11] - 2026-04-29

### Added

- Reframed as **Spar**: TUI header line is now a centered `Spar` wordmark flanked by two boxing-glove emojis that spar in toward the title and clash on the impact frame while agents are launching. All user-facing strings (finish view, launch confirmation, plain renderer divider, CLI confirm prompt) now say `Spar`. The npm package name is unchanged in this release.
- TUI now consumes the ACP `plan` and `reasoning` streams that core surfaces. A dedicated reasoning section (─ thinking · \<id\> ─ with ▎ prefixed lines) appears inside each pane, and the per-pane status line shows a plan summary `Plan c/t  ✓✓→·· · in progress: <step>` when the agent emits a plan.
- Tool flow now records ACP tool `locations` and structured `content` items per call, so future renderers can show file/line attributions and rich tool output.

### Changed

- Focused pane is drawn with a double-line border (`╔═╗║╚╝`) plus bold rails; inactive pane keeps the thin round border (`╭─╮│╰╯`). Pane top-border title is centered between the corners.
- Tool selection (`[` / `]`): when the selected tool lives inside a folded tool-run, that run is automatically expanded inline so the selection is visible. The selected tool row is marked with a `▶` arrow plus bold yellow text instead of an inverse block.
- Finish view no longer renders a progress bar or `Closing TUI...` pulse on approval; it shows a static APPROVED card and exits on the next tick.

## [0.6.10] - 2026-04-29

### Fixed

- TUI no longer crashes with `ReferenceError: animationFrame is not defined` on first render. The `animationLabel` helper had been hoisted out of the `App` component scope but still referenced the React `useState` value `animationFrame`; it now takes the frame as an explicit argument and the `Pane` component passes it in.
- Engine reducer now indexes the previous pane's tool calls by id with a `Map` instead of a linear `find` per tool, and preserves tool calls that were live in earlier snapshots but missing from the latest snapshot, so long-running tool entries no longer disappear from the TUI when the agent emits a snapshot that omits them. New `tool.input` / `tool.output` from the snapshot now win over the previously cached values instead of being dropped.
- Engine reducer now merges streaming reasoning deltas into the correct existing reasoning block by `sourceId` using `findLastIndex`, so reasoning chunks that arrive after intervening text or tool flow items are appended to the originating block instead of starting a new orphan block.
- TUI task header now measures the truncation hint with `displayWidth` and `fitText` so wide / CJK characters in the task title no longer push the `[v view full task, e edit]` hint past the terminal edge.
- TUI reasoning rows now use a plain-text `think:` prefix instead of an emoji, and the wrapping width is reduced by the prefix width so long reasoning lines wrap correctly inside the pane.
- TUI pane border (top label and bottom usage / timing label) now uses `displayWidth` for fill calculation so wide labels no longer leave gaps or overflow the border row.

## [0.6.9] - 2026-04-29

### Fixed

- TUI no longer crashes with `RangeError: Invalid array length` when a pane's flow ends on a tool item. `isBlankTextFlow(undefined)` previously returned `true`, causing the tool-run coalescing loop in `visibleFlowRows` to never terminate at end-of-flow and grow `skipped` until allocation failed. The helper now returns `false` for missing items so the loop stops at the array boundary.

## [0.6.8] - 2026-04-29

### Added

- TUI now ships an in-app agent and model picker for AUTHOR and REVIEWER, persisting the selection to `~/.acp-author-reviewer-loop.json` so later runs reuse the same choices unless overridden by `AUTHOR_AGENT` / `AUTHOR_MODEL` / `REVIEWER_AGENT` / `REVIEWER_MODEL` env vars. CLI mode still uses built-in defaults; TUI mode no longer hard-codes them.
- New exports from the agents config module: `agentChoices`, `modelChoices`, `defaultModelForAgent`, `modelChoicesForAgent`, and `applyRoleSelection`, shared by the TUI selection screen and tests.
- Engine now forwards `reasoningDelta` and `reasoningCompleted` events to the renderer, and threads `turnCompleted` / `turnFailed` / `turnEnd` through the trace pipeline so the TUI can display per-flow turn lifecycle markers.
- Engine state now tracks pane `startedAt` / `finishedAt` / `durationMs` and uses dedicated `launching` / `waiting` statuses for clearer TUI run state.
- New documentation page [docs/author-reviewer-loop](https://acpkit.github.io/acp-kit/author-reviewer-loop) describing the demo, why single-agent self-review fails, the renderers, and the diagnostics env vars. Package `homepage` now points at it.

### Changed

- Default CLI models updated to `gpt-5.4` for both AUTHOR and REVIEWER.
- Plain and TUI renderers now display token usage as `ctx X/Y Tk` (context window from `usage_update`) and `Σ in:N out:N` (cumulative session totals from `PromptResponse.usage`), joined with `·`, instead of the previous ambiguous `In/Out` / `Used` labels. A header comment in each renderer documents the two ACP sources.
- Reviewer prompt now asks for actionable suggestions with concrete fix guidance; author prompt reminds the AUTHOR to fix root causes and validate when practical.

### Fixed

- Agent availability pre-flight is now skipped when the relevant role has not been chosen yet (TUI selection mode) and runs at TUI launch time once the choice is made.
- Engine reducer tolerates partial pane snapshots and missing duration fields without throwing.

## [0.6.7] - 2026-04-28

### Fixed

- The REVIEWER prompt now receives the AUTHOR's reply for the current round as `authorReply`, and the default reviewer prompt explicitly instructs the REVIEWER to re-read every file the AUTHOR claims to have changed before judging. Previously the REVIEWER only saw the original task plus its own prior feedback and would frequently report "no changes" or treat each round as an unrelated codebase.
- Token usage is now sourced directly from the canonical normalized `session.usage.updated` event, rather than extracted from inspector wire frames. The TUI token header and the new plain renderer usage line work in the default run mode without needing trace capture.
- The TUI batches engine-driven re-renders to ~50 ms frames during streaming, eliminating the lower-half flicker that occurred when message deltas, snapshots, tool events, and trace entries arrived in fast bursts. `result` and `error` actions still flush immediately.
- The legacy `runAuthorReviewerLoop` adapter now also forwards `turnSnapshot`, `traceEntry`, and `usageUpdate` engine events to the renderer, matching what the engine publishes.
- The reducer's standalone `usageUpdate` action now updates both the cumulative role usage and the active round pane, so token counts shown by the TUI refresh as soon as a usage update arrives, not only on the next turn snapshot.

### Added

- The plain renderer prints a `[role usage] In/Out … Tk` (or `Used … Tk`) line whenever an agent reports new token usage, deduplicated against the previous line for the same role.
- New diagnostic env var `ACP_REVIEW_DEBUG_USAGE=1` writes each received `session.usage.updated` event to stderr for confirming whether the agent emits ACP usage data at all.

## [0.6.6] - 2026-04-28

### Fixed

- Reviewer prompts now include the current round and the previous reviewer feedback passed by the engine, so later review rounds have explicit context about what was already requested.
- Turn collection failures that happen before an ACP `turn.failed` / `turn.cancelled` event now emit a renderer `turnFailed` event before the error propagates, allowing both the TUI and plain renderer to show the failed turn.
- Explicit renderer flags now have predictable precedence: `--cli` selects the plain renderer even when the legacy `ACP_REVIEW_TUI=1` compatibility flag is present, while `--tui` can still override `ACP_REVIEW_CLI=1`.
- Unsupported `AUTHOR_AGENT` / `REVIEWER_AGENT` values are now reported through the normal CLI startup formatter instead of leaking an uncaught stack trace.

### Changed

- Added this package-local changelog and included it in the published package files so release history is visible from the package directory and npm tarball.

## [0.6.5] - 2026-04-28

### Added

- Task input can now be inline text or a relative/absolute UTF-8 task file; file input is read once at startup and the resolved source is shown in run summaries.
- The Ink TUI is now the default renderer. `--cli` / `ACP_REVIEW_CLI=1` select the plain renderer, while `--tui` / `ACP_REVIEW_TUI=1` remain accepted for compatibility.
- TUI users can edit the task in an external editor before launch or after reviewer approval, then continue the same AUTHOR/REVIEWER sessions with the updated task.
- TUI users can force another AUTHOR/REVIEWER round after reviewer approval without editing the task.
- TUI panes now show cumulative input/output token usage when agents report ACP usage data.
- TUI tool-call navigation now supports selecting concrete tool calls with `[` / `]` and opening a full input/output detail view with `Enter` / `d`.
- Focused Vitest coverage now covers CLI config parsing, engine approval continuation, runtime role cleanup, turn failure cleanup, and state reduction.

### Fixed

- Retained raw ACP trace entries are bounded by both entry count and serialized byte size so trace-heavy runs do not grow UI state without limit.
- State reduction tolerates partial turn snapshots and missing tool character counts without throwing or producing `NaN`.
- Created sessions, spawned terminals, and runtimes are cleaned up when model setup fails during role startup.

### Changed

- Pane, trace, usage, and result bookkeeping moved into a dedicated reducer module shared by renderers.
- README and docs now describe the default TUI, plain renderer opt-in, task-file input, task editing, tool detail view, token usage display, and editor timeout environment variable.

## [0.6.4] - 2026-04-27

### Added

- Startup now checks configured AUTHOR and REVIEWER agents before prompting or launching the loop, while preserving runtime fallback command behavior from `@acp-kit/core`.

### Changed

- Success output is more visually distinct in both plain and TUI renderers.

## [0.6.3] - 2026-04-27

### Added

- Hosted demo agents now receive local file-system and terminal capabilities rooted at the selected workspace after the initial user confirmation.
- Trace capture is available in both plain and TUI renderers.
- Renderers now show compact command/input and output previews for tool calls, collapse large continuous tool-call bursts, and expose a raw ACP trace view in the TUI.

### Changed

- TUI runs capture trace data even when `ACP_REVIEW_TRACE` is not printing JSONL to stderr, enabling the in-app trace view.
- README documentation now explains unattended workspace permissions, tool previews, collapsed tool bursts, and raw trace viewing.

## [0.6.2] - 2026-04-27

### Added

- Added a renderer-agnostic loop engine plus separate plain and Ink TUI renderers.
- Added `--tui` for a fullscreen split-pane AUTHOR/REVIEWER view with round navigation, pane scrolling, and soft wrapping.
- Added modular CLI helpers for argument/env parsing, confirmation prompts, run summaries, startup error formatting, shell-specific environment examples, runtime role startup, and per-turn event normalization.
- Added startup model validation that fails before the first turn when an agent reports available models and the configured model is invalid.
- Kept the legacy `runAuthorReviewerLoop({ config, renderer })` adapter for callers that used the earlier single-file demo shape.

### Changed

- CLI parsing now uses `commander`.
- CLI, config, runtime, engine, and renderer code are split into separate modules.
- The TUI header now combines author/reviewer agent, model, and status into one status row; long task text and pane output are wrapped for readability.
- Optional `ink` and `react` dependencies are declared for TUI mode while the plain renderer remains lazy-loaded and lightweight.

## [0.6.1] - 2026-04-27

### Added

- Initial publishable package for the split-context `npx` demo where an AUTHOR agent modifies files and a REVIEWER agent inspects them in a separate context until `APPROVED`.
- Shipped `acp-author-reviewer-loop` and `author-reviewer-loop` bin aliases.
- Added default Copilot AUTHOR / Codex REVIEWER profiles, model and round configuration through environment variables, confirmation prompts, and README usage docs.

### Changed

- Replaced the old repository `examples/pair-programming/` demo with this publishable CLI package.
