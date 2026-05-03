# Adversarial Scenario Analysis

## Author-Reviewer Loop Verdict Hardening

This pass focused on user-visible loop termination and recovery behavior in `@acp-kit/spar`.

### Failure Cases Covered

- **Malformed reviewer approval:** Reviewer text that mentions `APPROVED` outside the first non-empty line must not end the loop.
- **Terminal-control reviewer approval:** Reviewer text wrapped in cursor-control or OSC terminal bytes must be sanitized before approval parsing.
- **Contradictory approval:** `APPROVED` followed by failure, missing-work, timeout, crash, dependency, or restart-recovery issues must be treated as feedback.
- **High-latency logic hangs:** `APPROVED` followed by current high-latency hang or loop failure prose, even without a helper verb such as "causes", must reopen the author round instead of handing off a stuck experience.
- **Clean approval notes:** `APPROVED` followed by realistic summaries such as `No remaining issues`, `Problems: none`, or `Issues: none. Everything looks solid.` must not cause unnecessary extra rounds.
- **Case-varied approval tokens:** Mixed-case `approved` tokens from unpredictable LLM output are accepted only when the verdict is otherwise clean; contradictory follow-up text still rejects the reply.
- **Masked contradictions:** Clean-looking notes with `but/however` plus failure language must still be rejected.
- **Terminal-formatted verdicts:** ANSI color escapes, cursor-control sequences, OSC titles with BEL or ST terminators, and zero-width characters around verdicts must be stripped before interpretation.
- **Historical failures:** Reviewer notes that explicitly say a previous failure is now fixed and verified must not be treated as current rejection feedback.
- **Empty reviewer output:** Blank reviewer replies must become explicit recovery feedback instead of accidental approval.
- **Contradictory reviewer guidance:** Later feedback must be fed into the next author round without losing prior loop state.
- **Startup and dependency failures:** Role startup failures and model/dependency conflicts must surface while closing any role that started.
- **Slow startup cleanup:** A reviewer that settles after the author turn, or after started roles have already been collected during failure cleanup, must still be closed without leaving a permanent role-settled listener behind.
- **Disk exhaustion:** Workspace creation failure such as ENOSPC must stop before launching agents and record an engine error.
- **Invalid round budgets:** Programmatic engine callers that pass maxRounds=0, negative values, fractions, NaN, Infinity, or invalid continuation budgets must not silently skip the loop or produce misleading reopened-round counts.
- **Interrupted cleanup:** Run failure plus cleanup failure must preserve both errors for diagnosis.
- **Interrupted reviewer resume:** If the process stops after the author turn but before or during reviewer execution, the next matching run must resume at reviewer verification without silently rerunning the author turn.
- **Interrupted approval resume:** If the process stops while approval is pending, the next matching run must resume from the approval decision instead of rerunning agent turns or emitting duplicate final results.
- **Engine/store roundtrip gap:** Recovery written by the real engine must deserialize through the real store and resume from the persisted pending action shape without mocked shortcuts.
- **Stale saved sessions:** If a persisted ACP session id no longer exists, startup must fall back to a fresh session instead of failing the whole run.
- **Transient session-resume failures:** If ACP `loadSession` fails for reasons other than a missing saved session, Spar must surface the real startup error instead of silently discarding recovery and starting fresh.
- **Wrapped stale-session errors:** If ACP wraps an "unknown session" or not-found failure inside nested `cause`/`reason`/`detail` objects, Spar must still recognize it as stale recovery and reopen a fresh session.
- **Service and transport resume failures:** `503`, `ECONNREFUSED`, timeout, or other live backend/transport failures during `loadSession` must abort startup instead of misclassifying the session as stale.
- **Malformed recovery state:** Corrupt recovery files must be quarantined so a fresh run still starts.
- **Recovery write exhaustion:** Disk-full or write failures while checkpointing recovery state must disable further recovery persistence instead of breaking the active run.
- **Approval continuation refresh:** If an approval is reopened exactly when session turn limits are exhausted, fresh author/reviewer sessions must be used and retired sessions must be closed without losing the continuation feedback.
- **Long trace/tool output:** Trace entries and tool data are bounded to avoid runaway memory/UI output.
- **Approval-pending UI gap:** Reviewer approval that is still awaiting user choice must keep `f`, `Enter`, and `q` actionable before the final result event is emitted.
- **Approval-pending input race:** The `f` force-continue shortcut must become live as soon as the approval resolver exists, even if React has not yet repainted the approved state, and the UI must leave pending-approved state immediately after force-continuing.
- **Terminal result race:** Approval-pending UI state must not masquerade as a final renderer result, or automation and non-TUI callers could hand off before the user accepts or force-continues; state observers get an explicit `approvalPending` flag.
- **Crowded shortcut chrome:** Low-frequency shortcuts such as `wrap`, `trace`, and `latest` must move behind `?` without hiding current state.
- **Phase-inverted animation:** Launching must show waiting behavior, active boxing motion must start only once rounds are running, and the motion must stop again on final approval.
- **Global-install Linux startup:** A globally installed `spar` process must resolve agent startup the same way an interactive `npx` invocation does, including login-shell PATH and unscoped `npx` package fallback handling.
- **Slow Copilot fallback startup:** GitHub Copilot fallback launch must prefer a stable prepared package cache before raw `npx @latest`, avoiding repeated registry/version-resolution overhead when the primary language-server shim is missing.
- **Mid-token stream splits:** Consecutive text or reasoning deltas that split a single word, including long words like `implementation` or `distribution`, must not introduce user-visible spaces into the final transcript.
- **Real streamed split-word replay:** A realistic event replay through the real turn adapter must prove that chunks such as `he` + `llo` stay joined end-to-end, instead of relying only on synthetic reducer inputs.
- **False boundary injection:** Alphabetic chunk boundaries without explicit whitespace must default to direct concatenation; only positive boundary evidence such as whitespace or punctuation may add a visible space.
- **TUI startup profiling noise:** Enabling `ACP_STARTUP_PROFILE=1` during TUI runs must not corrupt or jump the alternate-screen UI with profiler lines.
- **Startup status thrash:** Repeated startup observer phases that map to the same visible status must not spam the TUI with duplicate updates.
- **Stale startup chrome:** Once rounds are already running, delayed session ready or new session status text must not relabel an idle pane as Launching.
- **Fresh workspace reads after edits:** When files change during review or after an agent edit, the filesystem host must return current on-disk content on the next read instead of stale text.
- **Task file path confusion:** A relative task-file argument must resolve against the requested workspace root, not the shell's current directory, or launched runs can silently use inline text instead of the intended file.
- **Wrap default regression:** TUI startup must keep wrap enabled by default while still honoring explicit wrap env flags.

### Regression Assertions

- `test/engine.test.ts` asserts approval-shaped hallucinations and contradictory approval lines continue the loop.
- `test/engine.test.ts` asserts clean negated issue summaries, trailing issue-none prose, ANSI-wrapped verdicts, and resolved historical failures are accepted in one round.
- `test/engine.test.ts` asserts a saved pending reviewer turn resumes at reviewer verification without rerunning the author turn.
- `test/engine.test.ts` asserts a saved pending approval decision resumes from the approval callback without rerunning either agent turn or double-finalizing the run.
- `test/engine.test.ts` asserts stale saved session ids still allow the run to finish by falling back to fresh sessions.
- `test/engine.test.ts` asserts recovery state written by the real engine survives a real on-disk store roundtrip after interruption and resumes directly at reviewer verification on restart.
- `test/run-recovery.test.ts` asserts malformed recovery files are quarantined, config mismatches are rejected, and recovery write failures disable persistence without crashing the run.
- `test/runtime-role.test.ts` asserts `openRole` uses ACP `loadSession` for saved sessions and falls back cleanly when the saved session is gone.
- `test/runtime-role.test.ts` asserts `openRole` only falls back for true stale-session errors such as not-found responses, while timeout or transport failures from `loadSession` still abort startup with the original error.
- `test/runtime-role.test.ts` asserts nested wrapped stale-session causes still trigger fresh-session recovery, while nested non-stale causes and `503`/`ECONNREFUSED` resume failures continue to surface the real error.
- `test/engine.test.ts` asserts non-SGR terminal control sequences, including OSC with ST terminators, around clean approval verdicts are stripped before parsing.
- `test/engine.test.ts` asserts mixed-case approval tokens are intentionally tolerated when follow-up notes are clean.
- `test/engine.test.ts` asserts masked contradictions with dependency/startup crash language are rejected.
- `test/engine.test.ts` asserts CRLF-separated and blank-line-separated issue lists after `APPROVED` are treated as rejection feedback.
- `test/engine.test.ts` asserts high-latency hang notes after `APPROVED` are treated as unresolved feedback until a clean verified approval arrives.
- `test/engine.test.ts` asserts slow successful reviewer startup is still closed at the end of the run.
- `test/engine.test.ts` asserts a reviewer that settles after started roles are collected during failure cleanup is closed by the bounded late-role cleanup listener.
- `test/engine.test.ts` asserts approval continuation refreshes author/reviewer sessions once configured turn limits are exhausted and forwards continuation feedback to the fresh author session.
- `test/engine.test.ts` asserts `maxRounds=0`, negative, fractional, `NaN`, and `Infinity` programmatic inputs still run a safe number of rounds, and that invalid `maxApprovalContinuations` inputs fall back to the normalized base round budget.
- `test/tui-formatting.test.ts` asserts launching stays on waiting-style chrome while the boxing banner only animates during active running.
- `test/e2e-simulated.test.ts` already asserts the engine withholds final renderer results while post-approval continuation is unresolved; the TUI fix now keeps the pending approval controls visible and live during that same window.
- `test/engine.test.ts` asserts pending reviewer approval emits an `approvalPending` event and updates engine state to approved/done for TUI controls while withholding the terminal `result` event until the user decision resolves.
- `test/engine.test.ts` asserts force-continuing approval emits `approvalContinued` before the next round so the UI does not look stuck on approved.
- `test/state.test.ts` asserts the approval-pending reducer state is actionable, carries the provisional approved result, clears the `approvalPending` flag when the terminal result is emitted, and clears pending-approved chrome immediately on continuation.
- `test/runtime-loop.test.ts` asserts the legacy runtime adapter forwards `approvalPending` and `approvalContinued` separately from terminal `result`.
- `test/tui-formatting.test.ts` asserts approval shortcuts stay actionable as soon as the pending resolver exists, covering the `f` key race before a repaint.
- `packages/core/test/runtime.test.ts` asserts unscoped `npx` fallback packages can resolve to local package bins before raw `npx` startup, closing the gap seen under global Linux installs.
- `packages/core/test/runtime.test.ts` asserts GitHub Copilot-style fallback packages use an already-prepared cache before raw `npx @latest`, and only fall back to raw `npx` after stable package locations miss.
- `test/state.test.ts` asserts consecutive text and reasoning deltas default to joining alphabetic chunks, while explicit whitespace or punctuation still preserves separate words.
- `test/e2e-realistic.test.ts` asserts a realistic streamed delta replay through the real runtime loop keeps `hello world` and `iteration plan` intact without `he llo` or `itera tion`.
- `test/cli-config.test.ts` asserts TUI wrap stays enabled by default while explicit wrap env flags still override it.
- `test/runtime-role.test.ts` asserts duplicate startup observer phases that map to the same visible status collapse to a single user-visible status update.
- `test/tui-formatting.test.ts` asserts `q` does not enter finish mode before the run is done and that reasoning transcript sections still render with visible framing.
- `packages/core/test/hosts/local-fs.test.ts` asserts repeated reads return fresh on-disk file content after an edit, guarding against stale workspace reads during review.
- Existing engine, state, runtime-turn, runtime-role, update-check, TUI formatting, and realistic E2E tests cover startup recovery, empty output, cleanup, usage, trace bounds, timeout behavior, status rendering, and event propagation.
