import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import {
  ApiHttpError,
  REFERRAL_GROUPS,
  REFERRAL_OTHER_MAX,
  sanitizeDigits,
  stripZeroWidth,
  updateApplicantProfile,
  type AdminProfilePayload,
  type Application,
  type ReferralCode,
  type ShirtSize,
} from '../lib/api';
import { normalizeReferralCodes } from '../lib/applicant-tools';
import {
  ALLERGIES_MAX,
  GRADES,
  GRADE_OTHER,
  GRADE_OTHER_MAX,
  MEDICAL_CONDITIONS_MAX,
  MOTIVATION_MAX,
  NICKNAME_MAX,
  SHIRT_SIZES,
  SIZE_CHEST,
  SIZE_LENGTH,
  gradeValue,
  splitGrade,
  validateGradeFields,
} from './register/model';
import { canonicalProvince } from '../lib/provinces';
import { ProvinceCombobox } from './ProvinceCombobox';
import {
  BG_CARD,
  BTN_DARK,
  BTN_DARK_TEXT,
  DANGER,
  FOCUS,
  INK,
  INK_2,
  INK_3,
  INPUT_BASE,
  INPUT_BORDER,
  PILL_GHOST,
  RULE,
  SURFACE_SUBTLE,
  WARNING,
} from './admin-ui';

const PARENT_NAME_MAX = 150;
const PARENT_RELATION_MAX = 50;

type ApplicantWithParent = Application & {
  parentName?: string;
  parentRelation?: string;
  parentPhone?: string;
};

interface Form {
  fullName: string;
  nickname: string;
  phone: string;
  email: string;
  parentName: string;
  parentRelation: string;
  parentPhone: string;
  school: string;
  province: string;
  grade: string;
  gradeOther: string;
  shirtSize: ShirtSize | '';
  motivation: string;
  allergies: string;
  medicalConditions: string;
  referralSources: ReferralCode[];
  referralOther: string;
  reason: string;
}

type Errors = Partial<Record<keyof Form, string>>;

const ORDER: (keyof Form)[] = [
  'fullName',
  'nickname',
  'phone',
  'email',
  'parentName',
  'parentRelation',
  'parentPhone',
  'school',
  'province',
  'grade',
  'gradeOther',
  'shirtSize',
  'motivation',
  'allergies',
  'medicalConditions',
  'referralSources',
  'referralOther',
  'reason',
];

function sameReferralList(a: readonly ReferralCode[], b: readonly ReferralCode[]): boolean {
  return a.length === b.length && a.every((code, i) => code === b[i]);
}

function initialForm(a: Application): Form {
  const withParent = a as ApplicantWithParent;
  return {
    fullName: a.fullName,
    nickname: a.nickname ?? '',
    phone: a.phone,
    email: a.email ?? '',
    parentName: withParent.parentName ?? '',
    parentRelation: withParent.parentRelation ?? '',
    parentPhone: withParent.parentPhone ?? '',
    school: a.school,
    province: a.province ?? '',
    ...splitGrade(a.grade),
    shirtSize: a.shirtSize,
    motivation: a.motivation ?? '',
    allergies: a.allergies ?? '',
    medicalConditions: a.medicalConditions ?? '',
    referralSources: normalizeReferralCodes(a.referralSources),
    referralOther: a.referralOther ?? '',
    reason: '',
  };
}

function isFormDirty(form: Form, base: Form): boolean {
  const hasOtherNow = form.referralSources.includes('other');
  const hasOtherBase = base.referralSources.includes('other');
  return ORDER.some((k) => {
    if (k === 'referralSources') {
      return !sameReferralList(form.referralSources, base.referralSources);
    }
    if (k === 'referralOther') {
      if (!hasOtherNow && !hasOtherBase) return false;
      const effectiveForm = hasOtherNow ? form.referralOther : '';
      return effectiveForm !== base.referralOther;
    }
    return form[k] !== base[k];
  });
}

function cleanSingleLine(s: string): string {
  return stripZeroWidth(s).trim().replace(/\s+/g, ' ');
}

/**
 * Same rules as the backend (shared normalisation and validation), so mistakes show per field.
 * `stored` is the record being edited: a province or motivation saved before the official province
 * list and the 1,000-character limit may stay as it is, like on the server.
 */
function validate(f: Form, stored: Form): Errors {
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
  else if (nickname.length > NICKNAME_MAX && nickname !== cleanSingleLine(stored.nickname)) {
    e.nickname = `ชื่อเล่นยาวได้ไม่เกิน ${NICKNAME_MAX} ตัวอักษร`;
  }

  if (!/^0\d{9}$/.test(sanitizeDigits(f.phone))) e.phone = 'เบอร์โทรต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
  const email = stripZeroWidth(f.email).replace(/\s+/g, '');
  if (!email) {
    e.email = 'กรุณากรอกอีเมล (ห้ามเว้นว่าง)';
  } else if (email.length > 150) {
    e.email = 'อีเมลยาวได้ไม่เกิน 150 ตัวอักษร';
  } else {
    const atIdx = email.indexOf('@');
    const domain = atIdx >= 0 ? email.slice(atIdx + 1) : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || domain.startsWith('.') || domain.endsWith('.')) {
      e.email = 'รูปแบบอีเมลไม่ถูกต้อง เช่น name@example.com';
    }
  }

  const parentName = cleanSingleLine(f.parentName);
  if (parentName.length > PARENT_NAME_MAX) {
    e.parentName = `ชื่อ-นามสกุลผู้ปกครองยาวได้ไม่เกิน ${PARENT_NAME_MAX} ตัวอักษร`;
  }

  const parentRelation = cleanSingleLine(f.parentRelation);
  if (parentRelation.length > PARENT_RELATION_MAX) {
    e.parentRelation = `ความสัมพันธ์ผู้ปกครองยาวได้ไม่เกิน ${PARENT_RELATION_MAX} ตัวอักษร`;
  }

  const parentPhoneRaw = stripZeroWidth(f.parentPhone).trim();
  const parentPhone = sanitizeDigits(f.parentPhone);
  if (parentPhoneRaw && !/^0\d{9}$/.test(parentPhone)) {
    e.parentPhone = 'เบอร์โทรผู้ปกครองต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
  }

  const school = cleanSingleLine(f.school);
  if (!school) e.school = 'กรุณากรอกโรงเรียนหรือสถานศึกษา';
  else if (school.length > 150) e.school = 'ชื่อโรงเรียนยาวได้ไม่เกิน 150 ตัวอักษร';

  const province = cleanSingleLine(f.province);
  if (!province) e.province = 'กรุณาเลือกจังหวัด';
  else if (!canonicalProvince(province) && province !== cleanSingleLine(stored.province)) {
    e.province = 'กรุณาเลือกจังหวัดจากรายการ';
  }

  const g = validateGradeFields(f.grade, cleanSingleLine(f.gradeOther));
  if (g) e[f.grade === GRADE_OTHER ? 'gradeOther' : 'grade'] = g;
  if (!f.shirtSize) e.shirtSize = 'กรุณาเลือกไซส์เสื้อ';
  const motivation = stripZeroWidth(f.motivation).trim();
  if (motivation.length > MOTIVATION_MAX && motivation !== stripZeroWidth(stored.motivation).trim()) {
    e.motivation = `เหตุผลการสมัครยาวได้ไม่เกิน ${MOTIVATION_MAX.toLocaleString('th-TH')} ตัวอักษร`;
  }
  if (stripZeroWidth(f.allergies).trim().length > ALLERGIES_MAX) e.allergies = `หมายเหตุการแพ้อาหารยาวได้ไม่เกิน ${ALLERGIES_MAX} ตัวอักษร`;
  if (stripZeroWidth(f.medicalConditions).trim().length > MEDICAL_CONDITIONS_MAX) {
    e.medicalConditions = `หมายเหตุโรคประจำตัวยาวได้ไม่เกิน ${MEDICAL_CONDITIONS_MAX} ตัวอักษร`;
  }
  if (f.referralSources.includes('other')) {
    const refOther = cleanSingleLine(f.referralOther);
    if (!refOther) {
      e.referralOther = 'กรุณาระบุช่องทางอื่นๆ';
    } else if ([...refOther].length > REFERRAL_OTHER_MAX) {
      e.referralOther = `ช่องทางอื่นๆ ยาวได้ไม่เกิน ${REFERRAL_OTHER_MAX} ตัวอักษร`;
    }
  }
  if (stripZeroWidth(f.reason).trim().length > 500) e.reason = 'เหตุผลการแก้ไขยาวได้ไม่เกิน 500 ตัวอักษร';
  return e;
}

/** The server messages are developer English; staff get the Thai explanation. */
function describeSaveError(err: unknown): string {
  if (err instanceof ApiHttpError) {
    if (err.code === 'DUPLICATE_APPLICATION' || err.status === 409) {
      return 'เบอร์โทรหรืออีเมลนี้ซ้ำกับผู้สมัครคนอื่นที่ยังอยู่ในระบบ กรุณาตรวจสอบอีกครั้ง';
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
      if (m.includes('parent phone')) return 'เบอร์โทรผู้ปกครองไม่ถูกต้อง ต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
      if (m.includes('phone')) return 'เบอร์โทรไม่ถูกต้อง ต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
      if (m.includes('email')) return 'รูปแบบอีเมลไม่ถูกต้อง';
      if (m.includes('shirt')) return 'ไซส์เสื้อไม่ถูกต้อง';
      if (m.includes('grade')) return 'ระดับชั้นไม่ถูกต้อง';
      if (m.includes('province')) return 'จังหวัดไม่ถูกต้อง กรุณาเลือกจากรายการ';
      if (m.includes('referral')) return 'ข้อมูลช่องทางที่รู้จักค่ายไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
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
 * field, including the phone and email; the server validates the whole record, answers 409 for a
 * phone / email that belongs to another live applicant, and writes the old -> new values to
 * the audit log together with the reason typed here.
 */
export function AdminProfileEditor({
  app,
  token,
  onSaved,
  onClose,
  onAuthError,
  onDirtyChange,
}: {
  app: Application;
  token: string;
  onSaved: (updated: Application) => void;
  onClose: () => void;
  /** Returns true when the error was an expired session (the parent then shows the login form). */
  onAuthError: (err: unknown) => boolean;
  /** Notifies parent when the editor has unsaved changes so row switches can guard against accidental loss. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const baseForm = useMemo(() => initialForm(app), [app]);
  const [form, setForm] = useState<Form>(() => initialForm(app));
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const pid = `pe-${app.id}`;

  const dirty = useMemo(() => isFormDirty(form, baseForm), [form, baseForm]);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    return () => {
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  useEffect(() => {
    if (confirmDiscard) {
      keepEditingRef.current?.focus();
    }
  }, [confirmDiscard]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    if (confirmDiscard) setConfirmDiscard(false);
  }

  function toggleReferral(code: ReferralCode) {
    setForm((f) => {
      const exists = f.referralSources.includes(code);
      const nextRaw = exists
        ? f.referralSources.filter((c) => c !== code)
        : [...f.referralSources, code];
      return { ...f, referralSources: normalizeReferralCodes(nextRaw) };
    });
    if (code === 'other') {
      setErrors((e) => (e.referralOther ? { ...e, referralOther: undefined } : e));
    }
    if (confirmDiscard) setConfirmDiscard(false);
  }

  function requestClose() {
    if (saving || savingRef.current) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || savingRef.current) return;
    const found = validate(form, baseForm);
    setErrors(found);
    setServerError(null);
    const bad = ORDER.find((k) => found[k]);
    if (bad) {
      document.getElementById(`${pid}-${bad}`)?.focus();
      return;
    }

    const orderedReferrals = normalizeReferralCodes(form.referralSources);
    const baseReferrals = normalizeReferralCodes(baseForm.referralSources);
    const referralsChanged = !sameReferralList(orderedReferrals, baseReferrals);
    const hasOther = orderedReferrals.includes('other');
    const cleanedOther = hasOther ? cleanSingleLine(form.referralOther) : '';
    const storedOther = cleanSingleLine(baseForm.referralOther);
    const shouldSendReferralOther = hasOther
      ? cleanedOther !== storedOther
      : baseForm.referralOther.trim() !== '';

    const payload: AdminProfilePayload = {
      fullName: cleanSingleLine(form.fullName),
      nickname: cleanSingleLine(form.nickname),
      phone: sanitizeDigits(form.phone),
      email: stripZeroWidth(form.email).replace(/\s+/g, ''),
      parentName: cleanSingleLine(form.parentName),
      parentRelation: cleanSingleLine(form.parentRelation),
      parentPhone: sanitizeDigits(form.parentPhone),
      school: cleanSingleLine(form.school),
      province: canonicalProvince(form.province) ?? cleanSingleLine(form.province),
      grade: gradeValue({ grade: form.grade, gradeOther: cleanSingleLine(form.gradeOther) }),
      shirtSize: form.shirtSize as ShirtSize,
      motivation: stripZeroWidth(form.motivation).trim(),
      allergies: stripZeroWidth(form.allergies).trim(),
      medicalConditions: stripZeroWidth(form.medicalConditions).trim(),
      ...(referralsChanged ? { referralSources: orderedReferrals } : {}),
      ...(shouldSendReferralOther ? { referralOther: hasOther ? cleanedOther : '' } : {}),
      reason: stripZeroWidth(form.reason).trim() || undefined,
    };
    savingRef.current = true;
    setSaving(true);
    try {
      const res = await updateApplicantProfile(token, app.id, payload);
      onDirtyChange?.(false);
      onSaved(res.data);
    } catch (err) {
      if (onAuthError(err)) return;
      setServerError(describeSaveError(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const input = (key: keyof Form, extra: Record<string, unknown> = {}) => {
    const extraStyle = (extra.style as Record<string, unknown> | undefined) ?? {};
    const { style: _ignored, ...rest } = extra;
    return {
      id: `${pid}-${key}`,
      value: form[key] as string,
      onChange: (ev: { target: { value: string } }) => set(key, ev.target.value as never),
      'aria-invalid': errors[key] ? true : undefined,
      'aria-describedby': errors[key] ? `${pid}-${key}-err` : undefined,
      className: `${INPUT_BASE} rounded-xl`,
      style: { ...extraStyle, borderColor: errors[key] ? DANGER : INPUT_BORDER, color: INK },
      ...rest,
    };
  };

  return (
    <form
      id={`profile-editor-${app.id}`}
      onSubmit={onSubmit}
      noValidate
      role="region"
      aria-label={`แก้ไขข้อมูล ${app.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (confirmDiscard) {
            setConfirmDiscard(false);
            return;
          }
          requestClose();
        }
      }}
      className="border-t py-6"
      style={{ borderColor: RULE }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold leading-[1.35]" style={{ color: INK }}>
          แก้ไขข้อมูลผู้สมัคร
        </h2>
        {dirty && (
          <span
            className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold"
            style={{ borderColor: WARNING, color: WARNING }}
          >
            มีการแก้ไขที่ยังไม่บันทึก
          </span>
        )}
      </div>
      <p className="mt-1 max-w-[62ch] text-sm leading-7" style={{ color: INK_3 }}>
        พี่ค่ายแก้ไขได้ทุกช่อง รวมถึงเบอร์โทรและอีเมล ระบบตรวจสอบข้อมูลเหมือนตอนสมัคร และบันทึกค่าเก่า → ค่าใหม่พร้อมเหตุผลลงประวัติการใช้งาน
      </p>

      <div className="mt-5 grid gap-x-6 gap-y-4 md:grid-cols-2">
        <Field id={`${pid}-fullName`} label="ชื่อ-นามสกุล" error={errors.fullName}>
          <input {...input('fullName', { ref: firstRef, autoComplete: 'off' })} />
        </Field>
        <Field id={`${pid}-nickname`} label="ชื่อเล่น" error={errors.nickname}>
          <input {...input('nickname', { autoComplete: 'off' })} />
        </Field>
        <Field id={`${pid}-phone`} label="เบอร์โทรศัพท์" hint="10 หลัก" error={errors.phone}>
          <input
            {...input('phone', {
              type: 'tel',
              inputMode: 'tel',
              autoComplete: 'off',
              maxLength: 14,
              className: `${INPUT_BASE} rounded-xl font-mono tabular-nums`,
            })}
          />
        </Field>
        <div>
          <Field id={`${pid}-email`} label="อีเมล" hint="ห้ามเว้นว่าง" error={errors.email}>
            <input {...input('email', { type: 'email', inputMode: 'email', autoComplete: 'off' })} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field id={`${pid}-parentName`} label="ชื่อ-นามสกุลผู้ปกครอง" hint="ไม่บังคับ" error={errors.parentName}>
            <input {...input('parentName', { autoComplete: 'off', maxLength: PARENT_NAME_MAX })} />
          </Field>
        </div>
        <Field id={`${pid}-parentRelation`} label="ความสัมพันธ์ผู้ปกครอง" hint="เช่น บิดา, มารดา" error={errors.parentRelation}>
          <input {...input('parentRelation', { autoComplete: 'off', maxLength: PARENT_RELATION_MAX, placeholder: 'เช่น บิดา, มารดา' })} />
        </Field>
        <Field id={`${pid}-parentPhone`} label="เบอร์โทรศัพท์ผู้ปกครอง" hint="10 หลัก (ไม่บังคับ)" error={errors.parentPhone}>
          <input
            {...input('parentPhone', {
              type: 'tel',
              inputMode: 'tel',
              autoComplete: 'off',
              maxLength: 14,
              placeholder: '08X-XXX-XXXX',
              className: `${INPUT_BASE} rounded-xl font-mono tabular-nums`,
            })}
          />
        </Field>
        <Field id={`${pid}-school`} label="โรงเรียน / สถานศึกษา" error={errors.school}>
          <input {...input('school')} />
        </Field>
        <Field id={`${pid}-province`} label="จังหวัด" error={errors.province}>
          <ProvinceCombobox
            id={`${pid}-province`}
            value={form.province}
            onChange={(v) => set('province', v)}
            invalid={Boolean(errors.province)}
            describedBy={errors.province ? `${pid}-province-err` : undefined}
            className={`${INPUT_BASE} rounded-xl`}
            style={{ borderColor: errors.province ? DANGER : INPUT_BORDER, color: INK }}
          />
        </Field>
        <Field id={`${pid}-grade`} label="ระดับชั้น" error={errors.grade}>
          <select {...input('grade', { style: { colorScheme: 'inherit' } })}>
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
          <select {...input('shirtSize', { style: { colorScheme: 'inherit' } })}>
            <option value="" disabled>
              เลือกไซส์เสื้อ
            </option>
            {SHIRT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} · รอบอก {SIZE_CHEST[s]}&quot; · ยาว {SIZE_LENGTH[s]}&quot;
              </option>
            ))}
          </select>
        </Field>
        {form.grade === GRADE_OTHER && (
          <div className="md:col-span-2">
            <Field id={`${pid}-gradeOther`} label="ระบุระดับชั้น" hint={`ไม่เกิน ${GRADE_OTHER_MAX} ตัวอักษร`} error={errors.gradeOther}>
              <input {...input('gradeOther', { placeholder: 'เช่น ปวส.1', maxLength: GRADE_OTHER_MAX })} />
            </Field>
          </div>
        )}
        <div className="md:col-span-2">
          <Field id={`${pid}-motivation`} label="เหตุผลการสมัคร" hint="ไม่บังคับ" error={errors.motivation}>
            <textarea {...input('motivation', { rows: 3 })} />
          </Field>
        </div>
        <Field id={`${pid}-allergies`} label="การแพ้อาหาร" hint="ไม่บังคับ" error={errors.allergies}>
          <textarea {...input('allergies', { rows: 2, maxLength: ALLERGIES_MAX })} />
        </Field>
        <Field id={`${pid}-medicalConditions`} label="โรคประจำตัว" hint="ไม่บังคับ" error={errors.medicalConditions}>
          <textarea {...input('medicalConditions', { rows: 2, maxLength: MEDICAL_CONDITIONS_MAX })} />
        </Field>
        <fieldset className="border-t pt-4 md:col-span-2" style={{ borderColor: RULE }}>
          <legend className="text-sm font-semibold" style={{ color: INK }}>
            รู้จักค่ายจาก
            <span className="ml-2 font-normal" style={{ color: INK_3 }}>
              ไม่บังคับ (เลือกได้หลายช่องทาง)
            </span>
          </legend>
          <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-3">
            {REFERRAL_GROUPS.map((group) => {
              const single = group.options.length === 1;
              return (
                <div key={group.id} className={single ? 'w-auto' : 'basis-full'}>
                  {!single && (
                    <p className="mb-1.5 text-xs font-semibold leading-5" style={{ color: INK_2 }}>
                      {group.label}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {group.options.map((opt) => {
                      const checked = form.referralSources.includes(opt.code);
                      return (
                        <label
                          key={opt.code}
                          className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-tech)] has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--bg-canvas)] ${checked ? '' : 'hover:bg-[var(--color-btn-ghost-hover)]'}`}
                          style={{
                            backgroundColor: checked ? BTN_DARK : BG_CARD,
                            borderColor: checked ? BTN_DARK : INPUT_BORDER,
                            color: checked ? BTN_DARK_TEXT : INK,
                            fontWeight: checked ? 600 : 500,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleReferral(opt.code)}
                            className="sr-only"
                          />
                          {checked && <Check aria-hidden="true" size={14} strokeWidth={1.5} className="shrink-0" />}
                          <span>{opt.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {form.referralSources.includes('other') && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <label htmlFor={`${pid}-referralOther`} className="text-sm font-semibold" style={{ color: INK }}>
                  ระบุช่องทางอื่นๆ
                </label>
                <span className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                  {[...form.referralOther].length}/{REFERRAL_OTHER_MAX}
                </span>
              </div>
              <input
                {...input('referralOther', {
                  autoComplete: 'off',
                  maxLength: REFERRAL_OTHER_MAX,
                  placeholder: 'เช่น โปสเตอร์โรงเรียน, ไลน์กลุ่ม',
                })}
              />
              {errors.referralOther && (
                <p
                  id={`${pid}-referralOther-err`}
                  className="mt-1.5 flex items-start gap-1.5 text-sm leading-6"
                  style={{ color: DANGER }}
                >
                  <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" />
                  <span>{errors.referralOther}</span>
                </p>
              )}
            </div>
          )}
        </fieldset>
        <div className="md:col-span-2">
          <Field id={`${pid}-reason`} label="เหตุผลการแก้ไข" hint="บันทึกในประวัติ แนะนำให้ระบุ" error={errors.reason}>
            <input {...input('reason', { placeholder: 'เช่น ผู้ปกครองแจ้งแก้ไขเบอร์โทร', maxLength: 500 })} />
          </Field>
        </div>
      </div>

      {serverError && (
        <p role="alert" className="mt-5 flex items-start gap-1.5 text-sm leading-7" style={{ color: INK }}>
          <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1.5 shrink-0" style={{ color: DANGER }} />
          <span>{serverError}</span>
        </p>
      )}

      {confirmDiscard && (
        <div
          role="alertdialog"
          aria-label="ยืนยันการทิ้งการแก้ไข"
          className="mt-5 rounded-xl border p-4"
          style={{ borderColor: WARNING, backgroundColor: SURFACE_SUBTLE }}
        >
          <p className="flex items-start gap-2 text-sm font-semibold leading-6" style={{ color: INK }}>
            <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.75} className="mt-1 shrink-0" style={{ color: WARNING }} />
            <span>มีการแก้ไขข้อมูลที่ยังไม่บันทึก ต้องการทิ้งการแก้ไขและปิดหน้านี้หรือไม่?</span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onDirtyChange?.(false);
                onClose();
              }}
              className={`inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
              style={{ borderColor: DANGER, color: DANGER }}
            >
              ทิ้งการแก้ไขและปิด
            </button>
            <button
              ref={keepEditingRef}
              type="button"
              onClick={() => setConfirmDiscard(false)}
              className={PILL_GHOST}
              style={{ borderColor: RULE, color: INK }}
            >
              กลับไปแก้ไขต่อ
            </button>
          </div>
        </div>
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
          onClick={requestClose}
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
