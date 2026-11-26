import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Eye, Pencil, Plus, Printer, RotateCw, Save, Trash2, TriangleAlert, X } from 'lucide-react';
import {
  SPONSOR_ADDRESS_LINE_MAX,
  SPONSOR_AREA_MAX,
  SPONSOR_FILE_LABELS,
  SPONSOR_FILE_MAX_BYTES,
  SPONSOR_FILE_TYPES,
  SPONSOR_KIND_LABELS,
  createSponsorDonation,
  deleteSponsorDonation,
  deleteSponsorDonationFile,
  fetchSponsorDonationFile,
  fetchSponsorDonations,
  normalizeThaiDigits,
  sanitizeDigits,
  stripZeroWidth,
  updateSponsorDonation,
  uploadSponsorDonationFile,
  type SponsorDonation,
  type SponsorDonationInput,
  type SponsorFileKind,
  type SponsorKind,
} from '../../lib/api';
import { canonicalProvince } from '../../lib/provinces';
import {
  formatThaiAddress,
  formatThaiTaxId,
  isValidPostcode,
  isValidThaiTaxId,
  normalizePostcode,
  normalizeThaiTaxId,
} from '../../lib/thai-tax-id';
import { ProvinceCombobox } from '../ProvinceCombobox';
import {
  BTN_DARK,
  BTN_DARK_TEXT,
  DANGER,
  FOCUS,
  INK,
  INK_2,
  INK_3,
  INPUT_BASE,
  INPUT_BORDER,
  PILL_DANGER,
  PILL_GHOST,
  RULE,
  SUCCESS,
  SURFACE_SUBTLE,
  WARNING,
} from '../admin-ui';
import { SponsorFormPrint, type PrintableDonation } from './SponsorFormPrint';
import { FileDropzone } from './ui/FileDropzone';
import { RevealPanel } from './ui/RevealPanel';
import { StatefulButton } from './ui/StatefulButton';
import { EXPAND, useDoneSignal } from './ui/motion';
import {
  CONTROL_CHARS,
  NoticeBanner,
  UNKNOWN_ERROR,
  focusLater,
  formatAmount,
  formatPhone,
  formatBangkokDateTime,
  formatSatang,
  formatYmdShort,
  isNotFound,
  normalizeAmountInput,
  runeLength,
  sponsorErrorText,
  toSatang,
  todayBangkokYmd,
  type Notice,
} from './sponsor-ui';

/** Contract limits for DonationInput. */
const DONOR_MAX = 200;
const TEXT_MAX = 500;
const AMOUNT_MAX_SATANG = 10_000_000n * 100n;
const FILE_ACCEPT = SPONSOR_FILE_TYPES.join(',');
const FILE_KINDS: SponsorFileKind[] = ['signed', 'slip'];
const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};
/** How long a viewed file's blob: URL stays alive (the new tab has loaded it long before). */
const VIEW_URL_TTL_MS = 60_000;

type DonationForm = {
  donorName: string;
  address: string;
  phone: string;
  kind: SponsorKind;
  amount: string;
  goodsDescription: string;
  donatedOn: string;
  note: string;
  taxId: string;
  addressLine: string;
  subdistrict: string;
  district: string;
  province: string;
  postcode: string;
  facultySubmitted: boolean;
};
type FieldKey =
  | 'donorName'
  | 'address'
  | 'phone'
  | 'taxId'
  | 'addressLine'
  | 'subdistrict'
  | 'district'
  | 'province'
  | 'postcode'
  | 'amount'
  | 'goodsDescription'
  | 'donatedOn'
  | 'note';
type FieldErrors = Partial<Record<FieldKey, string>>;
/** null = editor closed, 'new' = add, number = editing that donation id. */
type FormTarget = null | 'new' | number;

/** Values handed over from an inquiry ("สร้างรายการบริจาค"); a new `nonce` opens the editor again. */
export type DonationPrefill = {
  nonce: number;
  values: Pick<
    DonationForm,
    | 'donorName'
    | 'phone'
    | 'kind'
    | 'amount'
    | 'goodsDescription'
    | 'note'
    | 'taxId'
    | 'addressLine'
    | 'subdistrict'
    | 'district'
    | 'province'
    | 'postcode'
  >;
  /** Money inquiry whose transfer slip the server copies into the new donation. */
  fromInquiryId?: number;
};

interface Props {
  token: string;
  canEdit: boolean;
  /** Returns true when the error was an expired session, in which case the parent has logged out. */
  onAuthError: (err: unknown) => boolean;
  prefill: DonationPrefill | null;
}

const FIELD_ORDER: FieldKey[] = [
  'donorName',
  'phone',
  'taxId',
  'addressLine',
  'subdistrict',
  'district',
  'province',
  'postcode',
  'address',
  'goodsDescription',
  'amount',
  'donatedOn',
  'note',
];
const fieldId = (k: FieldKey) => `donation-${k}-input`;

function emptyForm(): DonationForm {
  return {
    donorName: '',
    address: '',
    phone: '',
    kind: 'money',
    amount: '',
    goodsDescription: '',
    donatedOn: todayBangkokYmd(),
    note: '',
    taxId: '',
    addressLine: '',
    subdistrict: '',
    district: '',
    province: '',
    postcode: '',
    facultySubmitted: false,
  };
}

function formFromDonation(d: SponsorDonation): DonationForm {
  return {
    donorName: d.donorName,
    address: d.address,
    phone: d.phone,
    kind: d.kind,
    amount: d.amount ?? '',
    goodsDescription: d.goodsDescription,
    donatedOn: d.donatedOn,
    note: d.note,
    taxId: d.kind === 'money' ? d.taxId : '',
    addressLine: d.kind === 'money' ? d.addressLine : '',
    subdistrict: d.kind === 'money' ? d.subdistrict : '',
    district: d.kind === 'money' ? d.district : '',
    province: d.kind === 'money' ? d.province : '',
    postcode: d.kind === 'money' ? d.postcode : '',
    facultySubmitted: d.facultySubmitted,
  };
}

/** The full PATCH body for a stored donation (PATCH replaces every editable field). */
function inputFromDonation(d: SponsorDonation): SponsorDonationInput {
  const isMoney = d.kind === 'money';
  return {
    donorName: d.donorName,
    address: d.address,
    phone: d.phone,
    kind: d.kind,
    amount: d.amount,
    goodsDescription: d.kind === 'goods' ? d.goodsDescription : '',
    donatedOn: d.donatedOn,
    note: d.note,
    taxId: isMoney ? d.taxId : '',
    addressLine: isMoney ? d.addressLine : '',
    subdistrict: isMoney ? d.subdistrict : '',
    district: isMoney ? d.district : '',
    province: isMoney ? d.province : '',
    postcode: isMoney ? d.postcode : '',
    facultySubmitted: d.facultySubmitted,
  };
}

/** Mirrors the DonationInput rules of the contract; returns the body or the Thai field errors. */
function validateForm(f: DonationForm): { input: SponsorDonationInput | null; errors: FieldErrors } {
  const errors: FieldErrors = {};

  const donorName = stripZeroWidth(f.donorName).trim();
  if (!donorName) errors.donorName = 'กรุณากรอกชื่อผู้บริจาค';
  else if (runeLength(donorName) > DONOR_MAX) errors.donorName = `ชื่อยาวได้ไม่เกิน ${DONOR_MAX} ตัวอักษร`;
  else if (/[\r\n]/.test(donorName) || CONTROL_CHARS.test(donorName)) errors.donorName = 'ชื่อต้องอยู่ในบรรทัดเดียว';

  const address = f.address.trim();
  if (runeLength(address) > TEXT_MAX) errors.address = `ที่อยู่ยาวได้ไม่เกิน ${TEXT_MAX} ตัวอักษร`;
  else if (CONTROL_CHARS.test(address)) errors.address = 'ที่อยู่มีอักขระที่ใช้ไม่ได้';

  const rawPhone = normalizeThaiDigits(stripZeroWidth(f.phone)).trim();
  const phone = sanitizeDigits(rawPhone);
  if (rawPhone && !/^[\d\s-]+$/.test(rawPhone)) errors.phone = 'เบอร์โทรกรอกได้เฉพาะตัวเลข';
  else if (phone && (phone.length < 9 || phone.length > 10)) errors.phone = 'เบอร์โทรต้องมี 9–10 หลัก (หรือเว้นว่าง)';

  let taxId = '';
  let addressLine = '';
  let subdistrict = '';
  let district = '';
  let province = '';
  let postcode = '';

  if (f.kind === 'money') {
    const rawTaxId = normalizeThaiTaxId(f.taxId);
    if (rawTaxId) {
      if (!isValidThaiTaxId(rawTaxId)) errors.taxId = 'เลขไม่ถูกต้อง กรุณาตรวจอีกครั้ง';
      else taxId = rawTaxId;
    }

    addressLine = stripZeroWidth(f.addressLine).trim();
    if (runeLength(addressLine) > SPONSOR_ADDRESS_LINE_MAX) {
      errors.addressLine = `บ้านเลขที่/ถนนยาวได้ไม่เกิน ${SPONSOR_ADDRESS_LINE_MAX} ตัวอักษร`;
    } else if (/[\r\n]/.test(addressLine) || CONTROL_CHARS.test(addressLine)) {
      errors.addressLine = 'ที่อยู่ต้องอยู่ในบรรทัดเดียวและไม่มีอักขระควบคุม';
    }

    subdistrict = stripZeroWidth(f.subdistrict).trim();
    if (runeLength(subdistrict) > SPONSOR_AREA_MAX) {
      errors.subdistrict = `ตำบล/แขวงยาวได้ไม่เกิน ${SPONSOR_AREA_MAX} ตัวอักษร`;
    } else if (/[\r\n]/.test(subdistrict) || CONTROL_CHARS.test(subdistrict)) {
      errors.subdistrict = 'ตำบล/แขวงมีอักขระที่ใช้ไม่ได้';
    }

    district = stripZeroWidth(f.district).trim();
    if (runeLength(district) > SPONSOR_AREA_MAX) {
      errors.district = `อำเภอ/เขตยาวได้ไม่เกิน ${SPONSOR_AREA_MAX} ตัวอักษร`;
    } else if (/[\r\n]/.test(district) || CONTROL_CHARS.test(district)) {
      errors.district = 'อำเภอ/เขตมีอักขระที่ใช้ไม่ได้';
    }

    const rawProvince = stripZeroWidth(f.province).trim();
    if (rawProvince) {
      const official = canonicalProvince(rawProvince);
      if (!official) errors.province = 'กรุณาเลือกจังหวัดจากรายการ';
      else province = official;
    }

    const rawPostcode = normalizePostcode(f.postcode);
    if (rawPostcode) {
      if (!isValidPostcode(rawPostcode)) errors.postcode = 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก';
      else postcode = rawPostcode;
    }
  }

  const amountText = normalizeAmountInput(f.amount);
  let amount: string | null = null;
  if (amountText) {
    const satang = toSatang(amountText);
    if (satang === null) errors.amount = 'กรอกเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 1200 หรือ 1500.50';
    else if (f.kind === 'money' && satang === 0n) errors.amount = 'จำนวนเงินต้องมากกว่า 0';
    else if (satang > AMOUNT_MAX_SATANG) errors.amount = 'จำนวนเงินต้องไม่เกิน 10,000,000 บาท';
    else amount = amountText;
  } else if (f.kind === 'money') {
    errors.amount = 'กรุณากรอกจำนวนเงิน';
  }

  const goods = f.goodsDescription.trim();
  if (f.kind === 'goods') {
    if (!goods) errors.goodsDescription = 'กรุณาระบุสิ่งของที่บริจาค';
    else if (runeLength(goods) > TEXT_MAX) errors.goodsDescription = `รายการสิ่งของยาวได้ไม่เกิน ${TEXT_MAX} ตัวอักษร`;
    else if (CONTROL_CHARS.test(goods)) errors.goodsDescription = 'รายการสิ่งของมีอักขระที่ใช้ไม่ได้';
  }

  if (f.donatedOn && !formatYmdShort(f.donatedOn)) errors.donatedOn = 'วันที่ไม่ถูกต้อง';

  const note = f.note.trim();
  if (runeLength(note) > TEXT_MAX) errors.note = `หมายเหตุยาวได้ไม่เกิน ${TEXT_MAX} ตัวอักษร`;
  else if (CONTROL_CHARS.test(note)) errors.note = 'หมายเหตุมีอักขระที่ใช้ไม่ได้';

  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    input: {
      donorName,
      address,
      phone,
      kind: f.kind,
      amount,
      goodsDescription: f.kind === 'goods' ? goods : '',
      donatedOn: f.donatedOn,
      note,
      taxId,
      addressLine,
      subdistrict,
      district,
      province,
      postcode,
      facultySubmitted: f.facultySubmitted,
    },
    errors,
  };
}

function fileProblem(file: File): string | null {
  if (!(SPONSOR_FILE_TYPES as readonly string[]).includes(file.type.toLowerCase())) {
    return 'รองรับเฉพาะไฟล์ PDF, JPG, PNG หรือ WebP';
  }
  if (file.size === 0) return 'ไฟล์ว่างเปล่า กรุณาเลือกไฟล์ใหม่';
  if (file.size > SPONSOR_FILE_MAX_BYTES) return 'ไฟล์ใหญ่เกิน 8 MB';
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const byNewest = (a: SponsorDonation, b: SponsorDonation) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;

function FieldShell({
  k,
  label,
  help,
  error,
  children,
}: {
  k: FieldKey;
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={fieldId(k)} className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
        {label}
      </label>
      {children}
      {help && (
        <p id={`${fieldId(k)}-help`} className="mt-1.5 text-xs leading-5" style={{ color: INK_3 }}>
          {help}
        </p>
      )}
      {error && (
        <p id={`${fieldId(k)}-error`} className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** aria props shared by every editor control. */
function a11y(k: FieldKey, error: string | undefined, hasHelp: boolean) {
  const ids = [hasHelp ? `${fieldId(k)}-help` : '', error ? `${fieldId(k)}-error` : ''].filter(Boolean).join(' ');
  return {
    id: fieldId(k),
    'aria-invalid': error ? true : undefined,
    'aria-describedby': ids || undefined,
  } as const;
}

const PRIMARY_BTN = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`;
const LINK_BTN = `inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`;
const CONFIRM_BTN = `inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 text-sm font-semibold transition-[background-color,transform] duration-150 hover:bg-[var(--color-btn-ghost-hover)] active:scale-[0.96] disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 ${FOCUS}`;
const DANGER_TINT = 'color-mix(in srgb, var(--color-danger) 10%, transparent)';

/**
 * Donations recorded by staff: list + editor, the printable faculty form (blank or pre-filled),
 * the signed-form scan and transfer slip per donation, the "ส่งคณะแล้ว" flag and delete.
 */
export function AdminSponsorDonations({ token, canEdit, onAuthError, prefill }: Props) {
  const [items, setItems] = useState<SponsorDonation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [form, setForm] = useState<DonationForm>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  /** Set by "สร้างรายการบริจาค" from a money inquiry with a slip: the server copies that slip on create. */
  const [fromInquiryId, setFromInquiryId] = useState<number | null>(null);

  /** Running mutation: 'save' | `faculty-<id>` | `delete-<id>` | `upload-<id>-<kind>` | `filedel-<id>-<kind>`. */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [viewingKey, setViewingKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  /** `<id>-<kind>` of the file whose delete is awaiting confirmation. */
  const [confirmFileKey, setConfirmFileKey] = useState<string | null>(null);
  /** undefined = not printing, null = blank form, otherwise that donation. */
  const [printing, setPrinting] = useState<PrintableDonation | null | undefined>(undefined);

  const actionRef = useRef(false);
  const viewRef = useRef(false);
  const loadingRef = useRef(false);
  const [saveDone, bumpSave] = useDoneSignal();
  /** Last successful "ส่งคณะแล้ว" toggle, so only that row's button plays the success beat. */
  const [facultyDone, setFacultyDone] = useState<{ id: number; n: number } | null>(null);
  const viewUrlsRef = useRef(new Set<string>());

  const busy = busyKey !== null;
  const editing = typeof formTarget === 'number' ? (items?.find((d) => d.id === formTarget) ?? null) : null;

  async function load(signal?: { cancelled: boolean }) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const list = await fetchSponsorDonations(token);
      if (signal?.cancelled) return;
      setItems([...list].sort(byNewest));
      setLoadError(null);
    } catch (err) {
      if (signal?.cancelled || onAuthError(err)) return;
      setLoadError(sponsorErrorText(err, 'โหลดรายการบริจาคไม่สำเร็จ', { context: 'list' }));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canEdit) return;
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
      loadingRef.current = false;
    };
  }, [token, canEdit]);

  // Revoke any viewed-file URL still alive when the panel goes away.
  useEffect(() => {
    const urls = viewUrlsRef.current;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (!prefill || !canEdit) return;
    if (actionRef.current) {
      setNotice({ kind: 'error', text: 'กำลังบันทึกรายการอื่นอยู่ กรุณารอสักครู่แล้วกด “สร้างรายการบริจาค” อีกครั้ง' });
      return;
    }
    setNotice(null);
    setConfirmDeleteId(null);
    setConfirmFileKey(null);
    setFieldErrors({});
    setForm({ ...emptyForm(), ...prefill.values });
    setFromInquiryId(prefill.fromInquiryId ?? null);
    setFormTarget('new');
    requestAnimationFrame(() => {
      const el = document.getElementById(fieldId('donorName'));
      el?.scrollIntoView({ block: 'center' });
      el?.focus({ preventScroll: true });
    });
  }, [prefill?.nonce]);

  useEffect(() => {
    if (confirmDeleteId === null && confirmFileKey === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || actionRef.current) return;
      if (confirmDeleteId !== null) {
        const id = confirmDeleteId;
        setConfirmDeleteId(null);
        focusLater(`donation-delete-${id}`);
      }
      if (confirmFileKey !== null) {
        const key = confirmFileKey;
        setConfirmFileKey(null);
        focusLater(`donation-filedel-${key}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDeleteId, confirmFileKey]);

  function setField<K extends keyof DonationForm>(key: K, value: DonationForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key in fieldErrors) setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function openForm(target: 'new' | SponsorDonation) {
    if (busy) return;
    setNotice(null);
    setConfirmDeleteId(null);
    setConfirmFileKey(null);
    setFieldErrors({});
    if (target === 'new') {
      setFormTarget('new');
      setFromInquiryId(null);
      setForm(emptyForm());
    } else {
      setFormTarget(target.id);
      setForm(formFromDonation(target));
    }
    focusLater(fieldId('donorName'));
  }

  function closeForm(returnFocus = true) {
    const target = formTarget;
    setFormTarget(null);
    setFromInquiryId(null);
    setFieldErrors({});
    if (!returnFocus) return;
    if (typeof target === 'number') focusLater(`donation-edit-${target}`, 'donation-add-button');
    else focusLater('donation-add-button');
  }

  /** Starts a mutation behind the synchronous lock; returns false when another one is running. */
  function lock(key: string): boolean {
    if (!canEdit || actionRef.current) return false;
    actionRef.current = true;
    setBusyKey(key);
    setNotice(null);
    return true;
  }

  function unlock() {
    actionRef.current = false;
    setBusyKey(null);
  }

  function replaceItem(d: SponsorDonation) {
    setItems((prev) => (prev ?? []).map((x) => (x.id === d.id ? d : x)));
  }

  /** Shared catch: auth → parent logs out; 404 → reload the list. */
  function failed(err: unknown, what: string, validation?: string) {
    if (onAuthError(err)) return;
    setNotice({ kind: 'error', text: `${what}ไม่สำเร็จ: ${sponsorErrorText(err, UNKNOWN_ERROR, { validation })}` });
    if (isNotFound(err)) load();
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (formTarget === null || actionRef.current) return;
    const { input, errors } = validateForm(form);
    setFieldErrors(errors);
    if (!input) {
      const first = FIELD_ORDER.find((k) => errors[k]);
      if (first) document.getElementById(fieldId(first))?.focus();
      return;
    }
    if (!lock('save')) return;
    try {
      if (formTarget === 'new') {
        const created = await createSponsorDonation(
          token,
          fromInquiryId !== null && input.kind === 'money' ? { ...input, fromInquiryId } : input,
        );
        setItems((prev) => [created, ...(prev ?? [])]);
        setNotice({ kind: 'ok', text: `บันทึกรายการบริจาคของ “${created.donorName}” แล้ว พิมพ์ฟอร์มให้ผู้บริจาคเซ็นได้จากรายการด้านล่าง` });
        closeForm(false);
        bumpSave();
        focusLater(`donation-print-${created.id}`, 'donation-add-button');
      } else {
        const updated = await updateSponsorDonation(token, formTarget, input);
        replaceItem(updated);
        setNotice({ kind: 'ok', text: `บันทึกการแก้ไข “${updated.donorName}” แล้ว` });
        closeForm();
        bumpSave();
      }
    } catch (err) {
      failed(
        err,
        'บันทึก',
        'ข้อมูลไม่ผ่านการตรวจของเซิร์ฟเวอร์ กรุณาตรวจชื่อ เบอร์โทร เลขผู้เสียภาษี ที่อยู่ จำนวนเงิน และรายการสิ่งของอีกครั้ง',
      );
      if (isNotFound(err)) closeForm(false);
    } finally {
      unlock();
    }
  }

  async function onToggleFaculty(d: SponsorDonation) {
    if (!lock(`faculty-${d.id}`)) return;
    try {
      const updated = await updateSponsorDonation(token, d.id, { ...inputFromDonation(d), facultySubmitted: !d.facultySubmitted });
      replaceItem(updated);
      // Keep an open editor of this donation from writing the old flag back on save.
      if (formTarget === d.id) setForm((prev) => ({ ...prev, facultySubmitted: updated.facultySubmitted }));
      setFacultyDone((prev) => ({ id: d.id, n: (prev?.n ?? 0) + 1 }));
      setNotice({
        kind: 'ok',
        text: updated.facultySubmitted ? `ทำเครื่องหมาย “${updated.donorName}” ว่าส่งคณะแล้ว` : `ยกเลิกสถานะส่งคณะของ “${updated.donorName}” แล้ว`,
      });
    } catch (err) {
      failed(err, 'บันทึกสถานะ');
    } finally {
      unlock();
    }
  }

  async function onConfirmDelete(d: SponsorDonation) {
    if (!lock(`delete-${d.id}`)) return;
    try {
      await deleteSponsorDonation(token, d.id);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== d.id));
      setConfirmDeleteId(null);
      if (formTarget === d.id) setFormTarget(null);
      setNotice({ kind: 'ok', text: `ลบรายการบริจาคของ “${d.donorName}” และไฟล์แนบแล้ว` });
      focusLater('donation-add-button');
    } catch (err) {
      if (isNotFound(err)) setConfirmDeleteId(null);
      failed(err, 'ลบ');
    } finally {
      unlock();
    }
  }

  async function uploadFile(target: { id: number; kind: SponsorFileKind }, file: File) {
    if (busy || actionRef.current) return;
    const problem = fileProblem(file);
    if (problem) {
      setNotice({ kind: 'error', text: `อัปโหลด${SPONSOR_FILE_LABELS[target.kind]}ไม่ได้: ${problem}` });
      return;
    }
    if (!lock(`upload-${target.id}-${target.kind}`)) return;
    try {
      const updated = await uploadSponsorDonationFile(token, target.id, target.kind, file);
      replaceItem(updated);
      setNotice({ kind: 'ok', text: `อัปโหลด${SPONSOR_FILE_LABELS[target.kind]}ของ “${updated.donorName}” แล้ว` });
      focusLater(`donation-fileview-${target.id}-${target.kind}`);
    } catch (err) {
      failed(err, `อัปโหลด${SPONSOR_FILE_LABELS[target.kind]}`, 'ไฟล์ไม่ถูกต้อง รองรับเฉพาะ PDF, JPG, PNG หรือ WebP ไม่เกิน 8 MB');
    } finally {
      unlock();
    }
  }

  async function onDeleteFile(d: SponsorDonation, kind: SponsorFileKind) {
    if (!lock(`filedel-${d.id}-${kind}`)) return;
    try {
      const updated = await deleteSponsorDonationFile(token, d.id, kind);
      replaceItem(updated);
      setConfirmFileKey(null);
      setNotice({ kind: 'ok', text: `ลบ${SPONSOR_FILE_LABELS[kind]}ของ “${updated.donorName}” แล้ว` });
      focusLater(`donation-upload-${d.id}-${kind}`);
    } catch (err) {
      if (isNotFound(err)) setConfirmFileKey(null);
      failed(err, `ลบ${SPONSOR_FILE_LABELS[kind]}`);
    } finally {
      unlock();
    }
  }

  async function onViewFile(d: SponsorDonation, kind: SponsorFileKind) {
    if (viewRef.current) return;
    // Open the tab inside the click so popup blockers allow it, then point it at the blob.
    const win = window.open('', '_blank');
    if (!win) {
      setNotice({ kind: 'error', text: 'เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาตป๊อปอัปสำหรับเว็บนี้แล้วลองอีกครั้ง' });
      return;
    }
    win.opener = null;
    viewRef.current = true;
    const key = `${d.id}-${kind}`;
    setViewingKey(key);
    setNotice(null);
    try {
      const url = await fetchSponsorDonationFile(token, d.id, kind);
      viewUrlsRef.current.add(url);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        viewUrlsRef.current.delete(url);
      }, VIEW_URL_TTL_MS);
      if (!win.closed) win.location.href = url;
    } catch (err) {
      win?.close();
      failed(err, `เปิด${SPONSOR_FILE_LABELS[kind]}`);
    } finally {
      viewRef.current = false;
      setViewingKey(null);
    }
  }

  function onPrint(d: SponsorDonation | null) {
    if (printing !== undefined) return;
    setPrinting(d);
  }

  if (!canEdit) {
    return (
      <p className="text-sm leading-7" style={{ color: INK_3 }}>
        เฉพาะผู้ดูแลระบบเท่านั้นที่ดูรายการนี้ได้
      </p>
    );
  }

  const moneyTotal = (items ?? []).reduce((sum, d) => {
    const s = d.kind === 'money' && d.amount ? toSatang(d.amount) : null;
    return s === null ? sum : sum + s;
  }, 0n);
  const notSubmitted = (items ?? []).filter((d) => !d.facultySubmitted).length;

  function renderForm() {
    const isNew = formTarget === 'new';
    const saving = busyKey === 'save';
    const e = fieldErrors;
    const inputCls = `${INPUT_BASE} min-h-11 rounded-xl`;
    const border = (k: FieldKey) => ({ borderColor: e[k] ? DANGER : INPUT_BORDER, color: INK });
    return (
      <motion.form
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={EXPAND}
        onSubmit={onSave}
        noValidate
        aria-busy={saving}
        aria-labelledby="donation-form-title"
        className="flex flex-col gap-5 rounded-xl border p-4 sm:p-5"
        style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE }}
      >
        <h3 id="donation-form-title" className="text-base font-semibold leading-snug" style={{ color: INK }}>
          {isNew ? 'เพิ่มรายการบริจาค' : `แก้ไขรายการของ “${editing?.donorName ?? ''}”`}
        </h3>
        {isNew && fromInquiryId !== null && form.kind === 'money' && (
          <p className="text-sm leading-6" style={{ color: INK_2 }}>
            สลิปจากผู้สนใจสนับสนุนจะถูกแนบให้อัตโนมัติ
          </p>
        )}

        <FieldShell k="donorName" label="ชื่อผู้บริจาค (บุคคลหรือหน่วยงาน)" error={e.donorName}>
          <input
            {...a11y('donorName', e.donorName, false)}
            type="text"
            required
            maxLength={DONOR_MAX}
            autoComplete="off"
            value={form.donorName}
            onChange={(ev) => setField('donorName', ev.target.value)}
            disabled={saving}
            className={inputCls}
            style={border('donorName')}
          />
        </FieldShell>

        <FieldShell k="phone" label="เบอร์โทร (ไม่บังคับ)" help="มือถือหรือเบอร์บ้าน 9–10 หลัก" error={e.phone}>
          <input
            {...a11y('phone', e.phone, true)}
            type="tel"
            inputMode="tel"
            maxLength={20}
            autoComplete="off"
            value={form.phone}
            onChange={(ev) => setField('phone', ev.target.value)}
            disabled={saving}
            className={`${inputCls} font-mono sm:max-w-[16rem]`}
            style={border('phone')}
          />
        </FieldShell>

        <fieldset>
          <legend className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
            บริจาคเป็น
          </legend>
          <div className="flex flex-wrap gap-2">
            {(['money', 'goods'] as const).map((k) => {
              const on = form.kind === k;
              return (
                <label
                  key={k}
                  className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-tech)] has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--bg-canvas)] motion-reduce:transition-none ${saving ? 'opacity-50' : ''}`}
                  style={{
                    borderColor: on ? BTN_DARK : RULE,
                    backgroundColor: on ? BTN_DARK : 'transparent',
                    color: on ? BTN_DARK_TEXT : INK_2,
                    fontWeight: on ? 600 : 500,
                  }}
                >
                  <input
                    type="radio"
                    name="donation-kind"
                    value={k}
                    checked={on}
                    disabled={saving}
                    onChange={() => {
                      if (k === 'goods') {
                        setForm((prev) => ({
                          ...prev,
                          kind: 'goods',
                          taxId: '',
                          addressLine: '',
                          subdistrict: '',
                          district: '',
                          province: '',
                          postcode: '',
                        }));
                      } else {
                        setField('kind', k);
                      }
                      setFieldErrors((prev) => ({
                        ...prev,
                        amount: undefined,
                        goodsDescription: undefined,
                        taxId: undefined,
                        addressLine: undefined,
                        subdistrict: undefined,
                        district: undefined,
                        province: undefined,
                        postcode: undefined,
                      }));
                    }}
                    className="sr-only"
                  />
                  {SPONSOR_KIND_LABELS[k]}
                </label>
              );
            })}
          </div>
        </fieldset>

        {form.kind === 'money' ? (
          <div className="flex flex-col gap-4 border-t pt-4" style={{ borderColor: RULE }}>
            <div>
              <p className="text-sm font-semibold leading-6" style={{ color: INK }}>
                ข้อมูลสำหรับออกเอกสารลดหย่อนภาษี (ไม่บังคับ)
              </p>
              <p className="text-xs leading-5" style={{ color: INK_3 }}>
                พิมพ์ลงแบบฟอร์มบริจาคเงิน เว้นว่างได้ถ้ายังไม่มีข้อมูลหรือจะให้ผู้บริจาคเขียนเอง
              </p>
            </div>

            <FieldShell
              k="taxId"
              label="เลขประจำตัวประชาชน / เลขประจำตัวผู้เสียภาษี (13 หลัก)"
              help="ใช้ได้ทั้งบุคคลธรรมดาและนิติบุคคล กรอกได้ทั้งแบบมีขีดและไม่มีขีด"
              error={e.taxId}
            >
              <input
                {...a11y('taxId', e.taxId, true)}
                type="text"
                inputMode="numeric"
                maxLength={25}
                autoComplete="off"
                placeholder="X-XXXX-XXXXX-XX-X"
                value={form.taxId}
                onChange={(ev) => setField('taxId', ev.target.value)}
                disabled={saving}
                className={`${inputCls} font-mono tabular-nums sm:max-w-[20rem]`}
                style={border('taxId')}
              />
            </FieldShell>

            <FieldShell k="addressLine" label="บ้านเลขที่ / หมู่ / ซอย / ถนน" error={e.addressLine}>
              <input
                {...a11y('addressLine', e.addressLine, false)}
                type="text"
                maxLength={SPONSOR_ADDRESS_LINE_MAX}
                autoComplete="address-line1"
                placeholder="เช่น 63 หมู่ 4 ถ.เชียงใหม่-พร้าว"
                value={form.addressLine}
                onChange={(ev) => setField('addressLine', ev.target.value)}
                disabled={saving}
                className={inputCls}
                style={border('addressLine')}
              />
            </FieldShell>

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell k="subdistrict" label="ตำบล / แขวง" error={e.subdistrict}>
                <input
                  {...a11y('subdistrict', e.subdistrict, false)}
                  type="text"
                  maxLength={SPONSOR_AREA_MAX}
                  autoComplete="off"
                  value={form.subdistrict}
                  onChange={(ev) => setField('subdistrict', ev.target.value)}
                  disabled={saving}
                  className={inputCls}
                  style={border('subdistrict')}
                />
              </FieldShell>

              <FieldShell k="district" label="อำเภอ / เขต" error={e.district}>
                <input
                  {...a11y('district', e.district, false)}
                  type="text"
                  maxLength={SPONSOR_AREA_MAX}
                  autoComplete="off"
                  value={form.district}
                  onChange={(ev) => setField('district', ev.target.value)}
                  disabled={saving}
                  className={inputCls}
                  style={border('district')}
                />
              </FieldShell>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell k="province" label="จังหวัด" error={e.province}>
                <fieldset disabled={saving} className="m-0 border-0 p-0">
                  <ProvinceCombobox
                    id={fieldId('province')}
                    value={form.province}
                    onChange={(v) => setField('province', v)}
                    className={inputCls}
                    style={border('province')}
                    invalid={Boolean(e.province)}
                    describedBy={e.province ? `${fieldId('province')}-error` : undefined}
                  />
                </fieldset>
              </FieldShell>

              <FieldShell k="postcode" label="รหัสไปรษณีย์" error={e.postcode}>
                <input
                  {...a11y('postcode', e.postcode, false)}
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  autoComplete="postal-code"
                  placeholder="50290"
                  value={form.postcode}
                  onChange={(ev) => setField('postcode', sanitizeDigits(ev.target.value).slice(0, 5))}
                  disabled={saving}
                  className={`${inputCls} font-mono tabular-nums`}
                  style={border('postcode')}
                />
              </FieldShell>
            </div>

            {form.address && (
              <FieldShell
                k="address"
                label="ที่อยู่เดิม (ข้อความอิสระ, ไม่บังคับ)"
                help="ใช้สำรองเฉพาะเมื่อยังไม่ได้กรอกที่อยู่แยกช่องด้านบน"
                error={e.address}
              >
                <textarea
                  {...a11y('address', e.address, true)}
                  rows={2}
                  maxLength={TEXT_MAX}
                  value={form.address}
                  onChange={(ev) => setField('address', ev.target.value)}
                  disabled={saving}
                  className={`${INPUT_BASE} rounded-xl leading-[1.75]`}
                  style={border('address')}
                />
              </FieldShell>
            )}
          </div>
        ) : (
          <FieldShell k="address" label="ที่อยู่ (ไม่บังคับ)" help="พิมพ์ลงฟอร์ม เว้นว่างได้ถ้าจะให้ผู้บริจาคเขียนเอง" error={e.address}>
            <textarea
              {...a11y('address', e.address, true)}
              rows={2}
              maxLength={TEXT_MAX}
              value={form.address}
              onChange={(ev) => setField('address', ev.target.value)}
              disabled={saving}
              className={`${INPUT_BASE} rounded-xl leading-[1.75]`}
              style={border('address')}
            />
          </FieldShell>
        )}

        {form.kind === 'goods' && (
          <FieldShell k="goodsDescription" label="สิ่งของที่บริจาค" help={`เช่น น้ำดื่ม 20 แพ็ก ขนม 5 ลัง (ไม่เกิน ${TEXT_MAX} ตัวอักษร)`} error={e.goodsDescription}>
            <textarea
              {...a11y('goodsDescription', e.goodsDescription, true)}
              rows={2}
              required
              maxLength={TEXT_MAX}
              value={form.goodsDescription}
              onChange={(ev) => setField('goodsDescription', ev.target.value)}
              disabled={saving}
              className={`${INPUT_BASE} rounded-xl leading-[1.75]`}
              style={border('goodsDescription')}
            />
          </FieldShell>
        )}

        <FieldShell
          k="amount"
          label={form.kind === 'money' ? 'จำนวนเงิน (บาท)' : 'มูลค่าโดยประมาณ (บาท, ไม่บังคับ)'}
          help="ทศนิยมได้ไม่เกิน 2 ตำแหน่ง ไม่เกิน 10,000,000 บาท"
          error={e.amount}
        >
          <input
            {...a11y('amount', e.amount, true)}
            type="text"
            inputMode="decimal"
            required={form.kind === 'money'}
            maxLength={16}
            autoComplete="off"
            placeholder="เช่น 1200"
            value={form.amount}
            onChange={(ev) => setField('amount', ev.target.value)}
            disabled={saving}
            className={`${inputCls} font-mono sm:max-w-[16rem]`}
            style={border('amount')}
          />
        </FieldShell>

        <FieldShell k="donatedOn" label="วันที่บริจาค (ไม่บังคับ)" help="พิมพ์เป็นวันที่บนฟอร์ม เว้นว่างได้" error={e.donatedOn}>
          <input
            {...a11y('donatedOn', e.donatedOn, true)}
            type="date"
            value={form.donatedOn}
            onChange={(ev) => setField('donatedOn', ev.target.value)}
            disabled={saving}
            className={`${inputCls} font-mono sm:max-w-[16rem]`}
            style={border('donatedOn')}
          />
        </FieldShell>

        <FieldShell k="note" label="หมายเหตุสำหรับทีมงาน (ไม่บังคับ)" help="ไม่พิมพ์ลงฟอร์ม" error={e.note}>
          <textarea
            {...a11y('note', e.note, true)}
            rows={2}
            maxLength={TEXT_MAX}
            value={form.note}
            onChange={(ev) => setField('note', ev.target.value)}
            disabled={saving}
            className={`${INPUT_BASE} rounded-xl leading-[1.75]`}
            style={border('note')}
          />
        </FieldShell>

        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 self-start text-sm" style={{ color: INK_2 }}>
          <input
            type="checkbox"
            checked={form.facultySubmitted}
            onChange={(ev) => setField('facultySubmitted', ev.target.checked)}
            disabled={saving}
            className="size-4 accent-[var(--color-tech)]"
          />
          <span>ส่งฟอร์มให้คณะแล้ว</span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <StatefulButton
            type="submit"
            disabled={busy}
            busy={saving}
            busyLabel="กำลังบันทึก…"
            doneSignal={saveDone}
            doneLabel="บันทึกแล้ว"
            icon={<Save aria-hidden="true" size={16} strokeWidth={1.5} />}
            className={PRIMARY_BTN}
            style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
          >
            {isNew ? 'บันทึกรายการบริจาค' : 'บันทึกการแก้ไข'}
          </StatefulButton>
          <button type="button" disabled={saving} onClick={() => closeForm()} className={PILL_GHOST} style={{ borderColor: RULE, color: INK_2 }}>
            ยกเลิก
          </button>
        </div>
      </motion.form>
    );
  }

  function renderFile(d: SponsorDonation, kind: SponsorFileKind) {
    const file = d.files[kind];
    const key = `${d.id}-${kind}`;
    const label = SPONSOR_FILE_LABELS[kind];
    const uploading = busyKey === `upload-${key}`;
    const deleting = busyKey === `filedel-${key}`;
    const viewing = viewingKey === key;
    const confirming = confirmFileKey === key;
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-6" style={{ color: INK }}>
          <span
            className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-5"
            style={{ borderColor: file ? SUCCESS : RULE, color: file ? INK : INK_3 }}
          >
            {file ? <Check aria-hidden="true" size={12} strokeWidth={2} style={{ color: SUCCESS }} /> : null}
            {label}
          </span>
          <span className="text-xs leading-5" style={{ color: INK_3 }}>
            {file ? (
              <>
                <span className="font-mono">{MIME_LABELS[file.mime] ?? file.mime}</span> ·{' '}
                <span className="font-mono">{formatBytes(file.size)}</span> · {formatBangkokDateTime(file.uploadedAt)}
              </>
            ) : (
              'ยังไม่มีไฟล์'
            )}
          </span>
        </p>
        <FileDropzone
          compact
          id={`donation-upload-${key}`}
          accept={FILE_ACCEPT}
          onFile={(f) => uploadFile({ id: d.id, kind }, f)}
          label={file ? `เปลี่ยน${label}ของ ${d.donorName}` : `อัปโหลด${label}ของ ${d.donorName}`}
          hint="PDF, JPG, PNG หรือ WebP ไม่เกิน 8 MB · คลิกหรือลากไฟล์มาวาง"
          file={file ? { name: label, size: file.size, type: file.mime } : null}
          busy={uploading}
          busyText="กำลังอัปโหลด…"
          disabled={busy && !uploading}
          fileActions={
            file ? (
              <>
                <button
                  id={`donation-fileview-${key}`}
                  type="button"
                  disabled={viewing}
                  aria-busy={viewing || undefined}
                  aria-label={`ดู${label}ของ ${d.donorName} (เปิดในแท็บใหม่)`}
                  onClick={() => onViewFile(d, kind)}
                  className={`${PILL_GHOST} gap-1.5`}
                  style={{ borderColor: RULE, color: INK }}
                >
                  <Eye aria-hidden="true" size={16} strokeWidth={1.5} />
                  {viewing ? 'กำลังเปิด…' : 'ดู'}
                </button>
                {confirming ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      aria-busy={deleting || undefined}
                      onClick={() => onDeleteFile(d, kind)}
                      className={CONFIRM_BTN}
                      style={{ borderColor: DANGER, color: DANGER, backgroundColor: DANGER_TINT }}
                    >
                      {deleting ? 'กำลังลบ…' : `ยืนยันลบ${label}`}
                    </button>
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => {
                        setConfirmFileKey(null);
                        focusLater(`donation-filedel-${key}`);
                      }}
                      className={LINK_BTN}
                      style={{ color: INK_2 }}
                    >
                      ยกเลิก
                    </button>
                  </>
                ) : (
                  <button
                    id={`donation-filedel-${key}`}
                    type="button"
                    disabled={busy}
                    aria-label={`ลบ${label}ของ ${d.donorName}`}
                    onClick={() => {
                      setNotice(null);
                      setConfirmDeleteId(null);
                      setConfirmFileKey(key);
                    }}
                    className={PILL_DANGER}
                    style={{ borderColor: DANGER, color: DANGER }}
                  >
                    <X aria-hidden="true" size={16} strokeWidth={1.5} />
                    ลบไฟล์
                  </button>
                )}
              </>
            ) : null
          }
        />
      </div>
    );
  }

  return (
    <section aria-label="รายการบริจาค" aria-busy={loading} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm leading-7" style={{ color: INK_2 }}>
          {items === null ? (
            loadError ? null : 'กำลังโหลด…'
          ) : (
            <>
              <span className="font-mono tabular-nums" style={{ color: INK }}>
                {items.length}
              </span>{' '}
              รายการ · เงินรวม{' '}
              <span className="font-mono tabular-nums" style={{ color: INK }}>
                {formatSatang(moneyTotal)}
              </span>{' '}
              บาท · ยังไม่ส่งคณะ{' '}
              <span className="font-mono tabular-nums" style={{ color: notSubmitted > 0 ? INK : INK_3 }}>
                {notSubmitted}
              </span>
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={printing !== undefined}
            aria-busy={printing === null || undefined}
            onClick={() => onPrint(null)}
            className={`${PILL_GHOST} gap-1.5`}
            style={{ borderColor: RULE, color: INK }}
          >
            <Printer aria-hidden="true" size={16} strokeWidth={1.5} />
            {printing === null ? 'กำลังเปิดหน้าพิมพ์…' : 'พิมพ์ฟอร์มเปล่า'}
          </button>
          <button
            type="button"
            disabled={loading || busy}
            aria-busy={loading || undefined}
            onClick={() => load()}
            className={`${PILL_GHOST} gap-1.5`}
            style={{ borderColor: RULE, color: INK }}
          >
            <RotateCw aria-hidden="true" size={16} strokeWidth={1.5} className={loading ? 'motion-safe:animate-spin' : ''} />
            {loading ? 'กำลังโหลด…' : 'โหลดใหม่'}
          </button>
          {formTarget !== 'new' && (
            <button
              id="donation-add-button"
              type="button"
              disabled={busy}
              onClick={() => openForm('new')}
              className={`${PILL_GHOST} gap-1.5`}
              style={{ borderColor: RULE, color: INK }}
            >
              <Plus aria-hidden="true" size={16} strokeWidth={1.5} />
              เพิ่มรายการบริจาค
            </button>
          )}
        </div>
      </div>

      <p className="max-w-[72ch] text-xs leading-6" style={{ color: INK_3 }}>
        ขั้นตอน: บันทึกรายการ → พิมพ์ฟอร์มให้ผู้บริจาคเซ็น (บริจาคเงิน: หากกรอกเลขผู้เสียภาษีและที่อยู่ไว้จะพิมพ์ลงฟอร์มให้อัตโนมัติ
        ถ้าเว้นว่างจะเว้นบรรทัดให้เขียนเอง · สิ่งของ: ฟอร์มไม่มีช่องเลขผู้เสียภาษี เพราะนำไปลดหย่อนภาษีไม่ได้) →
        อัปโหลดฟอร์มที่เซ็นแล้วและสลิปโอน → ส่งคณะแล้วกด “ส่งคณะแล้ว”
      </p>

      {loadError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm leading-7" style={{ color: DANGER }}>
            {loadError}
          </p>
          <button type="button" disabled={loading} onClick={() => load()} className={PILL_GHOST} style={{ borderColor: RULE, color: INK }}>
            ลองใหม่
          </button>
        </div>
      )}

      {notice && <NoticeBanner notice={notice} />}

      {formTarget === 'new' && renderForm()}

      {items && items.length === 0 && formTarget !== 'new' && (
        <p className="text-sm leading-7" style={{ color: INK_3 }}>
          ยังไม่มีรายการบริจาค กด “เพิ่มรายการบริจาค” หรือสร้างจากแท็บผู้สนใจสนับสนุน
        </p>
      )}

      {items && items.length > 0 && (
        <ul className="flex flex-col border-t" style={{ borderColor: RULE }} aria-label="รายการบริจาค (ใหม่สุดก่อน)">
          {items.map((d) => {
            const confirming = confirmDeleteId === d.id;
            const deleting = busyKey === `delete-${d.id}`;
            const toggling = busyKey === `faculty-${d.id}`;
            const fileCount = FILE_KINDS.filter((k) => d.files[k]).length;
            return (
              <li key={d.id} className="border-b py-4" style={{ borderColor: RULE }}>
                <div className="flex flex-col gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="min-w-0 break-words text-base font-semibold leading-7" style={{ color: INK }}>
                        {d.donorName}
                      </p>
                      <span
                        className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5"
                        style={{ borderColor: RULE, color: INK_2 }}
                      >
                        {SPONSOR_KIND_LABELS[d.kind]}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5"
                        style={{ borderColor: d.facultySubmitted ? SUCCESS : WARNING, color: d.facultySubmitted ? INK : INK_2 }}
                      >
                        {d.facultySubmitted && <Check aria-hidden="true" size={12} strokeWidth={2} style={{ color: SUCCESS }} />}
                        {d.facultySubmitted ? 'ส่งคณะแล้ว' : 'ยังไม่ส่งคณะ'}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-sm leading-7" style={{ color: INK }}>
                      {d.kind === 'money' ? (
                        d.amount ? (
                          <>
                            <span className="font-mono tabular-nums">{formatAmount(d.amount)}</span> บาท
                          </>
                        ) : (
                          <span style={{ color: INK_3 }}>ไม่ระบุจำนวนเงิน</span>
                        )
                      ) : (
                        <>
                          <span className="whitespace-pre-line">{d.goodsDescription}</span>
                          {d.amount && (
                            <span style={{ color: INK_2 }}>
                              {' '}
                              · มูลค่าประมาณ <span className="font-mono tabular-nums">{formatAmount(d.amount)}</span> บาท
                            </span>
                          )}
                        </>
                      )}
                    </p>
                    <p className="text-xs leading-6" style={{ color: INK_3 }}>
                      {d.donatedOn ? `บริจาค ${formatYmdShort(d.donatedOn)}` : 'ไม่ระบุวันที่บริจาค'}
                      {d.phone && (
                        <>
                          {' '}
                          · โทร <span className="font-mono">{formatPhone(d.phone)}</span>
                        </>
                      )}
                      {d.facultySubmitted && d.facultySubmittedAt && <> · ส่งคณะเมื่อ {formatBangkokDateTime(d.facultySubmittedAt)}</>}
                    </p>
                    {((d.kind === 'money' && d.taxId) || (d.kind === 'money' ? formatThaiAddress(d) || d.address : d.address)) && (
                      <div className="mt-1 flex flex-col gap-0.5 text-sm leading-6" style={{ color: INK_2 }}>
                        {d.kind === 'money' && d.taxId && (
                          <p className="break-words">
                            <span style={{ color: INK_3 }}>เลขประจำตัวผู้เสียภาษี/บัตรประชาชน: </span>
                            <span className="font-mono tabular-nums" style={{ color: INK }}>
                              {formatThaiTaxId(d.taxId)}
                            </span>
                          </p>
                        )}
                        {(d.kind === 'money' ? formatThaiAddress(d) || d.address : d.address) && (
                          <p className="max-w-[68ch] whitespace-pre-line break-words">
                            <span style={{ color: INK_3 }}>ที่อยู่: </span>
                            {d.kind === 'money' ? formatThaiAddress(d) || d.address : d.address}
                          </p>
                        )}
                      </div>
                    )}
                    {d.note && (
                      <p className="mt-1 max-w-[68ch] whitespace-pre-line break-words text-sm leading-[1.75]" style={{ color: INK_2 }}>
                        <span className="sr-only">หมายเหตุ: </span>
                        {d.note}
                      </p>
                    )}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    {renderFile(d, 'signed')}
                    {renderFile(d, 'slip')}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      id={`donation-edit-${d.id}`}
                      type="button"
                      disabled={busy || formTarget === d.id}
                      aria-expanded={formTarget === d.id}
                      aria-label={`แก้ไขรายการของ ${d.donorName}`}
                      onClick={() => openForm(d)}
                      className={`${PILL_GHOST} gap-1.5`}
                      style={{ borderColor: RULE, color: INK }}
                    >
                      <Pencil aria-hidden="true" size={16} strokeWidth={1.5} />
                      แก้ไข
                    </button>
                    <button
                      id={`donation-print-${d.id}`}
                      type="button"
                      disabled={printing !== undefined}
                      aria-busy={printing === d || undefined}
                      aria-label={`พิมพ์ฟอร์มของ ${d.donorName}`}
                      onClick={() => onPrint(d)}
                      className={`${PILL_GHOST} gap-1.5`}
                      style={{ borderColor: RULE, color: INK }}
                    >
                      <Printer aria-hidden="true" size={16} strokeWidth={1.5} />
                      {printing === d ? 'กำลังเปิดหน้าพิมพ์…' : 'พิมพ์ฟอร์ม'}
                    </button>
                    <StatefulButton
                      type="button"
                      disabled={busy}
                      aria-pressed={d.facultySubmitted}
                      busy={toggling}
                      busyLabel="กำลังบันทึก…"
                      doneSignal={facultyDone?.id === d.id ? facultyDone.n : undefined}
                      icon={<Check aria-hidden="true" size={16} strokeWidth={1.5} style={{ color: d.facultySubmitted ? SUCCESS : INK_3 }} />}
                      onClick={() => onToggleFaculty(d)}
                      className={`${PILL_GHOST} gap-1.5`}
                      style={{ borderColor: d.facultySubmitted ? SUCCESS : RULE, color: INK }}
                    >
                      ส่งคณะแล้ว
                    </StatefulButton>
                    <button
                      id={`donation-delete-${d.id}`}
                      type="button"
                      disabled={busy}
                      aria-expanded={confirming}
                      aria-controls={confirming ? `donation-delete-strip-${d.id}` : undefined}
                      aria-label={`ลบรายการของ ${d.donorName}`}
                      onClick={() => {
                        setNotice(null);
                        setConfirmFileKey(null);
                        setConfirmDeleteId(confirming ? null : d.id);
                      }}
                      className={PILL_DANGER}
                      style={{ borderColor: DANGER, color: DANGER, backgroundColor: confirming ? DANGER_TINT : undefined }}
                    >
                      <Trash2 aria-hidden="true" size={16} strokeWidth={1.5} />
                      ลบ
                    </button>
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {confirming && (
                    <RevealPanel key="confirm-delete">
                      <div
                        id={`donation-delete-strip-${d.id}`}
                        role="region"
                        aria-label={`ยืนยันการลบรายการของ ${d.donorName}`}
                        className="mt-4 rounded-xl border p-4"
                        style={{ borderColor: DANGER, backgroundColor: SURFACE_SUBTLE }}
                      >
                        <p className="flex items-start gap-2 text-sm font-semibold leading-6" style={{ color: INK }}>
                          <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: DANGER }} />
                          <span className="min-w-0 break-words">ยืนยันลบรายการบริจาคของ “{d.donorName}”?</span>
                        </p>
                        <p className="mt-1 text-sm leading-6" style={{ color: INK_2 }}>
                          {fileCount > 0
                            ? `ไฟล์แนบ ${fileCount} ไฟล์ (ฟอร์มที่เซ็นแล้ว/สลิปโอน) จะถูกลบจากเซิร์ฟเวอร์ไปด้วย กู้คืนไม่ได้`
                            : 'รายการนี้จะหายไปถาวร กู้คืนไม่ได้ (ไฟล์แนบที่มีจะถูกลบไปด้วย)'}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            aria-busy={deleting || undefined}
                            onClick={() => onConfirmDelete(d)}
                            className={CONFIRM_BTN}
                            style={{ borderColor: DANGER, color: DANGER }}
                          >
                            {deleting ? 'กำลังลบ…' : 'ยืนยันลบ'}
                          </button>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => {
                              setConfirmDeleteId(null);
                              focusLater(`donation-delete-${d.id}`);
                            }}
                            className={LINK_BTN}
                            style={{ color: INK_2 }}
                          >
                            ยกเลิก
                          </button>
                        </div>
                      </div>
                    </RevealPanel>
                  )}
                </AnimatePresence>

                {formTarget === d.id && <div className="mt-4">{renderForm()}</div>}
              </li>
            );
          })}
        </ul>
      )}

      {printing !== undefined && <SponsorFormPrint donation={printing} onDone={() => setPrinting(undefined)} />}
    </section>
  );
}
