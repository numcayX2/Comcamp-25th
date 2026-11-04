---
name: cicd-pipeline-engineering
description: "Create or repair build, CI, deployment, and rollback pipelines."
---

# CI/CD Pipeline Engineering

## Contract

Apply this skill only when the task matches: CI/CD Pipeline Engineering. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Create or repair build, CI, deployment, and rollback pipelines.

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

Input: A task that requires ci/cd pipeline engineering.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# CI/CD Pipeline Engineering

## Pipeline gates

- ตรวจให้ pipeline มีขั้นตอน install แบบ reproducible, lint, typecheck, test และ build ตามที่โปรเจกต์รองรับ
- ใช้คำสั่งเดียวกับ local development เมื่อทำได้ เพื่อลดความแตกต่างระหว่าง local กับ CI
- แยก fast feedback checks ออกจาก integration/e2e checks ที่ใช้เวลานาน
- กำหนด artifact, cache และ dependency version ให้ตรวจสอบย้อนกลับได้

## ความปลอดภัยและ deployment

- ห้าม hardcode secret, token, private key หรือ credential ในโค้ดและ workflow
- ตรวจ permissions ของ CI job ให้แคบที่สุด และใช้ environment protection กับ production
- ตรวจ migration, backward compatibility, health check และ rollback plan ก่อน deploy
- ห้ามข้าม required checks หรือปิด security gate โดยไม่มีเหตุผลและการอนุมัติ

## เมื่อ pipeline ล้มเหลว

- ระบุ stage ที่ล้มเหลว, log หลักฐาน, สาเหตุที่เป็นไปได้ และวิธี reproduce ใน local
- แก้สาเหตุที่แท้จริง ไม่ retry ซ้ำโดยไม่มีข้อมูลใหม่

## Reliability และ Technical Debt

- ออกแบบ pipeline ให้ deterministic, observable และ idempotent เท่าที่ทำได้ พร้อมแยก infrastructure failure ออกจาก product failure
- ตรวจ pipeline latency, cache correctness, flaky jobs, queue/resource limits และค่าใช้จ่ายเมื่อ repository หรือทีมโตขึ้น
- ทุก deployment ต้องมี health signal, timeout, rollback หรือ forward-fix strategy และ ownership ที่ชัดเจน
- หาก bypass gate หรือใช้ manual step ชั่วคราว ให้บันทึกเหตุผล ความเสี่ยง และเงื่อนไขที่จะเอาออก
- อย่าเพิ่ม stage, tool หรือ abstraction โดยไม่มีปัญหาที่วัดได้ว่าต้องแก้
