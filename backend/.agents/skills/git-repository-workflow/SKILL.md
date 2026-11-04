---
name: git-repository-workflow
description: "Review repository changes, stage task files, or create local commits and releases under the project Git policy."
---

# Git and Release Workflow

## Contract

Apply this skill only when the task matches: Git and Release Workflow. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Review repository changes, stage task files, or create local commits and releases under the project Git policy.

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

Input: A task that requires git and release workflow.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# Git and Release Workflow

## ก่อนแก้ไข

- ตรวจ `git status`, branch ปัจจุบัน และ diff ที่มีอยู่ก่อนเริ่ม
- ห้ามเขียนทับ uncommitted changes ของผู้ใช้
- ใช้ branch ที่สื่อความหมาย และหลีกเลี่ยงการทำงานตรงบน main/master เมื่อ repository มีกระบวนการ review

## Commit discipline

- แบ่ง commit ตามเหตุผลเดียวและให้แต่ละ commit review ได้
- ใช้ commit message ที่อธิบาย intent เช่น `feat:`, `fix:`, `test:`, `ci:` หรือ `chore:` ตาม convention ของ repository
- ตรวจ diff, staged files และ secret ก่อน commit
- ไม่ commit `.env`, credentials, build output หรือไฟล์ชั่วคราว
- อ่านนโยบายจาก `.agents/project/agent-manager-config.json` (`ask`, `auto`, `off`); หากไม่มี config ให้ใช้ `ask`
- `ask`: เสนอ local checkpoint commit หลัง verification แล้วรอผู้ใช้ยืนยัน; `off`: ห้ามสร้าง commit; `auto`: สร้าง local checkpoint ได้เมื่อผ่าน guardrails ทุกข้อ
- ก่อนเริ่มต้องบันทึก baseline ของ `git status`; stage เฉพาะ path ของ task ด้วย path ที่ระบุชัด ห้ามใช้ `git add -A` หรือรวม uncommitted changes เดิมของผู้ใช้
- ก่อน commit ต้องตรวจ staged diff, secret, test/check และยืนยันว่า staged paths อยู่ใน scope; หากไฟล์ทับกับ changes เดิมให้หยุดและรายงาน
- ห้ามสร้าง commit หาก test/check สำคัญยัง fail, มี unresolved critical risk, ตรวจ secret ไม่ผ่าน หรือไม่ทราบขอบเขตไฟล์ที่ต้อง commit
- ใช้ commit message ที่สื่อ intent และรายงาน commit hash หลังสร้างสำเร็จ; checkpoint เป็น local เท่านั้น ไม่ push หรือ merge อัตโนมัติ

## ความปลอดภัย

- ห้ามใช้ `git reset --hard`, force push หรือ rewrite history เว้นแต่ผู้ใช้สั่งอย่างชัดเจน
- ก่อน merge/rebase ให้ตรวจสถานะและสร้างจุดย้อนกลับที่เหมาะสม
- หลัง commit หรือ merge ให้ตรวจ `git status` และรายงาน commit hash/ผลตรวจสอบ

## Git เป็น Engineering History

- ให้ commit สะท้อนเหตุผลและ invariant ของการเปลี่ยนแปลง เพื่อให้ debug, bisect และ revert ได้ในอนาคต
- แยก refactor, behavior change, test และ config migration เมื่อการรวมกันทำให้ review หรือ rollback ยาก
- ก่อน merge คิดถึง compatibility ระหว่าง branch/version, migration order และผลกระทบต่อผู้ใช้ที่ยังอยู่บนเวอร์ชันเก่า
- หลีกเลี่ยงการซ่อน technical debt ใน commit ใหญ่ หากรับ debt ไว้ให้ใส่คำอธิบายและ issue reference ตาม convention ของทีม
- ใช้ประวัติ Git เป็นหลักฐาน ไม่ใช่ข้ออ้างในการทิ้งการตรวจ test, diff หรือ security
