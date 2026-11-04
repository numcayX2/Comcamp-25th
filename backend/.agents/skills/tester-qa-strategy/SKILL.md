---
name: tester-qa-strategy
description: "Design tests, investigate regressions, or verify acceptance criteria and edge cases."
---

# Tester and QA Strategy

## Contract

Apply this skill only when the task matches: Tester and QA Strategy. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Design tests, investigate regressions, or verify acceptance criteria and edge cases.

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

Input: A task that requires tester and qa strategy.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# Tester and QA Strategy

## การออกแบบ test

- แปลง acceptance criteria เป็น test cases ก่อนสรุปว่างานผ่าน
- ครอบคลุม happy path, validation error, authorization, empty state, boundary และ failure ของ dependency
- เลือกระดับ test ให้เหมาะสม: unit สำหรับ logic, integration สำหรับการเชื่อมต่อ และ end-to-end สำหรับ critical user flow

## การตรวจสอบ failure

- อ่าน error, stack trace, logs และผลลัพธ์จริงก่อนตั้งสมมติฐาน
- แยก product defect, test defect, environment defect และ flaky test ให้ชัด
- ห้ามลบหรือทำให้ test อ่อนลงเพียงเพื่อให้ pipeline ผ่าน
- การแก้ self-healing จำกัดไม่เกิน 3 รอบ และต้องแก้เฉพาะไฟล์ test ตามกฎ self-healing ที่กำหนด

## รายงานผล

- ระบุ command ที่รัน, จำนวนผ่าน/ไม่ผ่าน, failure ที่ reproduce ได้ และความเสี่ยงด้าน regression
- ถ้ายังไม่ผ่าน ให้หยุดพร้อมหลักฐานและสิ่งที่ต้องการจาก Developer

## Risk และ Technical Debt

- จัดลำดับ test ตาม risk และ blast radius ไม่ใช่ดู coverage percentage อย่างเดียว
- ตรวจ contract ระหว่าง component และ invariant ของข้อมูล ไม่ยึดติดเฉพาะ implementation ปัจจุบัน
- เพิ่ม regression test ทุกครั้งที่พบ bug ที่มีโอกาสเกิดซ้ำ และติดตาม flaky test เป็นหนี้คุณภาพ
- พิจารณา non-functional risk ที่เกี่ยวข้อง เช่น latency, throughput, memory, concurrency, security และ accessibility
- ถ้ายังทดสอบบางความเสี่ยงไม่ได้ ให้รายงาน gap, ผลกระทบ และเงื่อนไขที่ต้องมีเพื่อปิด gap อย่างชัดเจน
