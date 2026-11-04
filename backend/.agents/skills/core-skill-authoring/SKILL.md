---
name: core-skill-authoring
description: "Create or revise skill contracts, trigger descriptions, procedures, and verification criteria."
---

# Skill Authoring Standard

## Contract

Apply this skill only when the task matches: Skill Authoring Standard. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Create or revise skill contracts, trigger descriptions, procedures, and verification criteria.

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

Input: A task that requires skill authoring standard.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# Skill Authoring Standard

## Contract

Create or adapt a project-local `SKILL.md` used by Codex and Antigravity when a task has a concrete capability gap or an existing skill demonstrably misroutes work. Reuse matching skills first; do not create one for every task.

## Required structure

- Add YAML frontmatter with a unique lowercase `name` and a specific `description` that explains what the skill does and when to use it.
- Define the skill's responsibility and trigger conditions before implementation details.
- State required inputs, constraints, prohibited actions, and permission boundaries.
- Write a procedure with useful decision points and verification steps; avoid prescribing unnecessary ceremony for simple work.
- Define the output format. Use a schema when downstream automation consumes the result.
- Add a small input/expected-output example that demonstrates the intended behavior.

## Production quality

- Keep one skill focused on one capability; split unrelated responsibilities into separate skills.
- Prefer progressive disclosure: keep `SKILL.md` concise and place large references, examples, or scripts in the skill folder when needed.
- Treat tool calls as contracts: document preconditions, parameters, side effects, failure handling, and safe retries.
- Include a verification loop and fail-safe behavior. The skill must report uncertainty instead of inventing data.
- Consider state, memory, complexity, security, scalability, observability, compatibility, and technical debt before finalizing the design.

## Safe creation and adaptation

1. Identify the gap and one realistic task that would benefit. Read any existing related skill, repository contracts, and its supporting resources.
2. Scope instruction changes to `.agents/skills/<name>/SKILL.md` and task-relevant resources. Do not change global skills, permissions, project safety policy, credentials, or unrelated instructions.
3. Draft a complete skill file in an authorized scratch location, with a name matching the destination folder and a precise trigger description. Do not include secrets or copied chat history.
4. Use `initskill skill create <name> --from-file <draft> --json --dry-run`, then create it after reviewing the plan. For adaptation, use `initskill skill inspect <name> --json` to obtain the current hash, then `initskill skill update <name> --from-file <draft> --expected-hash <hash> --json`. The expected hash must reflect the version actually reviewed; a changed file requires re-reading and revising, not a blind retry.
5. Run `initskill skill validate --json`. Validate any new executable helpers before running them on real data. Preserve unrelated metadata and resources; a backup is not permission to overwrite arbitrary user instructions.
6. Have another available native reviewer exercise a realistic task in an isolated workspace and inspect the resulting evidence. If delegation is unavailable, report that behavioral review is incomplete. Metadata validation alone does not prove decision quality.
7. Adopt only the reviewed narrow improvement; report purpose, changed paths, backup, validation, behavior evidence, and limitations. Keep external publication separate from local creation.

## Example

Task: A repository uses a custom test command that the current QA skill misses.
Expected: Verify that command from package scripts or CI, adapt the project-local QA guidance with a narrow trigger, preserve existing checks, validate the file, and independently exercise the command-selection behavior without weakening tests.

## Language

- Write system instructions, metadata, triggers, constraints, and procedures in precise English when this reduces ambiguity.
- Preserve code identifiers, API names, commands, schemas, and error messages exactly.
- Specify the user-facing response language separately, for example: `Respond in natural Thai when the user communicates in Thai.`
