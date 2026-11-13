import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  ApiHttpError,
  sanitizeDigits,
  stripZeroWidth,
  updateApplicantProfile,
  type AdminProfilePayload,
  type Application,
  type ShirtSize,
} from '../lib/api';
import {
  GRADES,
  GRADE_OTHER,
  GRADE_OTHER_MAX,
  SHIRT_SIZES,
  gradeValue,
  isValidThaiNationalID,
  splitGrade,
  validateGradeFields,
} from './register/model';
import { BTN_DARK, BTN_DARK_TEXT, DANGER, FOCUS, INK, INK_2, INK_3, INPUT_BASE, INPUT_BORDER, RULE } from './admin-ui';

interface Form {
  fullName: string;
  nickname: string;
  nationalId: string;
  phone: string;
  email: string;
  school: string;
  province: string;
  grade: string;
  gradeOther: string;
  shirtSize: ShirtSize | '';
  motivation: string;
  reason: string;
}

type Errors = Partial<Record<keyof Form, string>>;

const ORDER: (keyof Form)[] = [
  'fullName',
  'nickname',
  'nationalId',
  'phone',
  'email',
  'school',
  'province',
  'grade',
  'gradeOther',
  'shirtSize',
  'motivation',
  'reason',
];

function initialForm(a: Application): Form {
  return {
    fullName: a.fullName,
    nickname: a.nickname ?? '',
    nationalId: a.nationalId,
    phone: a.phone,
    email: a.email ?? '',
    school: a.school,
    province: a.province ?? '',
    ...splitGrade(a.grade),
    shirtSize: a.shirtSize,
    motivation: a.motivation ?? '',
    reason: '',
  };
}

function cleanSingleLine(s: string): string {
  return stripZeroWidth(s).trim().replace(/\s+/g, ' ');
}

/** Same rules as the backend (shared normalisation and validation), so mistakes show per field. */
function validate(f: Form): Errors {
  const e: Errors = {};
  const fullName = cleanSingleLine(f.fullName);
  if (!fullName) {
    e.fullName = 'กรุณากรอกชื่อ-นามสกุล';
  } else {
    const spaceIdx = fullName.indexOf(' ');
    const first = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
    const last = spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1).trim();
    if (first.length > 100 || last.length > 100 || fullName.length > 201) {
      e.fullName = 'ชื่อหรือนามสกุลยาวเกิน 100 ตัวอักษร';
    }
  }

  const nickname = cleanSingleLine(f.nickname);
  if (!nickname) e.nickname = 'กรุณากรอกชื่อเล่น';
  else if (nickname.length > 50) e.nickname = 'ชื่อเล่นยาวได้ไม่เกิน 50 ตัวอักษร';

  const nid = sanitizeDigits(f.nationalId);
  if (nid.length !== 13) e.nationalId = `เลขบัตรประชาชนต้องมี 13 หลัก (ตอนนี้ ${nid.length} หลัก)`;
  else if (!isValidThaiNationalID(nid)) e.nationalId = 'เลขบัตรประชาชนไม่ผ่านการตรวจเลขตรวจสอบ (Mod-11)';

  if (!/^0\d{9}$/.test(sanitizeDigits(f.phone))) e.phone = 'เบอร์โทรต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
  const email = stripZeroWidth(f.email).replace(/\s+/g, '');
  if (email && (email.length > 150 || !/^\S+@\S+\.\S+$/.test(email))) {
    e.email = email.length > 150 ? 'อีเมลยาวได้ไม่เกิน 150 ตัวอักษร' : 'รูปแบบอีเมลไม่ถูกต้อง (เว้นว่างได้)';
  }

  const school = cleanSingleLine(f.school);
  if (!school) e.school = 'กรุณากรอกโรงเรียนหรือสถานศึกษา';
  else if (school.length > 150) e.school = 'ชื่อโรงเรียนยาวได้ไม่เกิน 150 ตัวอักษร';

  const province = cleanSingleLine(f.province);
  if (!province) e.province = 'กรุณากรอกจังหวัด';
  else if (province.length > 100) e.province = 'ชื่อจังหวัดยาวได้ไม่เกิน 100 ตัวอักษร';

  const g = validateGradeFields(f.grade, cleanSingleLine(f.gradeOther));
  if (g) e[f.grade === GRADE_OTHER ? 'gradeOther' : 'grade'] = g;
  if (!f.shirtSize) e.shirtSize = 'กรุณาเลือกไซส์เสื้อ';
  if (stripZeroWidth(f.motivation).trim().length > 2000) e.motivation = 'เหตุผลการสมัครยาวได้ไม่เกิน 2,000 ตัวอักษร';
  if (stripZeroWidth(f.reason).trim().length > 500) e.reason = 'เหตุผลการแก้ไขยาวได้ไม่เกิน 500 ตัวอักษร';
  return e;
}

/** The server messages are developer English; staff get the Thai explanation. */
function describeSaveError(err: unknown): string {
  if (err instanceof ApiHttpError) {
    if (err.code === 'DUPLICATE_APPLICATION' || err.status === 409) {
      return 'เลขบัตรประชาชน เบอร์โทร หรืออีเมลนี้ซ้ำกับผู้สมัครคนอื่นที่ยังอยู่ในระบบ กรุณาตรวจสอบอีกครั้ง';
    }
    if (err.status === 404) return 'ไม่พบใบสมัครนี้ในระบบ อาจถูกลบไปแล้ว กรุณากดรีเฟรชรายการ';
    if (err.status === 413) return 'ข้อมูลที่ส่งใหญ่เกินไป กรุณาลดความยาวเหตุผลการสมัคร';
    if (err.status === 429) {
      return err.retryAfterSeconds
        ? `ทำรายการถี่เกินไป กรุณารอ ${err.retryAfterSeconds} วินาที แล้วลองใหม่`
        : 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
    if (err.status === 400) {
      const m = err.message.toLowerCase();
      if (m.includes('national id')) return 'เลขบัตรประชาชนไม่ถูกต้อง ต้องมี 13 หลักและผ่านการตรวจเลขตรวจสอบ';
      if (m.includes('phone')) return 'เบอร์โทรไม่ถูกต้อง ต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
      if (m.includes('email')) return 'รูปแบบอีเมลไม่ถูกต้อง';
      if (m.includes('shirt')) return 'ไซส์เสื้อไม่ถูกต้อง';
      if (m.includes('grade')) return 'ระดับชั้นไม่ถูกต้อง';
      if (m.includes('required')) return 'กรุณากรอกช่องที่จำเป็นให้ครบ';
      if (m.includes('too long')) return 'มีข้อความยาวเกินกำหนด';
      return 'ข้อมูลที่ส่งไม่ถูกต้องตามเงื่อนไข';
    }
    if (err.status >= 500) return 'ระบบเซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง';
  }
  return 'บันทึกไม่สำเร็จ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ตแล้วลองอีกครั้ง';
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold" style={{ color: INK }}>
        {label}
        {hint && (
          <span className="ml-2 font-normal" style={{ color: INK_3 }}>
            {hint}
          </span>
        )}
      </label>
      {children}
      {error && (
        <p id={`${id}-err`} className="mt-1.5 flex items-start gap-1.5 text-sm leading-6" style={{ color: DANGER }}>
          <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Inline staff editor under a ledger row (same pattern as the slip panel). Staff may change any
 * field, including identifiers; the server validates the whole record, answers 409 for a national
 * ID / phone / email that belongs to another live applicant, and writes the old -> new values to
 * the audit log together with the reason typed here.
 */
export function AdminProfileEditor({
  app,
  token,
  onSaved,
  onClose,
  onAuthError,
}: {
  app: Application;
  token: string;
  onSaved: (updated: Application) => void;
  onClose: () => void;
  /** Returns true when the error was an expired session (the parent then shows the login form). */
  onAuthError: (err: unknown) => boolean;
}) {
  const [form, setForm] = useState<Form>(() => initialForm(app));
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const pid = `pe-${app.id}`;

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const found = validate(form);
    setErrors(found);
    setServerError(null);
    const bad = ORDER.find((k) => found[k]);
    if (bad) {
      document.getElementById(`${pid}-${bad}`)?.focus();
      return;
    }

    const payload: AdminProfilePayload = {
      fullName: cleanSingleLine(form.fullName),
      nickname: cleanSingleLine(form.nickname),
      nationalId: sanitizeDigits(form.nationalId),
      phone: sanitizeDigits(form.phone),
      email: stripZeroWidth(form.email).replace(/\s+/g, ''),
      school: cleanSingleLine(form.school),
      province: cleanSingleLine(form.province),
      grade: gradeValue({ grade: form.grade, gradeOther: cleanSingleLine(form.gradeOther) }),
      shirtSize: form.shirtSize as ShirtSize,
      motivation: stripZeroWidth(form.motivation).trim(),
      reason: stripZeroWidth(form.reason).trim() || undefined,
    };
    setSaving(true);
    try {
      const res = await updateApplicantProfile(token, app.id, payload);
      onSaved(res.data);
    } catch (err) {
      if (onAuthError(err)) return;
      setServerError(describeSaveError(err));
    } finally {
      setSaving(false);
    }
  }

  const input = (key: keyof Form, extra: Record<string, unknown> = {}) => ({
    id: `${pid}-${key}`,
    value: form[key] as string,
    onChange: (ev: { target: { value: string } }) => set(key, ev.target.value as never),
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `${pid}-${key}-err` : undefined,
    className: `${INPUT_BASE} rounded-xl`,
    style: { borderColor: INPUT_BORDER, color: INK },
    ...extra,
  });

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      role="region"
      aria-label={`แก้ไขข้อมูล ${app.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (!saving) onClose();
        }
      }}
      className="border-t py-6"
      style={{ borderColor: RULE }}
    >
      <h2 className="text-lg font-bold leading-[1.35]" style={{ color: INK }}>
        แก้ไขข้อมูลผู้สมัคร
      </h2>
      <p className="mt-1 max-w-[62ch] text-sm leading-7" style={{ color: INK_3 }}>
        พี่ค่ายแก้ไขได้ทุกช่อง รวมถึงเลขบัตรประชาชน เบอร์โทร และอีเมล ระบบตรวจสอบข้อมูลเหมือนตอนสมัคร และบันทึกค่าเก่า → ค่าใหม่พร้อมเหตุผลลงประวัติการใช้งาน
      </p>

      <div className="mt-5 grid gap-x-6 gap-y-4 md:grid-cols-2">
        <Field id={`${pid}-fullName`} label="ชื่อ-นามสกุล" error={errors.fullName}>
          <input {...input('fullName', { ref: firstRef, autoComplete: 'off' })} />
        </Field>
        <Field id={`${pid}-nickname`} label="ชื่อเล่น" error={errors.nickname}>
          <input {...input('nickname', { autoComplete: 'off' })} />
        </Field>
        <Field id={`${pid}-nationalId`} label="เลขบัตรประชาชน" hint="13 หลัก" error={errors.nationalId}>
          <input {...input('nationalId', { inputMode: 'numeric', autoComplete: 'off', spellCheck: false, className: `${INPUT_BASE} rounded-xl font-mono tabular-nums` })} />
        </Field>
        <Field id={`${pid}-phone`} label="เบอร์โทรศัพท์" hint="10 หลัก" error={errors.phone}>
          <input {...input('phone', { type: 'tel', inputMode: 'tel', autoComplete: 'off', className: `${INPUT_BASE} rounded-xl font-mono tabular-nums` })} />
        </Field>
        <div className="md:col-span-2">
          <Field id={`${pid}-email`} label="อีเมล" hint="เว้นว่างเพื่อลบ" error={errors.email}>
            <input {...input('email', { type: 'email', inputMode: 'email', autoComplete: 'off' })} />
          </Field>
        </div>
        <Field id={`${pid}-school`} label="โรงเรียน / สถานศึกษา" error={errors.school}>
          <input {...input('school')} />
        </Field>
        <Field id={`${pid}-province`} label="จังหวัด" error={errors.province}>
          <input {...input('province')} />
        </Field>
        <Field id={`${pid}-grade`} label="ระดับชั้น" error={errors.grade}>
          <select {...input('grade', { style: { borderColor: INPUT_BORDER, color: INK, colorScheme: 'inherit' } })}>
            <option value="" disabled>
              เลือกระดับชั้น
            </option>
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
            <option value={GRADE_OTHER}>{GRADE_OTHER} (ระบุเอง)</option>
          </select>
        </Field>
        <Field id={`${pid}-shirtSize`} label="ไซส์เสื้อ" error={errors.shirtSize}>
          <select {...input('shirtSize', { style: { borderColor: INPUT_BORDER, color: INK, colorScheme: 'inherit' } })}>
            <option value="" disabled>
              เลือกไซส์เสื้อ
            </option>
            {SHIRT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        {form.grade === GRADE_OTHER && (
          <div className="md:col-span-2">
            <Field id={`${pid}-gradeOther`} label="ระบุระดับชั้น" hint={`ไม่เกิน ${GRADE_OTHER_MAX} ตัวอักษร`} error={errors.gradeOther}>
              <input {...input('gradeOther', { placeholder: 'เช่น ปวส.1' })} />
            </Field>
          </div>
        )}
        <div className="md:col-span-2">
          <Field id={`${pid}-motivation`} label="เหตุผลการสมัคร" hint="ไม่บังคับ" error={errors.motivation}>
            <textarea {...input('motivation', { rows: 3 })} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field id={`${pid}-reason`} label="เหตุผลการแก้ไข" hint="บันทึกในประวัติ แนะนำให้ระบุ" error={errors.reason}>
            <input {...input('reason', { placeholder: 'เช่น ผู้ปกครองแจ้งแก้ไขเลขบัตร' })} />
          </Field>
        </div>
      </div>

      {serverError && (
        <p role="alert" className="mt-5 flex items-start gap-1.5 text-sm leading-7" style={{ color: INK }}>
          <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1.5 shrink-0" style={{ color: DANGER }} />
          <span>{serverError}</span>
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          aria-busy={saving || undefined}
          className={`inline-flex min-h-11 items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
          style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
        >
          {saving ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2.5 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
          style={{ color: INK_2 }}
        >
          ปิด
        </button>
      </div>
      <p className="mt-4 text-xs leading-6" style={{ color: INK_3 }}>
        กด Esc เพื่อปิดหน้าแก้ไข
      </p>
    </form>
  );
}
