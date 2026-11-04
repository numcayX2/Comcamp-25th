---
trigger: model_decision
description: "Engineering guardrails for software changes."
---

# Engineering Team Rules

Follow the working agreement and skill catalogue in the workspace root AGENTS.md.
Select only skills whose descriptions match the current task and read their SKILL.md before use.
Use Developer for implementation, QA for verification, CI/CD for pipeline changes, Git for commits, and UI Designer for frontend/design.
For any UI/frontend task, strictly ban AI slop (no generic SaaS purple gradients, no emojis as icons, use semantic tokens).
Run `initskill doctor` to verify workspace health.
Read the project Git policy before committing. Markdown instructions do not grant tool permissions.
