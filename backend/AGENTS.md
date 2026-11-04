<!-- BEGIN LOCAL AGENT SKILL MANAGER -->
# Project Agent Guide

<!-- Target: both; mode: agent. Entrypoint for Codex and Antigravity. -->

## Working Agreement

- **Mandatory for AI Assistants**: Read this AGENTS.md, relevant `.agents/skills/`, and project context before modifying code.
- Read the relevant project context and existing repository conventions before changing code.
- Identify the goal, acceptance criteria, assumptions, invariants, risks, and files in scope before implementation.
- Prefer the smallest maintainable change; evaluate complexity, performance, security, compatibility, and technical debt.
- **Zero AI Slop Rule**: For any UI/front-end task, eliminate AI slop (no generic purples/terracotta, no SaaS card clones, no emojis as icons). Follow the design system, semantic tokens (`frontend-shadcn`), and accessibility guidelines.
- Verify with the project's relevant tests, checks, and build commands. Never claim success without evidence.
- Follow `.agents/project/agent-manager-config.json` for Git commits; when missing or unclear, ask before committing.
- Under `auto`, stage only reviewed task files explicitly (never `git add -A`) and create a local checkpoint commit only after checks pass and baseline changes are excluded.
- Never commit secrets or unresolved failures, and never reset, amend, force-push, or merge automatically.
- Run `initskill --help` or `initskill doctor` to inspect CLI capabilities and project health.
- Report uncertainty, partial completion, failures, and follow-up debt directly instead of inventing results.
- Respond in natural Thai when the user communicates in Thai, while preserving technical identifiers and commands.

## Shared Agent Assets

- Project context: `.agents/project/project-context.md`
- Architecture decisions: `.agents/project/architecture.md`
- Technical debt register: `.agents/project/technical-debt.md`
- Shared skills: `.agents/skills/` (load only skills relevant to the current task).
- Codex reads this AGENTS.md and discovers project skills under `.agents/skills/`.
- In Codex CLI/IDE, mention `$skill-name` or use `/skills`; Antigravity custom agent files are not Codex agent registrations.
- Codex native custom subagents: `.codex/agents/skill-manager-*.toml` (requires a host version supporting standalone agent files).
- Antigravity custom agents: `.agents/agents/` (use `/agents` in Antigravity CLI).
- Antigravity workspace rules: `.agents/rules/`.
- Antigravity discovers `.agents/skills/`; mention a skill by name or use its slash command where supported.

## Choose Skills for the Current Task

- Match the user request to the descriptions below. Read the selected SKILL.md before applying it.
- Select Developer for implementation, QA for tests/review, CI/CD for pipelines, and Git for version-control tasks.
- Use the team workflow when coordination across roles is needed. Simple tasks do not require every role.
- Use existing host delegation tools when available; otherwise perform the relevant roles sequentially and report that honestly.
- A question or diagnosis authorizes inspection; it does not by itself authorize code changes, commits, or deployments.
- [cicd-pipeline-engineering](.agents/skills/cicd-pipeline-engineering/SKILL.md): Create or repair build, CI, deployment, and rollback pipelines.
- [core-language-strategy](.agents/skills/core-language-strategy/SKILL.md): Write clear agent instructions and choose the response language for Thai and English technical communication.
- [core-no-assumptions](.agents/skills/core-no-assumptions/SKILL.md): Resolve missing facts, ambiguous requirements, or uncertain repository contracts before implementation.
- [core-skill-authoring](.agents/skills/core-skill-authoring/SKILL.md): Create or revise skill contracts, trigger descriptions, procedures, and verification criteria.
- [developer-implementation](.agents/skills/developer-implementation/SKILL.md): Implement features or repair code defects while preserving interfaces and controlling technical debt.
- [git-repository-workflow](.agents/skills/git-repository-workflow/SKILL.md): Review repository changes, stage task files, or create local commits and releases under the project Git policy.
- [loop-test-tdd-cycle](.agents/skills/loop-test-tdd-cycle/SKILL.md): Use test-driven development when implementing behavior with a runnable test framework.
- [team-engineering-team](.agents/skills/team-engineering-team/SKILL.md): Coordinate development, QA, CI/CD, and Git handoffs for work spanning multiple engineering responsibilities.
- [team-subagent-orchestration](.agents/skills/team-subagent-orchestration/SKILL.md): Delegate independent engineering tasks to native subagents and collect separate review evidence without conflicting edits.
- [tester-qa-strategy](.agents/skills/tester-qa-strategy/SKILL.md): Design tests, investigate regressions, or verify acceptance criteria and edge cases.

## Delegation and Skill Adaptation

- Follow `.agents/project/subagent-contract.md` for native dispatch, disjoint write scopes, independent review, and final-state verification.
- You may use relevant native subagents for authorized project work. Keep the coordinator responsible for integration; do not exceed the contract budget or invent unavailable tools.
- After non-trivial implementation, obtain a separate Reviewer and QA evidence when tools are available. Report blocked/skipped review explicitly.
- For a concrete task gap, you may create or adapt project-local skills under `.agents/skills/`; read the existing skill first, preserve its scope and guardrails, and validate before adopting it.
- Use `initskill skill create/update/validate --help` for safe writes; updates require the existing hash and keep backups. Do not modify global skills or publish as a side effect.

### Available Native Roles

- reviewer: Independently review correctness, security, regressions, and missing tests without editing the implementation. [Codex](.codex/agents/skill-manager-reviewer.toml) [Antigravity](.agents/agents/reviewer/agent.md)
- developer: Implements maintainable changes, evaluates design trade-offs, and keeps scope under control. [Codex](.codex/agents/skill-manager-developer.toml) [Antigravity](.agents/agents/developer/agent.md)
- tester: Designs risk-based tests, diagnoses failures, and protects behavior from regressions. [Codex](.codex/agents/skill-manager-tester.toml) [Antigravity](.agents/agents/tester/agent.md)
- ci-cd: Improves reproducible delivery pipelines, deployment safety, and operational feedback. [Codex](.codex/agents/skill-manager-ci-cd.toml) [Antigravity](.agents/agents/ci-cd/agent.md)
- git-release: Maintains reviewable Git history, safe releases, and reversible changes. [Codex](.codex/agents/skill-manager-git-release.toml) [Antigravity](.agents/agents/git-release/agent.md)
- skill-author: Create or adapt project-local skills for a demonstrated task, validate metadata, and preserve existing instructions. [Codex](.codex/agents/skill-manager-skill-author.toml) [Antigravity](.agents/agents/skill-author/agent.md)

## Agent Handoff

- Treat the files under `.agents/` as the project-local source of truth for this workflow.
- Keep project-specific decisions and debt in the project files, not only in chat history.
- Do not overwrite existing user-authored instructions without explicit approval.

<!-- END LOCAL AGENT SKILL MANAGER -->