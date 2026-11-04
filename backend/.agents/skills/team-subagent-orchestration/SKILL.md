---
name: team-subagent-orchestration
description: "Delegate independent engineering tasks to native subagents and collect separate review evidence without conflicting edits."
---

# Native Subagent Orchestration

## Contract

Apply this skill only when the task matches: Native Subagent Orchestration. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Delegate independent engineering tasks to native subagents and collect separate review evidence without conflicting edits.

## Inputs

- The user goal, acceptance criteria, and constraints.
- The relevant repository files, existing conventions, commands, and test results.
- Any required tool capability, permission, or external dependency.

## Constraints

- Do not guess when a required input, contract, or project convention is unknown.
- Preserve existing behavior outside the requested scope and avoid unnecessary abstraction.
- Never hide failures by weakening validation, tests, or safety checks.
- If a shortcut creates technical debt, record its impact and the condition for revisiting it.

## Procedure

1. Confirm that the task matches this skill and identify the expected outcome.
2. Inspect the relevant files, dependencies, interfaces, and existing checks before changing anything.
3. Apply the guidance below using the smallest maintainable change.
4. Run the most relevant verification commands and inspect the final diff.
5. Report the result, evidence, unresolved risks, and any technical debt.

## Output

- Provide a concise summary of the change or decision.
- Include verification commands and their results.
- State assumptions, limitations, risks, and follow-up work when applicable.

## Verification

- Verify correctness, edge cases, compatibility, security, performance, and operational impact relevant to the task.
- If verification cannot be completed, explain why and do not claim success.

## Example

Input: A task that requires native subagent orchestration.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# Native Subagent Orchestration

Use this workflow for independent implementation slices, bounded investigation, or a separate verification pass. Simple dependent work can remain in the coordinator.

## Dispatch contract

- Read `.agents/project/subagent-contract.md` and inspect the native tools exposed by the current host before dispatching. Codex uses native spawn/message/wait/close tools and project custom agents; Antigravity uses `invoke_subagent` with `subagent: true` role definitions. Follow the live tool schema, not assumed parameters.
- Give each worker the objective, acceptance criteria, relevant raw inputs, allowed write paths or read-only status, baseline user changes, and expected evidence. Antigravity workers start with separate context; explicitly pass what they need.
- Assign disjoint write scopes or host-provided isolated worktrees. Keep edits to shared contracts in the coordinator. Use up to three concurrent workers by default and do not allow recursive spawning without a new scoped budget.
- Select relevant roles: Developer implements; Tester verifies behavior; Reviewer independently audits the final diff; CI/CD checks delivery changes; Git reviews release scope; Skill Author addresses a concrete missing capability.
- Do useful non-overlapping work while workers run. Collect completion statuses and artifacts, then integrate and run checks on the final state.

## Independent verification

- The implementation author must not be its only reviewer. Provide a stable diff and acceptance criteria to a different Reviewer without supplying the conclusions it is supposed to find.
- Treat findings as hypotheses until supported by code, reproductions, or test results. Resolve disagreement from evidence; do not accept a majority vote as correctness.
- Keep the reviewer read-only. Give QA only the permissions required for relevant checks, and report product/test/environment failures separately.
- On a reproduced defect, request a bounded repair and repeat affected checks. Stop after three repair rounds with evidence and unresolved risks instead of weakening checks.
- Close finished workers and cancel obsolete tasks. Report unavailable/blocked review separately from passed tests; never fabricate worker IDs, test results, or independent approval.

## Skill evolution

When a real workflow gap appears, delegate a project-local skill draft to Skill Author, follow the installed skill-authoring contract, then review and validate it before use. Instruction changes do not grant tool permissions, authorize publication, or permit bypassing user constraints.

## Example

Task: Implement an API change and verify regression risk.
Expected: Assign Developer a bounded implementation slice; let QA design cases on a separate write set; after integration, send the stable diff to a separate read-only Reviewer; run checks on the final result and report both test and review evidence.
