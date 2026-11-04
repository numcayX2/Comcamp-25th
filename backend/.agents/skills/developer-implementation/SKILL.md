---
name: developer-implementation
description: "Implement features or repair code defects while preserving interfaces and controlling technical debt."
---

# Developer Implementation

## Contract

Apply this skill only when the task matches: Developer Implementation. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Implement features or repair code defects while preserving interfaces and controlling technical debt.

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

Input: A task that requires developer implementation.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# Developer Implementation

## ก่อนเริ่ม

- อ่าน requirement, package scripts, README, architecture และโค้ดที่เกี่ยวข้องก่อนแก้
- ระบุ acceptance criteria และไฟล์ที่คาดว่าจะเปลี่ยน
- ถ้าพบ requirement ขัดแย้งหรือข้อมูลไม่พอ ให้ถามก่อนเดา

## ระหว่างพัฒนา

- เปลี่ยนโค้ดให้น้อยที่สุดและรักษา public API/behavior เดิมที่ไม่เกี่ยวข้อง
- ทำตาม conventions และ dependency ที่มีอยู่ก่อนเพิ่มของใหม่
- แยก business logic ออกจาก I/O, framework glue และ presentation ตาม architecture ของโปรเจกต์
- จัดการ error, validation, empty state และ boundary cases อย่างตั้งใจ
- ไม่ปิดบังปัญหาด้วยการปิด lint, ลดความเข้มงวดของ type หรือข้าม test

## การคิดแบบ Software Engineer

- ระบุ contract, invariant, state transition และ boundary ของ component ก่อนเลือก implementation
- เลือก data structure และ algorithm ให้เหมาะกับขนาดข้อมูล พร้อมพิจารณา time/space complexity และ hot path
- วิเคราะห์ผลกระทบระยะยาวต่อ coupling, cohesion, extensibility, observability, security และ operational cost
- แยก quick fix ที่จำเป็นออกจาก design ถาวร และบันทึก technical debt ที่ตั้งใจรับไว้
- ก่อนเพิ่ม abstraction ให้ยืนยันว่ามี behavior ซ้ำหรือ volatility จริง ไม่สร้าง framework ครอบโค้ดโดยไม่มีเหตุผล

## ก่อนส่งต่องาน

- รัน test ที่เกี่ยวข้องและตรวจ diff ด้วยตนเอง
- รายงานไฟล์ที่เปลี่ยน เหตุผล คำสั่งตรวจสอบ และข้อจำกัดที่ยังเหลือ
- ระบุ technical debt ใหม่หรือ debt ที่ค้นพบ พร้อมระดับความเสี่ยงและเงื่อนไขที่ควรกลับมาจัดการ
