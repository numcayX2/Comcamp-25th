---
name: core-language-strategy
description: "Write clear agent instructions and choose the response language for Thai and English technical communication."
---

# Language Strategy

## Contract

Apply this skill only when the task matches: Language Strategy. Keep the work within the requested scope and do not invent missing facts.

## When to Use

Write clear agent instructions and choose the response language for Thai and English technical communication.

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

Input: A task that requires language strategy.
Expected: Apply the procedure and constraints, produce evidence, and respond to the user in natural Thai when the user communicates in Thai.

## Guidance

# Language Strategy

## Coding และงานใช้เหตุผลสูง

- สำหรับงาน coding, data analysis, debugging และ logic ซับซ้อน ให้เขียน instruction, constraints, acceptance criteria และขั้นตอนทางเทคนิคเป็นภาษาอังกฤษที่กระชับเมื่อช่วยลด ambiguity
- คงชื่อ function, class, API, package, error message, command และ identifier ตามต้นฉบับ ห้ามแปลจนทำให้ความหมายทางเทคนิคเปลี่ยน
- แยกภาษาของ reasoning ออกจากภาษาของคำตอบ: หากผู้ใช้สื่อสารภาษาไทย ให้สรุปผลเป็นภาษาไทยธรรมชาติและคงคำเทคนิคที่จำเป็นไว้
- สำหรับไฟล์ system instruction, `agent.md` และ `SKILL.md` ให้ใช้ English เป็นหลักใน metadata, trigger, constraints, procedure และ verification เมื่อช่วยลดความกำกวม

## Content และการสื่อสารภาษาไทย

- งาน marketing, social content, copywriting และเอกสารสำหรับคนไทย ให้ใช้ภาษาไทยเป็นหลัก
- ระบุกลุ่มเป้าหมาย จุดประสงค์ ช่องทาง และ tone ก่อนเขียน เช่น ทางการ กึ่งทางการ เป็นกันเอง หรือภาษาพูด
- หลีกเลี่ยงสำนวนแปลตรงตัว รักษาบริบท วัฒนธรรม ความเป็นธรรมชาติ และคำที่กลุ่มเป้าหมายใช้จริง

## เทคนิคผสม

- ใช้ English สำหรับ role, instruction, workflow และ technical constraints เมื่อเหมาะสม แล้วกำหนดรูปแบบผลลัพธ์ชัดเจน เช่น `Respond in natural Thai tone.`
- หากผู้ใช้ระบุภาษา รูปแบบ หรือ tone เอง ให้ถือเป็นข้อกำหนดสูงสุด
- อย่าเปลี่ยนภาษาเพียงเพื่อความสวยงามจนทำให้ requirement, edge case หรือ technical detail หายไป
