---
name: loop-test-tdd-cycle
description: "Use test-driven development when implementing behavior with a runnable test framework."
---

# TDD Cycle

## Contract

Apply this skill only when the task matches: TDD Cycle. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Use test-driven development when implementing behavior with a runnable test framework.

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

Input: A task that requires tdd cycle.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# TDD Cycle

## วงจรการพัฒนา

1. เขียนหรือปรับ test ให้บอก behavior ที่ต้องการก่อน
2. รัน test และยืนยันว่า test ล้มเหลวด้วยเหตุผลที่ถูกต้อง (Red)
3. เขียนโค้ด production ขั้นต่ำให้ test ผ่าน (Green)
4. Refactor โดยรักษา test ให้ผ่าน และตรวจสอบ test ซ้ำ

## กฎปฏิบัติ

- ห้ามข้ามขั้นตอนการเขียน test เมื่อเพิ่ม behavior ใหม่
- Test ต้องตรวจ behavior ที่ผู้ใช้หรือระบบต้องการ ไม่ผูกกับ implementation โดยไม่จำเป็น
- ทุกการเปลี่ยนแปลงต้องจบด้วยผลการตรวจสอบที่รายงานได้

## Design Quality

- เขียน test ให้สะท้อน behavior, contract และ invariant ที่มีคุณค่าต่อผู้ใช้ ไม่ล็อก implementation โดยไม่จำเป็น
- ใช้ failure ของ test เพื่อค้นหาปัญหาใน model หรือ design ไม่ใช่แค่แก้ assertion ให้ผ่าน
- ระหว่าง refactor ตรวจ complexity, coupling, state management และผลกระทบต่อ test อื่น
- ถ้า test ยากเกินไป ให้พิจารณา boundary และ dependency design ก่อนเพิ่ม mock จำนวนมาก
- บันทึก test gap และ technical debt แทนการแกล้งทำให้ coverage หรือ test result ดูดี
