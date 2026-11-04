# Subagent Working Contract

Use native delegation for independent work or separate review when it materially helps the task. Keep short or tightly dependent work local.

## Dispatch

1. Record the user goal, acceptance criteria, baseline changes, risk, and file ownership. The parent owns integration and final verification.
2. Use at most 3 concurrent workers unless the project owner changes the budget. Avoid recursive spawning and respect host limits.
3. Give each worker a bounded goal, inputs, allowed write paths (or read-only), checks, and required evidence. Allocate disjoint write sets or use host-provided isolated worktrees.
4. Codex: use available native spawn/message/wait/close tools. Select a skill-manager role when supported; otherwise use a native worker/explorer with the role instructions. Antigravity: use invoke_subagent with a registered subagent role, following the live tool schema.
5. Do not invent tool arguments or claim spawning from a Markdown role name alone. If unavailable, report the limitation and do not label sequential self-review as independent review.

## Verification and Integration

- Collect terminal status and actual artifacts before integration. Resolve conflicting findings from evidence, not majority vote.
- After implementation, assign a different Reviewer a stable final diff and acceptance criteria. Reviewers do not edit the patch being reviewed.
- Assign QA relevant checks against the integrated result. Tests running before the final edit do not verify the final state.
- Request a focused correction for reproduced defects, then rerun affected checks and review changed risk areas. Stop after 3 repair rounds and report unresolved failures.
- Report review skipped/blocked separately from tests passed. A missing reviewer is not independent approval.
- Close completed workers, cancel obsolete work, and report changes, tests, review evidence, limitations, and outstanding debt.
- Workers do not stage, commit, deploy, publish, or alter credentials. Only the coordinator may perform an authorized release under the project Git policy.

## Project-local Skill Adaptation

- Reuse an existing matching skill first. Create a new skill only for a concrete gap, or adapt one based on observed failures.
- Use initskill skill create/update/validate with JSON results. Scope changes to .agents/skills; do not modify global skills, AGENTS.md safety policy, or user rules as a side effect.
- Before update, read the current skill and retain its hash. An update requires an explicit optimistic-concurrency hash and makes a backup.
- Include a discriminating trigger, inputs/constraints, useful procedure, observable outputs, and task-relevant verification. Do not copy secrets or unrelated conversation history.
- Validate metadata and independently exercise a realistic task in an isolated workspace. Structural validation is not proof of useful behavior.
- The parent reviews and adopts the skill; a worker cannot approve its own instruction changes. Respect existing permissions and never weaken guardrails to complete a task.
