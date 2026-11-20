/**
 * /register wizard — data model, step definitions and validation.
 * No React in here so the rules stay testable and the component stays thin.
 */
import { stripZeroWidth, type ApplicationPayload, type ShirtSize } from '../../lib/api';
import { canonicalProvince } from '../../lib/provinces';

// Camp facts (seats, fee) live in lib/camp-facts — the one fallback shared with the home page.
// /register and /status read settings.maxCapacity / settings.campFee live; these are offline fallbacks.
import { CAMP_FEE_TEXT } from '../../lib/camp-facts';
export { CAMP_FEE_TEXT, MAX_CAPACITY } from '../../lib/camp-facts';
export const FB_URL = 'https://www.facebook.com/CCCSMJU';
export const LINE_OPENCHAT_URL =
  'https://line.me/ti/g2/SqThbtY8Q_FiT7AA61RNn5LrFsjz9bHjYvmcIQ?utm_source=invitation&utm_medium=QR_code&utm_campaign=default';
export const LINE_OPENCHAT_QR_SRC = '/assets/line-openchat-qr.jpg';
export const DORM_NAME = 'เรือนพักสมาคมศิษย์เก่าแม่โจ้';
export const DORM_MAPS_URL = 'https://maps.app.goo.gl/oKP6J7gn3VXLXn7z7';
export const PROJECT_ADVISOR = 'ผศ.ปวีณ เขื่อนแก้ว';
export const STAFF_CONTACTS = [
  { name: 'นายบูรพา มหัทธีรนางกูร (พูล)', phone: '080-993-8214', tel: '0809938214' },
  { name: 'นางสาวธมล นวลหมวก (แอมมี่)', phone: '063-784-4515', tel: '0637844515' },
] as const;

// The transfer deadline rule lives in lib/payment so it can be unit-tested without the browser.
export {
  PAYMENT_GRACE_HOURS,
  PAYMENT_WINDOW_DAYS,
  PAYMENT_WINDOW_HOURS,
  PAYMENT_WINDOW_MS,
  describeApplicantPaymentDeadline,
  describePaymentDeadline,
  describePaymentDue,
  describeStaffPaymentDeadline,
  paymentDueMs,
  type PaymentDeadlineInfo,
} from '../../lib/payment';

/** Format campFee from PublicSettings into Thai locale text, falling back to CAMP_FEE_TEXT. */
export function formatCampFee(fee: number | string | null | undefined): string {
  if (fee === null || fee === undefined || fee === '') return CAMP_FEE_TEXT;
  const n = typeof fee === 'number' ? fee : Number(fee);
  if (!Number.isFinite(n) || n < 0) return CAMP_FEE_TEXT;
  return n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

export const NAME_PART_MAX = 100;
export const NICKNAME_MAX = 20;
export const EMAIL_MAX = 150;
export const PARENT_NAME_MAX = 150;
export const PARENT_RELATION_MAX = 50;
export const SCHOOL_MAX = 150;
export const MOTIVATION_MAX = 1000;
export const ALLERGIES_MAX = 500;
export const MEDICAL_CONDITIONS_MAX = 500;

export const GRADES = ['ม.4', 'ม.5', 'ม.6', 'ปวช.1', 'ปวช.2', 'ปวช.3'] as const;
/** Title shown before the applicant's name (stored apart from fullName; kept off the public list). */
export const NAME_PREFIXES = ['นาย', 'นางสาว', 'นาง', 'เด็กชาย', 'เด็กหญิง'] as const;
/** Titles an applicant may type into the name box by habit, spelled out or abbreviated. */
const TYPED_PREFIXES = ['นาย', 'นางสาว', 'นาง', 'น.ส', 'นส', 'เด็กชาย', 'เด็กหญิง', 'ด.ช', 'ด.ญ'];
/** Select value for "other"; the applicant then types their own level, which is what gets submitted. */
export const GRADE_OTHER = 'อื่นๆ';
export const GRADE_OTHER_MAX = 20; // grade column is VARCHAR(20)
export const SHIRT_SIZES: ShirtSize[] = ['SSS', 'SS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

/** Official IDO IDEA T-shirt chest circumference (A, inches). */
export const SIZE_CHEST: Record<ShirtSize, number> = {
  SSS: 30,
  SS: 32,
  S: 36,
  M: 40,
  L: 44,
  XL: 48,
  '2XL': 52,
  '3XL': 56,
  '4XL': 60,
};

/** Official IDO IDEA T-shirt length (B, inches). */
export const SIZE_LENGTH: Record<ShirtSize, number> = {
  SSS: 25,
  SS: 26,
  S: 27,
  M: 28,
  L: 29,
  XL: 30,
  '2XL': 32,
  '3XL': 33,
  '4XL': 34,
};

export const DIETARY_QUICK_OPTIONS = [
  'ไม่ทานหมู',
  'อาหารฮาลาล (อิสลาม)',
  'มังสวิรัติ',
  'แพ้อาหารทะเล',
  'แพ้ถั่ว / นมวัว',
] as const;

/** Wizard form state. Selects start empty so nothing is submitted by accident. */
export interface FormState
  extends Omit<
    ApplicationPayload,
    'prefix' | 'shirtSize' | 'province' | 'allergies' | 'medicalConditions' | 'parentName' | 'parentRelation' | 'parentPhone'
  > {
  prefix: string;
  shirtSize: ShirtSize | '';
  province: string;
  allergies: string;
  medicalConditions: string;
  parentName: string;
  parentRelation: string;
  parentPhone: string;
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
  const text = cleanSingleLine(gradeOther);
  if (text.length < 2) return 'กรุณาระบุระดับชั้นของคุณ (อย่างน้อย 2 ตัวอักษร)';
  if (text.length > GRADE_OTHER_MAX) return `ระบุได้ไม่เกิน ${GRADE_OTHER_MAX} ตัวอักษร`;
  if (text === GRADE_OTHER) return 'กรุณาระบุชื่อระดับชั้นของคุณให้ชัดเจน';
  if (/[\u0000-\u001F\u007F]/.test(text)) return 'ระดับชั้นต้องไม่มีอักขระควบคุม';
  return undefined;
}

/** The grade string the API receives. */
export const gradeValue = (f: Pick<FormState, 'grade' | 'gradeOther'>) =>
  f.grade === GRADE_OTHER ? cleanSingleLine(f.gradeOther) : f.grade;

export const EMPTY_FORM: FormState = {
  prefix: '',
  fullName: '',
  nickname: '',
  phone: '',
  email: '',
  parentName: '',
  parentRelation: '',
  parentPhone: '',
  school: '',
  province: '',
  grade: '',
  gradeOther: '',
  shirtSize: '',
  motivation: '',
  allergies: '',
  medicalConditions: '',
};

export const MOCK_FORM: FormState = {
  prefix: 'นาย',
  fullName: 'สมชาย ทดสอบระบบ',
  nickname: 'ชาย',
  phone: '0812345678',
  email: 'somchai.test@example.com',
  parentName: 'สมศรี ทดสอบระบบ',
  parentRelation: 'มารดา',
  parentPhone: '0898765432',
  school: 'โรงเรียนเชียงใหม่วิทยาคม',
  province: 'เชียงใหม่',
  grade: 'ม.5',
  gradeOther: '',
  shirtSize: 'L',
  motivation: 'สนใจการต่อวงจรเซนเซอร์และพัฒนา IoT Dashboard ผ่านบอร์ด ESP8266 ในค่าย ComCamp #25',
  allergies: 'แพ้อาหารทะเล',
  medicalConditions: '',
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
    lead: 'กรอกให้ครบทุกช่อง · ใช้ออกรหัสใบสมัครและติดต่อประสานงานกับผู้สมัครและผู้ปกครอง',
    fields: ['prefix', 'fullName', 'nickname', 'phone', 'email', 'parentName', 'parentRelation', 'parentPhone'],
  },
  {
    label: 'ข้อมูลการศึกษา',
    title: 'ข้อมูลการศึกษา',
    lead: 'กรอกให้ครบทุกช่อง · บอกเราว่าน้องเรียนอยู่ที่ไหนและอยู่ระดับชั้นใด',
    fields: ['school', 'province', 'grade', 'gradeOther'],
  },
  {
    label: 'ไซส์เสื้อค่าย',
    title: 'เลือกไซส์เสื้อค่าย',
    lead: 'ผู้เข้าร่วมค่ายทุกคนจะได้รับเสื้อค่าย ComCamp #25 คนละ 1 ตัว กรุณาเทียบขนาดรอบอกและความยาวเสื้อก่อนเลือก',
    fields: ['shirtSize'],
  },
  {
    label: 'หมายเหตุและสุขภาพ',
    title: 'แรงบันดาลใจและหมายเหตุสุขภาพ',
    lead: 'ข้อมูลทั้งหมดในขั้นตอนนี้ไม่บังคับ ใช้เตรียมอาหารและการดูแลสุขภาพให้ปลอดภัย (ไม่บันทึกลงเครื่องตาม PDPA)',
    fields: ['motivation', 'allergies', 'medicalConditions'],
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

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

export function normalizeThaiDigits(s: string): string {
  return s.replace(/[๐-๙]/g, (c) => String(THAI_DIGITS.indexOf(c)));
}

export const onlyDigits = (s: string) => normalizeThaiDigits(s).replace(/\D/g, '');

export function cleanSingleLine(s: string): string {
  return stripZeroWidth(s).trim().replace(/\s+/g, ' ');
}

export function validateField(key: FieldKey, form: FormState, consent: boolean): string | undefined {
  switch (key) {
    case 'prefix':
      return (NAME_PREFIXES as readonly string[]).includes(form.prefix) ? undefined : 'กรุณาเลือกคำนำหน้าชื่อ';
    case 'fullName': {
      const full = cleanSingleLine(form.fullName);
      if (!full) return 'กรุณากรอกชื่อและนามสกุล';
      const spaceIdx = full.indexOf(' ');
      if (spaceIdx === -1) {
        return 'กรุณากรอกทั้งชื่อจริงและนามสกุล โดยมีเว้นวรรคคั่น (เช่น สมชาย ใจดี)';
      }
      const first = full.slice(0, spaceIdx);
      const last = full.slice(spaceIdx + 1).trim();
      if (!first || !last) {
        return 'กรุณากรอกทั้งชื่อจริงและนามสกุล โดยมีเว้นวรรคคั่น (เช่น สมชาย ใจดี)';
      }
      if (TYPED_PREFIXES.includes(first.replace(/\.$/, ''))) {
        return 'เลือกคำนำหน้าที่ช่อง “คำนำหน้า” แล้วกรอกเฉพาะชื่อจริงและนามสกุลในช่องนี้ (เช่น สมชาย ใจดี)';
      }
      if (first.length > NAME_PART_MAX || last.length > NAME_PART_MAX) {
        return `ชื่อและนามสกุลแต่ละส่วนต้องยาวไม่เกิน ${NAME_PART_MAX} ตัวอักษร`;
      }
      return undefined;
    }
    case 'nickname': {
      const n = cleanSingleLine(form.nickname);
      if (!n) return 'กรุณากรอกชื่อเล่น';
      return n.length > NICKNAME_MAX ? `ชื่อเล่นต้องยาวไม่เกิน ${NICKNAME_MAX} ตัวอักษร` : undefined;
    }
    case 'phone': {
      const p = onlyDigits(form.phone);
      if (!p) return 'กรุณากรอกเบอร์โทรศัพท์มือถือ 10 หลัก';
      return /^0\d{9}$/.test(p) ? undefined : 'เบอร์โทรต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
    }
    case 'email': {
      const e = stripZeroWidth(form.email).replace(/\s+/g, '');
      if (!e) return 'กรุณากรอกอีเมลสำหรับรับหลักฐานการสมัครและแจ้งผลยืนยันสิทธิ์';
      if (e.length > EMAIL_MAX) return `อีเมลต้องยาวไม่เกิน ${EMAIL_MAX} ตัวอักษร`;
      const atIdx = e.indexOf('@');
      const local = atIdx >= 0 ? e.slice(0, atIdx) : '';
      const domain = atIdx >= 0 ? e.slice(atIdx + 1) : '';
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ||
        e.includes('..') ||
        local.startsWith('.') ||
        local.endsWith('.') ||
        domain.startsWith('.') ||
        domain.endsWith('.')
      ) {
        return 'รูปแบบอีเมลไม่ถูกต้อง เช่น name@example.com';
      }
      return undefined;
    }
    case 'parentName': {
      const pn = cleanSingleLine(form.parentName);
      if (!pn) return 'กรุณากรอกชื่อ-นามสกุลผู้ปกครอง';
      return pn.length > PARENT_NAME_MAX ? `ชื่อผู้ปกครองต้องยาวไม่เกิน ${PARENT_NAME_MAX} ตัวอักษร` : undefined;
    }
    case 'parentRelation': {
      const pr = cleanSingleLine(form.parentRelation);
      if (!pr) return 'กรุณาระบุความสัมพันธ์ของผู้ปกครอง (เช่น บิดา, มารดา)';
      return pr.length > PARENT_RELATION_MAX ? `ความสัมพันธ์ต้องยาวไม่เกิน ${PARENT_RELATION_MAX} ตัวอักษร` : undefined;
    }
    case 'parentPhone': {
      const pp = onlyDigits(form.parentPhone);
      if (!pp) return 'กรุณากรอกเบอร์โทรศัพท์ผู้ปกครอง 10 หลัก';
      return /^0\d{9}$/.test(pp) ? undefined : 'เบอร์โทรผู้ปกครองต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
    }
    case 'school': {
      const s = cleanSingleLine(form.school);
      if (!s) return 'กรุณากรอกชื่อโรงเรียนหรือสถานศึกษา';
      return s.length > SCHOOL_MAX ? `ชื่อโรงเรียนต้องยาวไม่เกิน ${SCHOOL_MAX} ตัวอักษร` : undefined;
    }
    case 'province': {
      const p = cleanSingleLine(form.province);
      if (!p) return 'กรุณาเลือกจังหวัด';
      return canonicalProvince(p) ? undefined : 'กรุณาเลือกจังหวัดจากรายการ';
    }
    case 'grade':
      return (GRADES as readonly string[]).includes(form.grade) || form.grade === GRADE_OTHER ? undefined : 'กรุณาเลือกระดับชั้น';
    case 'gradeOther':
      if (form.grade !== GRADE_OTHER) return undefined;
      return validateGradeFields(form.grade, form.gradeOther);
    case 'shirtSize':
      return form.shirtSize ? undefined : 'กรุณาเลือกไซส์เสื้อ';
    case 'motivation': {
      const m = stripZeroWidth(form.motivation).trim();
      return m.length > MOTIVATION_MAX ? `ความยาวต้องไม่เกิน ${MOTIVATION_MAX.toLocaleString('th-TH')} ตัวอักษร` : undefined;
    }
    case 'allergies': {
      const a = stripZeroWidth(form.allergies).trim();
      return a.length > ALLERGIES_MAX ? `ความยาวต้องไม่เกิน ${ALLERGIES_MAX.toLocaleString('th-TH')} ตัวอักษร` : undefined;
    }
    case 'medicalConditions': {
      const mc = stripZeroWidth(form.medicalConditions).trim();
      return mc.length > MEDICAL_CONDITIONS_MAX ? `ความยาวต้องไม่เกิน ${MEDICAL_CONDITIONS_MAX.toLocaleString('th-TH')} ตัวอักษร` : undefined;
    }
    case 'consent':
      return consent ? undefined : 'กรุณาติ๊กยอมรับเงื่อนไขการใช้ข้อมูลก่อนส่งใบสมัคร';
    default:
      return undefined;
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

export function formatPhone(v: string): string {
  const d = onlyDigits(v);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}
