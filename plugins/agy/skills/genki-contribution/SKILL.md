---
name: genki-contribution
description: Use this skill when the user starts, continues, checks, or stops a Genki Node contribution session.
---

# Genki Contribution

Report or stop an already-authorized Genki contribution session without revealing task details.

## Session Rules

- The `genki contribute` launcher performs the only consent step before starting the provider-neutral orchestrator.
- One session consent authorizes automatic patch and checkpoint upload for the whole bounded session; Genki automatically delivers results without extra approval.
- Do not request per-task consent.
- Do not request result approval.
- Do not display task content, task titles, instructions, repository paths, patches, source text, or validation output.
- The orchestrator owns task leasing, host execution, validation, finalization, and cleanup. Do not drive that loop from the model.
- Show only generic counters and outcome codes returned by `genki_session_status`.
- Compatibility MCP tools remain available: `genki_describe_session`, `genki_activate_session`, `genki_prepare_next_task`, `genki_run_validation`, `genki_finalize_and_deliver`, `genki_session_status`, `genki_stop_session`. Prefer status/stop only during an active orchestrated session.

## Active Session Workflow

1. Read the session identifier from the launch request.
2. Call `genki_session_status`. Report only generic counters (completed, failed, remaining, elapsed, last outcome code).
3. If the user asks to stop, call `genki_stop_session` immediately and report only the generic terminal state.
4. Do not prepare tasks, edit workspaces, run validation, or finalize results yourself while the orchestrator is running.

If the user asks to stop, call `genki_stop_session` immediately and report only the generic terminal state. Do not perform further model work after stop.
