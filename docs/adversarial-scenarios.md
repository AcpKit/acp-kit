# Adversarial Scenario Analysis

## Author-Reviewer Loop Verdict Hardening

This pass focused on user-visible loop termination and recovery behavior in `@acp-kit/spar`.

### Failure Cases Covered

- **Malformed reviewer approval:** Reviewer text that mentions `APPROVED` outside the first non-empty line must not end the loop.
- **Contradictory approval:** `APPROVED` followed by failure, missing-work, timeout, crash, dependency, or restart-recovery issues must be treated as feedback.
- **Clean approval notes:** `APPROVED` followed by realistic summaries such as `No remaining issues`, `Problems: none`, or `Issues: none. Everything looks solid.` must not cause unnecessary extra rounds.
- **Masked contradictions:** Clean-looking notes with `but/however` plus failure language must still be rejected.
- **Terminal-formatted verdicts:** ANSI color escapes and zero-width characters around verdicts must be stripped before interpretation.
- **Historical failures:** Reviewer notes that explicitly say a previous failure is now fixed and verified must not be treated as current rejection feedback.
- **Empty reviewer output:** Blank reviewer replies must become explicit recovery feedback instead of accidental approval.
- **Contradictory reviewer guidance:** Later feedback must be fed into the next author round without losing prior loop state.
- **Startup and dependency failures:** Role startup failures and model/dependency conflicts must surface while closing any role that started.
- **Hung parallel startup:** If one role fails immediately while the other launch stalls or resolves late, the loop must surface the real failure promptly instead of hanging, and it must still close any late-starting role.
- **Premature reviewer completion state:** In round 1, a reviewer pane that has not started must stay in a waiting state even if the reviewer session itself is already ready; users must not see “turn completed without visible output” before review begins.
- **Blocked full-task view:** Long tasks must remain viewable from setup, launch confirmation, and task-review overlays; `v` must open the full task view and return to the prior overlay on close.
- **Disk exhaustion:** Workspace creation failure such as `ENOSPC` must stop before launching agents and record an engine error.
- **Interrupted cleanup:** Run failure plus cleanup failure must preserve both errors for diagnosis.
- **Interrupted reviewer resume:** If the process stops after the author turn but before or during reviewer execution, the next matching run must resume at reviewer verification without silently rerunning the author turn.
- **Interrupted approval resume:** If the process stops while approval is pending, the next matching run must resume from the approval decision instead of rerunning agent turns or emitting duplicate final results.
- **Engine/store roundtrip gap:** Recovery written by the real engine must deserialize through the real store and resume from the persisted pending action shape without mocked shortcuts.
- **Stale saved sessions:** If a persisted ACP session id no longer exists, startup must fall back to a fresh session instead of failing the whole run.
- **Malformed recovery state:** Corrupt recovery files must be quarantined so a fresh run still starts.
- **Recovery write exhaustion:** Disk-full or write failures while checkpointing recovery state must disable further recovery persistence instead of breaking the active run.
- **Long trace/tool output:** Trace entries and tool data are bounded to avoid runaway memory/UI output, and long unbroken renderer lines must wrap without hanging the plain console renderer.

### Regression Assertions

- `test/engine.test.ts` asserts approval-shaped hallucinations and contradictory approval lines continue the loop.
- `test/engine.test.ts` asserts clean negated issue summaries, trailing issue-none prose, ANSI-wrapped verdicts, and resolved historical failures are accepted in one round.
- `test/engine.test.ts` asserts a saved pending reviewer turn resumes at reviewer verification without rerunning the author turn.
- `test/engine.test.ts` asserts a saved pending approval decision resumes from the approval callback without rerunning either agent turn or emitting duplicate finalization.
- `test/engine.test.ts` asserts stale saved session ids still allow the run to finish by falling back to fresh sessions.
- `test/engine.test.ts` asserts recovery state written by the real engine survives a real on-disk store roundtrip after interruption and resumes directly at reviewer verification on restart.
- `test/run-recovery.test.ts` asserts malformed recovery files are quarantined, config mismatches are rejected, and recovery write failures disable persistence without crashing the run.
- `test/runtime-role.test.ts` asserts `openRole` uses ACP `loadSession` for saved sessions and falls back cleanly when the saved session is gone.
- `test/engine.test.ts` now asserts masked contradictions with dependency/startup crash language are rejected.
- `test/tui-formatting.test.ts` asserts a reviewer pane that has not started round 1 stays in a waiting state while the author is still running.
- `test/tui-formatting.test.ts` asserts the `v` shortcut resolves from setup, launch confirmation, and task-review confirmation states, and that closing the full-task view returns to the originating overlay.
- Existing engine, state, runtime-turn, plain-renderer, and realistic E2E tests cover startup recovery, empty output, cleanup, usage, trace bounds, long unbroken renderer output, and event propagation.
- Reviewed changed runtime, role startup, TUI startup/status, CLI update-check, and CLI entry-point diffs; their existing focused tests cover startup status mapping, cleanup, terminal cwd confinement, timeout/update-check behavior, and TUI formatting/status rendering.
