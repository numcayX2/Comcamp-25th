/**
 * /register wizard — data model, step definitions and validation.
 * No React in here so the rules stay testable and the component stays thin.
 */
import type { ApplicationPayload, ShirtSize } from '../../lib/api';

export const SEATS = 30;
export const FEE_TEXT = '1,000';
export const FB_URL = 'https://www.facebook.com/CCCSMJU';

export const GRADES = ['ม.4', 'ม.5', 'ม.6', 'ปวช.1', 'ปวช.2', 'ปวช.3'] as const;
/** Select value for "other"; the applicant then types their own level, which is what gets submitted. */
export const GRADE_OTHER = 'อื่นๆ';
export const GRADE_OTHER_MAX = 20; // grade column is VARCHAR(20)
export const SHIRT_SIZES: ShirtSize[] = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

/**
 * Chest circumference in inches (AGENTS.md §9.1 lists S 36", M 38", L 40", XL 42").
 * null = not announced yet.
 * TODO(content): รอประกาศอย่างเป็นทางการ — ยืนยันตัวเลข S–XL และเพิ่มค่า XS / 2XL / 3XL จากทีมงาน
 */
export const SIZE_CHEST: Record<ShirtSize, number | null> = {
  XS: null,
  S: 36,
  M: 38,
  L: 40,
  XL: 42,
  '2XL': null,
  '3XL': null,
};

/** Wizard form state. Selects start empty so nothing is submitted by accident. */
export interface FormState extends Omit<ApplicationPayload, 'shirtSize' | 'province'> {
  shirtSize: ShirtSize | '';
  province: string;
  /** Free-text level, used only while `grade` is GRADE_OTHER. */
  gradeOther: string;
}

/** Splits a stored grade back into the select value and the free-text part. */
export function splitGrade(grade: string): { grade: string; gradeOther: string } {
  return (GRADES as readonly string[]).includes(grade)
    ? { grade, gradeOther: '' }
    : { grade: grade ? GRADE_OTHER : '', gradeOther: grade };
}

/** Thai error for a grade select + free text pair, or undefined when valid (mirrors the backend). */
export function validateGradeFields(grade: string, gradeOther: string): string | undefined {
  if ((GRADES as readonly string[]).includes(grade)) return undefined;
  if (grade !== GRADE_OTHER) return 'กรุณาเลือกระดับชั้น';
  const text = gradeOther.trim();
  if (text.length < 2) return 'กรุณาระบุระดับชั้นของคุณ (อย่างน้อย 2 ตัวอักษร)';
  if (text.length > GRADE_OTHER_MAX) return `ระบุได้ไม่เกิน ${GRADE_OTHER_MAX} ตัวอักษร`;
  return undefined;
}

/** The grade string the API receives. */
export const gradeValue = (f: Pick<FormState, 'grade' | 'gradeOther'>) =>
  f.grade === GRADE_OTHER ? f.gradeOther.trim() : f.grade;

export const EMPTY_FORM: FormState = {
  fullName: '',
  nickname: '',
  nationalId: '',
  phone: '',
  email: '',
  school: '',
  province: '',
  grade: '',
  gradeOther: '',
  shirtSize: '',
  motivation: '',
};

export const MOCK_FORM: FormState = {
  fullName: 'สมชาย ทดสอบระบบ',
  nickname: 'ชาย',
  nationalId: '1103701234512',
  phone: '0812345678',
  email: 'somchai.test@example.com',
  school: 'โรงเรียนเชียงใหม่วิทยาคม',
  province: 'เชียงใหม่',
  grade: 'ม.5',
  gradeOther: '',
  shirtSize: 'L',
  motivation: 'สนใจการต่อวงจรเซนเซอร์และพัฒนา IoT Dashboard ผ่านบอร์ด ESP8266 ในค่าย ComCamp #25',
};

export type FieldKey = keyof FormState | 'consent';
export type FieldErrors = Partial<Record<FieldKey, string>>;

export interface StepMeta {
  /** Short name used in the sidebar / mobile progress. */
  label: string;
  /** Heading shown beside the step number. */
  title: string;
  lead: string;
  fields: FieldKey[];
}

export const STEPS: StepMeta[] = [
  {
    label: 'ข้อมูลผู้สมัคร',
    title: 'ข้อมูลผู้สมัคร',
    lead: 'ข้อมูลนี้ใช้ออกรหัสใบสมัครและติดต่อประสานงานกับผู้สมัคร',
    fields: ['fullName', 'nickname', 'nationalId', 'phone', 'email'],
  },
  {
    label: 'ข้อมูลการศึกษา',
    title: 'ข้อมูลการศึกษา',
    lead: 'บอกเราว่าน้องเรียนอยู่ที่ไหนและอยู่ระดับชั้นใด',
    fields: ['school', 'province', 'grade', 'gradeOther'],
  },
  {
    label: 'เสื้อค่าย',
    title: 'เสื้อค่าย',
    lead: 'เลือกไซส์เสื้อค่ายโดยดูรอบอกจากตารางด้านล่าง',
    fields: ['shirtSize'],
  },
  {
    label: 'แรงบันดาลใจ',
    title: 'แรงบันดาลใจ',
    lead: 'เล่าสั้น ๆ ว่าสนใจ IoT หรือไมโครคอนโทรลเลอร์ในด้านไหน (ไม่บังคับ)',
    fields: ['motivation'],
  },
  {
    label: 'ตรวจทานและยืนยัน',
    title: 'ตรวจทานและยืนยัน',
    lead: 'ตรวจข้อมูลทั้งหมดอีกครั้งก่อนส่งใบสมัคร',
    fields: ['consent'],
  },
];

/** Step 6 — shown after a successful submit. Not navigable. */
export const RECEIPT_META = { label: 'ชำระเงิน', title: 'รับใบสมัครแล้ว' } as const;

export const LAST_FORM_STEP = STEPS.length - 1; // 4
export const RECEIPT_STEP = STEPS.length; // 5
export const TOTAL_STEPS = STEPS.length + 1; // 6

export const pad2 = (n: number) => String(n).padStart(2, '0');

/* ───────────────────────── Validation ───────────────────────── */

const onlyDigits = (s: string) => s.replace(/\D/g, '');

/** 13 digits whose last digit is the Thai Mod-11 check digit (mirrors the Go backend). */
export function isValidThaiNationalID(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

export function validateField(key: FieldKey, form: FormState, consent: boolean): string | undefined {
  switch (key) {
    case 'fullName':
      return form.fullName.trim() ? undefined : 'กรุณากรอกชื่อและนามสกุล';
    case 'nickname':
      return form.nickname.trim() ? undefined : 'กรุณากรอกชื่อเล่น';
    case 'nationalId': {
      const id = onlyDigits(form.nationalId);
      if (id.length === 0) return 'กรุณากรอกเลขบัตรประชาชน 13 หลัก';
      if (id.length !== 13) return `เลขบัตรประชาชนต้องมี 13 หลัก (ตอนนี้กรอกไว้ ${id.length} หลัก)`;
      return isValidThaiNationalID(id)
        ? undefined
        : 'เลข 13 หลักไม่สัมพันธ์กันตามรหัสตรวจสอบบนบัตร (อาจพิมพ์ผิดหรือสลับหลัก กรุณาเทียบทีละกลุ่มอีกครั้ง)';
    }
    case 'phone': {
      const p = onlyDigits(form.phone);
      if (!p) return 'กรุณากรอกเบอร์โทรศัพท์มือถือ 10 หลัก';
      return /^0\d{9}$/.test(p) ? undefined : 'เบอร์โทรต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
    }
    case 'email': {
      const e = form.email.trim();
      return !e || /^\S+@\S+\.\S+$/.test(e) ? undefined : 'รูปแบบอีเมลไม่ถูกต้อง เช่น name@example.com';
    }
    case 'school':
      return form.school.trim() ? undefined : 'กรุณากรอกชื่อโรงเรียนหรือสถานศึกษา';
    case 'province':
      return form.province.trim() ? undefined : 'กรุณากรอกจังหวัด';
    case 'grade':
      return (GRADES as readonly string[]).includes(form.grade) || form.grade === GRADE_OTHER ? undefined : 'กรุณาเลือกระดับชั้น';
    case 'gradeOther':
      if (form.grade !== GRADE_OTHER) return undefined;
      if (!form.gradeOther.trim()) return 'กรุณาระบุระดับชั้นของคุณ';
      return form.gradeOther.trim().length > GRADE_OTHER_MAX ? `ระบุได้ไม่เกิน ${GRADE_OTHER_MAX} ตัวอักษร` : undefined;
    case 'shirtSize':
      return form.shirtSize ? undefined : 'กรุณาเลือกไซส์เสื้อ';
    case 'consent':
      return consent ? undefined : 'กรุณาติ๊กยอมรับเงื่อนไขการใช้ข้อมูลก่อนส่งใบสมัคร';
    default:
      return undefined; // motivation is optional
  }
}

export function validateStep(step: number, form: FormState, consent: boolean): FieldErrors {
  const errors: FieldErrors = {};
  for (const key of STEPS[step].fields) {
    const message = validateField(key, form, consent);
    if (message) errors[key] = message;
  }
  return errors;
}

export const firstErrorKey = (step: number, errors: FieldErrors): FieldKey | undefined =>
  STEPS[step].fields.find((k) => errors[k]);

/* ───────────────────────── Display formatting ───────────────────────── */

export function formatNationalId(v: string): string {
  const d = onlyDigits(v);
  if (d.length !== 13) return d;
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}

export function formatPhone(v: string): string {
  const d = onlyDigits(v);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}
