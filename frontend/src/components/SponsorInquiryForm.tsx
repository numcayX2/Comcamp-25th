/**
 * /sponsor — public sponsor inquiry form, in two ways: type the inquiry on the web, or (cash
 * donations only) send the faculty donation form already filled and signed (PDF or a photo/scan).
 * A goods donation cannot be claimed as a tax deduction, so it has no form to download or send.
 *
 * - Every value lives in React state only: nothing is written to localStorage, sessionStorage or
 *   cookies (AGENTS.md §9.2 / §13.5). The attached form is only held as a File until it is sent.
 * - Synchronous useRef lock + disabled + aria-busy stop a double submit; there is no idempotency
 *   key here because a repeated inquiry is harmless and the server owns deduplication.
 * - Turnstile follows RegisterSection exactly: widget / dev-skip / missing-key. The widget stays
 *   mounted across a mode switch, so one solved challenge serves either way of sending.
 * - Kind is asked first; only "money" reveals the web/file toggle. `#sponsor-upload` in the URL,
 *   or any click on a link to it (even a repeat click), selects money + upload mode.
 */
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Check, FileDown, FileText, Image as ImageIcon, Send, TriangleAlert, Upload } from 'lucide-react';
import {
  ApiHttpError,
  SPONSOR_ADDRESS_LINE_MAX,
  SPONSOR_AREA_MAX,
  SPONSOR_DETAILS_MAX,
  SPONSOR_KIND_LABELS,
  SPONSOR_NAME_MAX,
  sanitizeDigits,
  stripZeroWidth,
  submitSponsorFormUpload,
  submitSponsorInquiry,
  type SponsorKind,
} from '../lib/api';
import { SPONSOR_FORM_FILENAME, SPONSOR_FORM_PDF } from '../lib/camp-facts';
import { canonicalProvince } from '../lib/provinces';
import { formatBytes, middleTruncate } from '../lib/slip-upload';
import { SPONSOR_FORM_ACCEPT, prepareSponsorFormFile } from '../lib/sponsor-upload';
import { isValidPostcode, isValidThaiTaxId, normalizePostcode, normalizeThaiTaxId } from '../lib/thai-tax-id';
import { ProvinceCombobox } from './ProvinceCombobox';
import { TurnstileField, type TurnstileFieldHandle } from './register/TurnstileField';
import { formatPhone } from './admin/sponsor-ui';

const TURNSTILE_SITE_KEY = String(import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();
const CAPTCHA_MODE: 'widget' | 'dev-skip' | 'missing-key' = TURNSTILE_SITE_KEY
  ? 'widget'
  : import.meta.env.DEV
    ? 'dev-skip'
    : 'missing-key';

const CAPTCHA_MISSING_MESSAGE =
  'ยังไม่ได้ยืนยันตัวตน กรุณารอให้ช่องยืนยันด้านบนขึ้นเครื่องหมายถูก แล้วกดส่งอีกครั้ง';
const CAPTCHA_FAILED_MESSAGE =
  'การยืนยันตัวตนไม่ผ่านหรือหมดอายุ กรุณายืนยันใหม่อีกครั้งแล้วกดส่งอีกครั้ง';
const CAPTCHA_UNAVAILABLE_MESSAGE =
  'ระบบยืนยันตัวตนยังไม่พร้อมใช้งาน จึงยังส่งข้อมูลไม่ได้ กรุณาโทรหาสตาฟค่าย';
const CAPTCHA_LOAD_FAILED_MESSAGE = (
  <>
    โหลดการยืนยันตัวตนไม่สำเร็จ กรุณาโหลดหน้านี้ใหม่แล้วลองอีกครั้ง หากยังไม่ขึ้น{' '}
    <a className="sp-link sp-link--inline" href="#contact">
      โทรหาสตาฟค่าย
    </a>
    ได้เลย
  </>
);
const SEND_FAILED_MESSAGE = 'ส่งไม่สำเร็จ กรุณาลองใหม่ หรือโทรหาสตาฟค่าย';
const VALIDATION_FAILED_MESSAGE = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
const FILE_REJECTED_MESSAGE = 'ระบบไม่รับไฟล์นี้ กรุณาเลือกไฟล์ PDF หรือรูปภาพ (JPG, PNG, WebP) ใหม่';
/** Only a server complaint about the attachment deserves the file-specific wording. */
const FILE_VALIDATION_MESSAGE_RE = /file|pdf|image|mime|size/i;

const KIND_OPTIONS: SponsorKind[] = ['money', 'goods'];
const UPLOAD_HASH = '#sponsor-upload';
const PHONE_RE = /^0\d{8,9}$/;

type Mode = 'web' | 'file';
const MODE_LABELS: Record<Mode, string> = {
  web: 'กรอกข้อมูลบนเว็บ',
  file: 'แนบแบบฟอร์มบริจาคเงินที่กรอกแล้ว',
};

/** Shown under the kind choice once one is picked: only a cash donation goes through the faculty's tax form. */
function kindHint(kind: SponsorKind, mode: Mode): string {
  if (kind === 'goods') {
    return 'สนับสนุนด้วยสิ่งของนำไปลดหย่อนภาษีไม่ได้ จึงไม่ต้องใช้แบบฟอร์มบริจาค แจ้งรายการสิ่งของในช่องรายละเอียดด้านล่าง';
  }
  return mode === 'file'
    ? 'บริจาคเงินนำไปลดหย่อนภาษีได้ผ่านคณะวิทยาศาสตร์ แนบแบบฟอร์มบริจาคเงินที่กรอกและลงนามแล้วด้านล่าง'
    : 'บริจาคเงินนำไปลดหย่อนภาษีได้ผ่านคณะวิทยาศาสตร์ สตาฟค่ายจะส่งแบบฟอร์มบริจาคเงินให้ลงนาม หรือจะแนบแบบฟอร์มที่กรอกแล้วเองก็ได้';
}

function detailsPlaceholder(kind: SponsorKind | '', mode: Mode): string {
  if (kind === 'goods') return 'เช่น รายการสิ่งของและจำนวน';
  if (kind === 'money' && mode === 'file') return 'เช่น ช่วงเวลาที่สะดวกให้ติดต่อกลับ';
  if (kind === 'money') return 'เช่น จำนวนเงินโดยประมาณ หรือช่วงเวลาที่สะดวกให้ติดต่อกลับ';
  return 'เช่น จำนวนเงินโดยประมาณ หรือรายการสิ่งของ';
}

type FieldKey =
  | 'name'
  | 'phone'
  | 'email'
  | 'kind'
  | 'file'
  | 'taxId'
  | 'addressLine'
  | 'subdistrict'
  | 'district'
  | 'province'
  | 'postcode';
type FieldErrors = Partial<Record<FieldKey, ReactNode>>;

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const runeLength = (s: string) => [...s].length;

function emailError(value: string): ReactNode | undefined {
  const email = stripZeroWidth(value).trim();
  if (!email) return undefined;

  const at = email.indexOf('@');
  const local = at >= 0 ? email.slice(0, at) : '';
  const domain = at >= 0 ? email.slice(at + 1) : '';
  const invalid =
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.includes('..') ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.');

  if (!invalid) return undefined;
  return (
    <>
      รูปแบบอีเมลไม่ถูกต้อง เช่น <span className="font-mono">name@example.com</span>
    </>
  );
}

function errorMessage(err: unknown, mode: Mode): ReactNode {
  if (err instanceof ApiHttpError) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      return (
        <>
          ไฟล์ใหญ่เกิน <span className="font-mono tabular-nums">8</span> MB กรุณาถ่ายรูปแบบฟอร์มใหม่ หรือสแกนให้ไฟล์เล็กลง
        </>
      );
    }
    if (err.code === 'INVALID_IMAGE_DIMENSIONS') return 'รูปมีขนาดใหญ่เกินไป กรุณาถ่ายรูปแบบฟอร์มใหม่';
    if (err.code === 'VALIDATION_ERROR') {
      return mode === 'file' && FILE_VALIDATION_MESSAGE_RE.test(err.message)
        ? FILE_REJECTED_MESSAGE
        : VALIDATION_FAILED_MESSAGE;
    }
    if (err.code === 'CAPTCHA_FAILED') return CAPTCHA_FAILED_MESSAGE;
    if (err.code === 'RATE_LIMITED') {
      const seconds = err.retryAfterSeconds;
      if (typeof seconds === 'number' && seconds > 0) {
        return (
          <>
            ส่งบ่อยเกินไป กรุณารอ <span className="font-mono tabular-nums">{seconds}</span> วินาที
          </>
        );
      }
      return 'ส่งบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
  }
  return SEND_FAILED_MESSAGE;
}

export default function SponsorInquiryForm() {
  const [mode, setMode] = useState<Mode>('web');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<SponsorKind | ''>('');
  const [taxId, setTaxId] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [subdistrict, setSubdistrict] = useState('');
  const [district, setDistrict] = useState('');
  const [province, setProvince] = useState('');
  const [postcode, setPostcode] = useState('');
  const [details, setDetails] = useState('');
  const [website, setWebsite] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<ReactNode | null>(null);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Mode | null>(null);
  const [submittedPhone, setSubmittedPhone] = useState('');
  const [hydrated, setHydrated] = useState(false);

  const busyRef = useRef(false);
  /** Bumped on every pick so a slow re-encode of an older pick never overwrites a newer one. */
  const pickRef = useRef(0);
  const focusFormOnReset = useRef(false);
  const captchaRef = useRef<TurnstileFieldHandle>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const taxIdRef = useRef<HTMLInputElement>(null);
  const addressLineRef = useRef<HTMLInputElement>(null);
  const subdistrictRef = useRef<HTMLInputElement>(null);
  const districtRef = useRef<HTMLInputElement>(null);
  const postcodeRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  /** Latest `done` for the document-level link listener, which is bound once. */
  const doneRef = useRef<Mode | null>(null);
  doneRef.current = done;

  useEffect(() => {
    if (done) {
      successRef.current?.focus();
    } else if (focusFormOnReset.current) {
      focusFormOnReset.current = false;
      kindRef.current?.focus();
    }
  }, [done]);

  useEffect(() => {
    setHydrated(true);
    const syncHash = () => {
      if (window.location.hash === UPLOAD_HASH && !busyRef.current) openUpload();
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  // A link to #sponsor-upload clicked again (hash already set) fires no hashchange.
  useEffect(() => {
    const onUploadLinkClick = (event: MouseEvent) => {
      if (busyRef.current) return;
      if (!(event.target instanceof Element) || !event.target.closest(`a[href="${UPLOAD_HASH}"]`)) return;
      openUpload();
    };
    document.addEventListener('click', onUploadLinkClick);
    return () => document.removeEventListener('click', onUploadLinkClick);
  }, []);

  function clearError(key: FieldKey) {
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  /** Drops the chosen file; bumping pickRef also discards a re-encode still in flight. */
  function clearFile() {
    pickRef.current += 1;
    setPreparing(false);
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function clearFields() {
    setName('');
    setPhone('');
    setEmail('');
    setKind('');
    setTaxId('');
    setAddressLine('');
    setSubdistrict('');
    setDistrict('');
    setProvince('');
    setPostcode('');
    setDetails('');
    setWebsite('');
    clearFile();
    setErrors({});
    setFormError(null);
    setCaptchaError(null);
    setTurnstileToken('');
    setSubmittedPhone('');
  }

  /** Any route into the upload mode (hash, link click) — also from the success panel, as a fresh form. */
  function openUpload() {
    if (doneRef.current) {
      clearFields();
      setDone(null);
    }
    setKind('money');
    setMode('file');
    setErrors({});
    setFormError(null);
  }

  function clearUploadHash() {
    if (window.location.hash === UPLOAD_HASH) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  function switchMode(next: Mode) {
    if (busyRef.current || next === mode) return;
    if (next === 'file') setKind('money');
    else clearUploadHash();
    setMode(next);
    setErrors({});
    setFormError(null);
  }

  function chooseKind(next: SponsorKind) {
    if (busyRef.current) return;
    setKind(next);
    clearError('kind');
    if (next === 'goods') {
      setMode('web');
      clearUploadHash();
      clearFile();
      setErrors((prev) => ({
        ...prev,
        taxId: undefined,
        addressLine: undefined,
        subdistrict: undefined,
        district: undefined,
        province: undefined,
        postcode: undefined,
      }));
    }
  }

  function removeFile() {
    if (busyRef.current) return;
    clearFile();
    clearError('file');
    setFormError(null);
    fileRef.current?.focus();
  }

  async function pickFile(picked: File | null | undefined) {
    if (!picked || busyRef.current) return;
    const pick = ++pickRef.current;
    setPreparing(true);
    clearError('file');
    setFormError(null);
    try {
      const check = await prepareSponsorFormFile(picked);
      if (pick !== pickRef.current) return;
      if (check.ok) {
        setFile(check.file);
      } else {
        setFile(null);
        setErrors((prev) => ({ ...prev, file: check.message }));
      }
    } finally {
      if (pick === pickRef.current) setPreparing(false);
    }
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    // Reset so choosing the same file again (after an error) still fires change.
    event.target.value = '';
    void pickFile(picked);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void pickFile(event.dataTransfer.files?.[0]);
  }

  function firstInvalidField(next: FieldErrors): HTMLElement | null {
    if (next.kind) return kindRef.current;
    if (next.file) return fileRef.current;
    if (next.name) return nameRef.current;
    if (next.phone) return phoneRef.current;
    if (next.email) return emailRef.current;
    if (next.taxId) return taxIdRef.current;
    if (next.addressLine) return addressLineRef.current;
    if (next.subdistrict) return subdistrictRef.current;
    if (next.district) return districtRef.current;
    if (next.province) return document.getElementById('sp-province');
    if (next.postcode) return postcodeRef.current;
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || preparing) return;

    const cleanName = stripZeroWidth(name).trim();
    const digits = sanitizeDigits(phone);
    const cleanEmail = stripZeroWidth(email).trim();
    const cleanDetails = stripZeroWidth(details).trim();
    const next: FieldErrors = {};

    if (!cleanName) {
      next.name = 'กรุณากรอกชื่อผู้สนับสนุน ร้าน หรือบริษัท';
    } else if (cleanName.length > SPONSOR_NAME_MAX) {
      next.name = 'ชื่อผู้สนับสนุนยาวเกินกำหนด';
    }

    if (!PHONE_RE.test(digits)) {
      next.phone = (
        <>
          เบอร์โทรศัพท์ต้องเป็นตัวเลข <span className="font-mono tabular-nums">9–10</span> หลักและขึ้นต้นด้วย{' '}
          <span className="font-mono tabular-nums">0</span>
        </>
      );
    }

    const mailError = emailError(email);
    if (mailError) next.email = mailError;
    if (!kind) next.kind = 'กรุณาเลือกประเภทการสนับสนุน';
    if (mode === 'file' && !file) {
      next.file = errors.file ?? 'กรุณาแนบไฟล์แบบฟอร์มที่กรอกแล้ว';
    }

    const needsTaxAddress = kind === 'money' && mode === 'web';
    const cleanTaxId = normalizeThaiTaxId(taxId);
    const cleanAddressLine = stripZeroWidth(addressLine).trim();
    const cleanSubdistrict = stripZeroWidth(subdistrict).trim();
    const cleanDistrict = stripZeroWidth(district).trim();
    const cleanProvinceRaw = stripZeroWidth(province).trim();
    const officialProvince = canonicalProvince(cleanProvinceRaw) ?? '';
    const cleanPostcode = normalizePostcode(postcode);

    if (needsTaxAddress) {
      if (!cleanTaxId) {
        next.taxId = 'กรุณากรอกเลขประจำตัวประชาชน หรือเลขประจำตัวผู้เสียภาษี';
      } else if (!isValidThaiTaxId(cleanTaxId)) {
        next.taxId = 'เลขไม่ถูกต้อง กรุณาตรวจอีกครั้ง';
      }

      if (!cleanAddressLine) {
        next.addressLine = 'กรุณากรอกบ้านเลขที่ หมู่ ซอย หรือถนน';
      } else if (runeLength(cleanAddressLine) > SPONSOR_ADDRESS_LINE_MAX) {
        next.addressLine = (
          <>
            บ้านเลขที่/ถนนยาวได้ไม่เกิน <span className="font-mono tabular-nums">{SPONSOR_ADDRESS_LINE_MAX}</span> ตัวอักษร
          </>
        );
      } else if (CONTROL_CHARS_RE.test(cleanAddressLine)) {
        next.addressLine = 'ที่อยู่มีอักขระที่ใช้ไม่ได้';
      }

      if (!cleanSubdistrict) {
        next.subdistrict = 'กรุณากรอกตำบล/แขวง';
      } else if (runeLength(cleanSubdistrict) > SPONSOR_AREA_MAX) {
        next.subdistrict = (
          <>
            ตำบล/แขวงยาวได้ไม่เกิน <span className="font-mono tabular-nums">{SPONSOR_AREA_MAX}</span> ตัวอักษร
          </>
        );
      } else if (CONTROL_CHARS_RE.test(cleanSubdistrict)) {
        next.subdistrict = 'ตำบล/แขวงมีอักขระที่ใช้ไม่ได้';
      }

      if (!cleanDistrict) {
        next.district = 'กรุณากรอกอำเภอ/เขต';
      } else if (runeLength(cleanDistrict) > SPONSOR_AREA_MAX) {
        next.district = (
          <>
            อำเภอ/เขตยาวได้ไม่เกิน <span className="font-mono tabular-nums">{SPONSOR_AREA_MAX}</span> ตัวอักษร
          </>
        );
      } else if (CONTROL_CHARS_RE.test(cleanDistrict)) {
        next.district = 'อำเภอ/เขตมีอักขระที่ใช้ไม่ได้';
      }

      if (!cleanProvinceRaw) {
        next.province = 'กรุณาเลือกจังหวัด';
      } else if (!officialProvince) {
        next.province = 'กรุณาเลือกจังหวัดจากรายการ';
      }

      if (!cleanPostcode) {
        next.postcode = 'กรุณากรอกรหัสไปรษณีย์';
      } else if (!isValidPostcode(cleanPostcode)) {
        next.postcode = (
          <>
            รหัสไปรษณีย์ต้องเป็นตัวเลข <span className="font-mono tabular-nums">5</span> หลัก
          </>
        );
      }
    }

    setErrors(next);
    setFormError(null);

    const firstInvalid = firstInvalidField(next);
    if (firstInvalid) {
      requestAnimationFrame(() => firstInvalid.focus());
      return;
    }

    if (CAPTCHA_MODE === 'missing-key') return;

    if (CAPTCHA_MODE === 'widget' && !turnstileToken) {
      setCaptchaError(CAPTCHA_MISSING_MESSAGE);
      captchaRef.current?.focus();
      return;
    }

    busyRef.current = true;
    setBusy(true);

    try {
      if (mode === 'file') {
        if (!file) return;
        setProgress(0);
        await submitSponsorFormUpload(
          { name: cleanName, phone: digits, email: cleanEmail, details: cleanDetails, turnstileToken, website },
          file,
          setProgress,
        );
      } else {
        if (!kind) return;
        await submitSponsorInquiry({
          name: cleanName,
          phone: digits,
          email: cleanEmail,
          kind,
          details: cleanDetails,
          ...(needsTaxAddress
            ? {
                taxId: cleanTaxId,
                addressLine: cleanAddressLine,
                subdistrict: cleanSubdistrict,
                district: cleanDistrict,
                province: officialProvince,
                postcode: cleanPostcode,
              }
            : {}),
          turnstileToken,
          website,
        });
      }
      setSubmittedPhone(digits);
      setDone(mode);
    } catch (err) {
      const captchaFailed = err instanceof ApiHttpError && err.code === 'CAPTCHA_FAILED';
      setFormError(captchaFailed ? null : errorMessage(err, mode));
      captchaRef.current?.reset();
      if (captchaFailed) {
        setCaptchaError(CAPTCHA_FAILED_MESSAGE);
        captchaRef.current?.focus();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
  }

  function resetForm() {
    clearFields();
    setMode('web');
    clearUploadHash();
    focusFormOnReset.current = true;
    setDone(null);
  }

  const fileMode = mode === 'file';
  let submitLabel: ReactNode;
  if (busy && fileMode) {
    submitLabel = (
      <>
        กำลังส่งไฟล์… <span className="font-mono tabular-nums">{progress ?? 0}%</span>
      </>
    );
  } else if (busy) {
    submitLabel = 'กำลังส่ง…';
  } else {
    submitLabel = (
      <>
        <span>{fileMode ? 'ส่งแบบฟอร์มให้สตาฟค่าย' : 'ส่งข้อมูลให้สตาฟค่าย'}</span>
        <Send className="sp-ico" size={16} strokeWidth={1.5} aria-hidden="true" />
      </>
    );
  }
  const isPdfFile = file ? file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name)) : false;
  const FileIcon = isPdfFile ? FileText : ImageIcon;

  return (
    <div className="sp-inquiry">
      <h2 id="sp-inquiry-title" className="sp-h2">
        แจ้งความประสงค์สนับสนุน
      </h2>
      <p className="sp-inquiry__lead">
        กรอกข้อมูลบนเว็บ หรือหากบริจาคเงิน แนบแบบฟอร์มบริจาคเงินที่กรอกแล้วแทนก็ได้{' '}
        <span className="whitespace-nowrap">สตาฟค่าย</span>จะติดต่อกลับเพื่อยืนยันรายละเอียดและนัดหมายขั้นตอนถัดไป
      </p>

      {done ? (
        <div
          className="sp-success"
          ref={successRef}
          role="status"
          tabIndex={-1}
          aria-labelledby="sp-success-title"
          aria-describedby="sp-success-text"
        >
          <span className="sp-success__mark" aria-hidden="true">
            <Check size={16} strokeWidth={1.5} />
          </span>
          <h3 id="sp-success-title" className="sp-success__title">
            {done === 'file' ? 'ได้รับแบบฟอร์มแล้ว' : 'ได้รับข้อมูลแล้ว'}
          </h3>
          <p id="sp-success-text" className="sp-success__text">
            สตาฟค่ายจะโทรกลับที่เบอร์{' '}
            <span className="font-mono tabular-nums">{formatPhone(submittedPhone)}</span>{' '}
            {done === 'file'
              ? 'เพื่อตรวจแบบฟอร์มและยืนยันรายละเอียด'
              : kind === 'money'
                ? 'เพื่อยืนยันรายละเอียดและประสานแบบฟอร์มบริจาคเงิน'
                : 'เพื่อยืนยันรายละเอียดและนัดหมายรับสิ่งของ'}
          </p>
          <button type="button" className="sp-btn sp-btn--secondary" onClick={resetForm}>
            ส่งอีกครั้ง
          </button>
        </div>
      ) : (
        <>
          <form className="sp-form" method="post" noValidate onSubmit={handleSubmit} aria-labelledby="sp-inquiry-title">
            <div className="sp-hp" aria-hidden="true">
              <label htmlFor="sp-website">Website</label>
              <input
                id="sp-website"
                name="website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                disabled={busy}
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
              />
            </div>

            <fieldset
              id="sponsor-upload"
              className="sp-fieldset sp-kind sp-field--full"
              aria-describedby={`sp-kind-hint${errors.kind ? ' sp-kind-err' : ''}`}
            >
              <legend className="sp-label">
                <span>
                  ประเภทการสนับสนุน <span className="sp-req" aria-hidden="true">*</span>
                  <span className="sr-only"> (จำเป็น)</span>
                </span>
              </legend>
              <div className="sp-choices">
                {KIND_OPTIONS.map((option, index) => (
                  <label className="sp-choice" key={option}>
                    <input
                      className="sp-choice__input"
                      type="radio"
                      name="kind"
                      value={option}
                      ref={index === 0 ? kindRef : undefined}
                      checked={kind === option}
                      required={index === 0}
                      disabled={busy}
                      onChange={() => chooseKind(option)}
                      aria-invalid={errors.kind ? true : undefined}
                      aria-describedby={errors.kind ? 'sp-kind-err' : undefined}
                    />
                    <span className="sp-choice__pill">{SPONSOR_KIND_LABELS[option]}</span>
                  </label>
                ))}
              </div>
              <p id="sp-kind-hint" className="sp-hint sp-hint--wrap sp-kind-hint" aria-live="polite">
                {kind ? kindHint(kind, mode) : 'เลือกประเภทการสนับสนุนเพื่อดูรายละเอียด'}
              </p>
              {errors.kind && (
                <p id="sp-kind-err" className="sp-error">
                  <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>{errors.kind}</span>
                </p>
              )}
            </fieldset>

            {kind === 'money' && (
              <fieldset className="sp-fieldset sp-method sp-field--full">
                <legend className="sp-label">วิธีส่งข้อมูล</legend>
                <div className="sp-choices">
                  {(['web', 'file'] as const).map((option) => (
                    <label className="sp-choice" key={option}>
                      <input
                        className="sp-choice__input"
                        type="radio"
                        name="sp-method"
                        value={option}
                        checked={mode === option}
                        disabled={busy}
                        onChange={() => switchMode(option)}
                      />
                      <span className="sp-choice__pill">{MODE_LABELS[option]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {fileMode && (
              <div className="sp-field--full sp-upload">
                <ol className="sp-upload__steps">
                  <li className="sp-upload__step">
                    <span className="sp-upload__no font-mono tabular-nums" aria-hidden="true">
                      1
                    </span>
                    <div className="sp-upload__body">
                      <p className="sp-upload__text">ดาวน์โหลดแบบฟอร์มบริจาคเงินของคณะ</p>
                      <a className="sp-btn sp-btn--secondary sp-btn--sm" href={SPONSOR_FORM_PDF} download={SPONSOR_FORM_FILENAME}>
                        <FileDown className="sp-ico" size={16} strokeWidth={1.5} aria-hidden="true" />
                        <span>ดาวน์โหลดแบบฟอร์ม</span>
                        <span className="sp-btn__meta font-mono">PDF</span>
                      </a>
                    </div>
                  </li>
                  <li className="sp-upload__step">
                    <span className="sp-upload__no font-mono tabular-nums" aria-hidden="true">
                      2
                    </span>
                    <p className="sp-upload__text">
                      กรอกข้อมูลในแบบฟอร์มให้ครบ รวมเลขประจำตัวผู้เสียภาษี/เลขบัตรประชาชนและที่อยู่ พร้อมลงนาม
                      จะพิมพ์ออกมาเขียน หรือกรอกในไฟล์ PDF ก็ได้
                    </p>
                  </li>
                  <li className="sp-upload__step">
                    <span className="sp-upload__no font-mono tabular-nums" aria-hidden="true">
                      3
                    </span>
                    <p className="sp-upload__text">ถ่ายรูปหรือสแกนให้เห็นทั้งแผ่น แล้วแนบไฟล์ด้านล่าง</p>
                  </li>
                </ol>

                <div className="sp-field">
                  <span className="sp-label" id="sp-file-label">
                    <span>
                      ไฟล์แบบฟอร์มที่กรอกแล้ว <span className="sp-req" aria-hidden="true">*</span>
                      <span className="sr-only"> (จำเป็น)</span>
                    </span>
                  </span>
                  <label
                    className="sp-drop"
                    data-drag={dragging || undefined}
                    data-filled={file ? true : undefined}
                    data-invalid={errors.file ? true : undefined}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (!busy) setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                  >
                    <input
                      ref={fileRef}
                      id="sp-file"
                      name="file"
                      className="sp-drop__input"
                      type="file"
                      accept={SPONSOR_FORM_ACCEPT}
                      disabled={busy}
                      onChange={onFileInput}
                      aria-labelledby="sp-file-label"
                      aria-invalid={errors.file ? true : undefined}
                      aria-describedby={`sp-file-state sp-file-hint${errors.file ? ' sp-file-err' : ''}`}
                    />
                    {file ? (
                      <>
                        <FileIcon className="sp-drop__icon" size={20} strokeWidth={1.5} aria-hidden="true" />
                        <span className="sp-drop__text" id="sp-file-state">
                          <span className="sp-drop__name">{middleTruncate(file.name, 34)}</span>
                          <span className="sp-drop__meta font-mono tabular-nums">{formatBytes(file.size)}</span>
                        </span>
                        {/* The whole label opens the picker; this is its visible cue. */}
                        <span className="sp-drop__action" aria-hidden="true">
                          เปลี่ยนไฟล์
                        </span>
                      </>
                    ) : (
                      <>
                        <Upload className="sp-drop__icon" size={20} strokeWidth={1.5} aria-hidden="true" />
                        <span className="sp-drop__text" id="sp-file-state">
                          <span className="sp-drop__name">
                            {preparing ? 'กำลังเตรียมไฟล์…' : 'เลือกไฟล์ หรือถ่ายรูปแบบฟอร์ม'}
                          </span>
                        </span>
                      </>
                    )}
                  </label>
                  {file && (
                    <div className="sp-drop__actions">
                      <button
                        type="button"
                        className="sp-btn sp-btn--secondary sp-btn--sm"
                        disabled={busy}
                        onClick={removeFile}
                        aria-describedby="sp-file-state"
                      >
                        ลบไฟล์
                      </button>
                    </div>
                  )}
                  <p id="sp-file-hint" className="sp-hint sp-hint--wrap">
                    PDF, JPG, PNG หรือ WebP ไม่เกิน <span className="font-mono tabular-nums">8</span> MB
                    รูปขนาดใหญ่จะถูกย่อให้อัตโนมัติ
                  </p>
                  {errors.file && (
                    <p id="sp-file-err" className="sp-error" role="alert">
                      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span>{errors.file}</span>
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="sp-field sp-field--full">
              <label className="sp-label" htmlFor="sp-name">
                <span>
                  ชื่อผู้สนับสนุน / ร้าน / บริษัท <span className="sp-req" aria-hidden="true">*</span>
                  <span className="sr-only"> (จำเป็น)</span>
                </span>
              </label>
              <input
                id="sp-name"
                name="name"
                ref={nameRef}
                className="sp-input"
                type="text"
                autoComplete="organization"
                maxLength={SPONSOR_NAME_MAX}
                required
                disabled={busy}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clearError('name');
                }}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? 'sp-name-err' : undefined}
              />
              {errors.name && (
                <p id="sp-name-err" className="sp-error">
                  <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>{errors.name}</span>
                </p>
              )}
            </div>

            <div className="sp-field">
              <label className="sp-label" htmlFor="sp-phone">
                <span>
                  เบอร์โทรศัพท์ <span className="sp-req" aria-hidden="true">*</span>
                  <span className="sr-only"> (จำเป็น)</span>
                </span>
              </label>
              <input
                id="sp-phone"
                name="phone"
                ref={phoneRef}
                className="sp-input sp-input--mono"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0812345678 หรือ 053123456"
                required
                disabled={busy}
                value={phone}
                onChange={(event) => {
                  setPhone(sanitizeDigits(event.target.value).slice(0, 10));
                  clearError('phone');
                }}
                aria-invalid={errors.phone ? true : undefined}
                aria-describedby={errors.phone ? 'sp-phone-err' : undefined}
              />
              {errors.phone && (
                <p id="sp-phone-err" className="sp-error">
                  <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>{errors.phone}</span>
                </p>
              )}
            </div>

            <div className="sp-field">
              <label className="sp-label" htmlFor="sp-email">
                <span>อีเมล</span>
                <span className="sp-label__optional">ไม่บังคับ</span>
              </label>
              <input
                id="sp-email"
                name="email"
                ref={emailRef}
                className="sp-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                disabled={busy}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clearError('email');
                }}
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? 'sp-email-err' : undefined}
              />
              {errors.email && (
                <p id="sp-email-err" className="sp-error">
                  <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>{errors.email}</span>
                </p>
              )}
            </div>

            {kind === 'money' && !fileMode && (
              <>
                <div className="sp-field sp-field--full mt-1 border-t border-[var(--color-border)] pt-5">
                  <h3 className="m-0 text-base font-bold leading-[1.45] text-[var(--color-ink)]">
                    ข้อมูลสำหรับออกเอกสารลดหย่อนภาษี
                  </h3>
                  <p className="sp-hint sp-hint--wrap">
                    ใช้เพื่อดำเนินเรื่องออกเอกสารลดหย่อนภาษีกับคณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้เท่านั้น
                  </p>
                </div>

                <div className="sp-field sp-field--full">
                  <label className="sp-label" htmlFor="sp-tax-id">
                    <span>
                      <span className="whitespace-nowrap">เลขประจำตัวประชาชน</span> /{' '}
                      <span className="whitespace-nowrap">เลขประจำตัวผู้เสียภาษี</span>{' '}
                      <span className="whitespace-nowrap">
                        (<span className="font-mono tabular-nums">13</span> หลัก)
                      </span>{' '}
                      <span className="sp-req" aria-hidden="true">*</span>
                      <span className="sr-only"> (จำเป็น)</span>
                    </span>
                  </label>
                  <input
                    id="sp-tax-id"
                    name="taxId"
                    ref={taxIdRef}
                    className="sp-input sp-input--mono"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={25}
                    placeholder="X-XXXX-XXXXX-XX-X"
                    required
                    disabled={busy}
                    value={taxId}
                    onChange={(event) => {
                      setTaxId(event.target.value);
                      clearError('taxId');
                    }}
                    aria-invalid={errors.taxId ? true : undefined}
                    aria-describedby={errors.taxId ? 'sp-tax-id-err' : undefined}
                  />
                  {errors.taxId && (
                    <p id="sp-tax-id-err" className="sp-error">
                      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span>{errors.taxId}</span>
                    </p>
                  )}
                </div>

                <div className="sp-field sp-field--full">
                  <label className="sp-label" htmlFor="sp-address-line">
                    <span>
                      บ้านเลขที่ / หมู่ / ซอย / ถนน <span className="sp-req" aria-hidden="true">*</span>
                      <span className="sr-only"> (จำเป็น)</span>
                    </span>
                  </label>
                  <input
                    id="sp-address-line"
                    name="addressLine"
                    ref={addressLineRef}
                    className="sp-input"
                    type="text"
                    autoComplete="address-line1"
                    maxLength={SPONSOR_ADDRESS_LINE_MAX}
                    placeholder="เช่น 63 หมู่ 4 ถ.เชียงใหม่-พร้าว"
                    required
                    disabled={busy}
                    value={addressLine}
                    onChange={(event) => {
                      setAddressLine(event.target.value);
                      clearError('addressLine');
                    }}
                    aria-invalid={errors.addressLine ? true : undefined}
                    aria-describedby={errors.addressLine ? 'sp-address-line-err' : undefined}
                  />
                  {errors.addressLine && (
                    <p id="sp-address-line-err" className="sp-error">
                      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span>{errors.addressLine}</span>
                    </p>
                  )}
                </div>

                <div className="sp-field">
                  <label className="sp-label" htmlFor="sp-subdistrict">
                    <span>
                      ตำบล / แขวง <span className="sp-req" aria-hidden="true">*</span>
                      <span className="sr-only"> (จำเป็น)</span>
                    </span>
                  </label>
                  <input
                    id="sp-subdistrict"
                    name="subdistrict"
                    ref={subdistrictRef}
                    className="sp-input"
                    type="text"
                    autoComplete="off"
                    maxLength={SPONSOR_AREA_MAX}
                    placeholder="เช่น หนองหาร"
                    required
                    disabled={busy}
                    value={subdistrict}
                    onChange={(event) => {
                      setSubdistrict(event.target.value);
                      clearError('subdistrict');
                    }}
                    aria-invalid={errors.subdistrict ? true : undefined}
                    aria-describedby={errors.subdistrict ? 'sp-subdistrict-err' : undefined}
                  />
                  {errors.subdistrict && (
                    <p id="sp-subdistrict-err" className="sp-error">
                      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span>{errors.subdistrict}</span>
                    </p>
                  )}
                </div>

                <div className="sp-field">
                  <label className="sp-label" htmlFor="sp-district">
                    <span>
                      อำเภอ / เขต <span className="sp-req" aria-hidden="true">*</span>
                      <span className="sr-only"> (จำเป็น)</span>
                    </span>
                  </label>
                  <input
                    id="sp-district"
                    name="district"
                    ref={districtRef}
                    className="sp-input"
                    type="text"
                    autoComplete="off"
                    maxLength={SPONSOR_AREA_MAX}
                    placeholder="เช่น สันทราย"
                    required
                    disabled={busy}
                    value={district}
                    onChange={(event) => {
                      setDistrict(event.target.value);
                      clearError('district');
                    }}
                    aria-invalid={errors.district ? true : undefined}
                    aria-describedby={errors.district ? 'sp-district-err' : undefined}
                  />
                  {errors.district && (
                    <p id="sp-district-err" className="sp-error">
                      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span>{errors.district}</span>
                    </p>
                  )}
                </div>

                <div className="sp-field">
                  <label className="sp-label" htmlFor="sp-province">
                    <span>
                      จังหวัด <span className="sp-req" aria-hidden="true">*</span>
                      <span className="sr-only"> (จำเป็น)</span>
                    </span>
                  </label>
                  <fieldset className="sp-fieldset" disabled={busy}>
                    <ProvinceCombobox
                      id="sp-province"
                      className="sp-input"
                      value={province}
                      onChange={(value) => {
                        setProvince(value);
                        clearError('province');
                      }}
                      invalid={Boolean(errors.province)}
                      describedBy={errors.province ? 'sp-province-err' : undefined}
                      required
                    />
                  </fieldset>
                  {errors.province && (
                    <p id="sp-province-err" className="sp-error">
                      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span>{errors.province}</span>
                    </p>
                  )}
                </div>

                <div className="sp-field">
                  <label className="sp-label" htmlFor="sp-postcode">
                    <span>
                      รหัสไปรษณีย์ <span className="sp-req" aria-hidden="true">*</span>
                      <span className="sr-only"> (จำเป็น)</span>
                    </span>
                  </label>
                  <input
                    id="sp-postcode"
                    name="postcode"
                    ref={postcodeRef}
                    className="sp-input sp-input--mono"
                    type="text"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={5}
                    placeholder="50290"
                    required
                    disabled={busy}
                    value={postcode}
                    onChange={(event) => {
                      setPostcode(sanitizeDigits(event.target.value).slice(0, 5));
                      clearError('postcode');
                    }}
                    aria-invalid={errors.postcode ? true : undefined}
                    aria-describedby={errors.postcode ? 'sp-postcode-err' : undefined}
                  />
                  {errors.postcode && (
                    <p id="sp-postcode-err" className="sp-error">
                      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span>{errors.postcode}</span>
                    </p>
                  )}
                </div>
              </>
            )}

            <div className="sp-field sp-field--full">
              <label className="sp-label" htmlFor="sp-details">
                <span>รายละเอียดเพิ่มเติม</span>
                {/* Same right-hand slot as the email label; the counter rides along. */}
                <span className="sp-label__optional">
                  ไม่บังคับ
                  <span aria-hidden="true">
                    {' · '}
                    <span className="font-mono tabular-nums">{details.length}</span>/
                    <span className="font-mono tabular-nums">{SPONSOR_DETAILS_MAX}</span>
                  </span>
                </span>
              </label>
              <textarea
                id="sp-details"
                name="details"
                className="sp-input sp-textarea"
                rows={5}
                maxLength={SPONSOR_DETAILS_MAX}
                placeholder={detailsPlaceholder(kind, mode)}
                disabled={busy}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
              />
            </div>

            <div className="sp-field sp-field--full sp-captcha">
              {CAPTCHA_MODE === 'widget' && (
                <TurnstileField
                  ref={captchaRef}
                  siteKey={TURNSTILE_SITE_KEY}
                  errorId="sp-captcha-err"
                  error={captchaError}
                  failedMessage={CAPTCHA_LOAD_FAILED_MESSAGE}
                  onToken={(token) => {
                    setTurnstileToken(token ?? '');
                    if (token) setCaptchaError(null);
                  }}
                />
              )}
              {CAPTCHA_MODE === 'dev-skip' && (
                <p className="sp-hint sp-hint--dev">
                  [DEV] ยังไม่ได้ตั้ง <span className="font-mono">PUBLIC_TURNSTILE_SITE_KEY</span>{' '}
                  จึงข้ามการยืนยันตัวตน (เซิร์ฟเวอร์ dev ที่ไม่มี secret ก็ข้ามเช่นกัน)
                </p>
              )}
              {CAPTCHA_MODE === 'missing-key' && (
                <p id="sp-captcha-err" className="sp-error" role="alert">
                  <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>{CAPTCHA_UNAVAILABLE_MESSAGE}</span>
                </p>
              )}
            </div>

            {formError && (
              <div className="sp-alert" role="alert">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                <div>{formError}</div>
              </div>
            )}

            <div className="sp-form__actions">
              <button
                type="submit"
                className="sp-btn sp-btn--primary"
                disabled={busy || preparing || !hydrated || CAPTCHA_MODE === 'missing-key'}
                aria-busy={busy || undefined}
              >
                {submitLabel}
              </button>
              <p className="sp-form__note">
                {fileMode
                  ? 'ไฟล์นี้เปิดดูได้เฉพาะสตาฟค่ายที่ดูแลผู้สนับสนุน และใช้เพื่อดำเนินเรื่องบริจาคเท่านั้น'
                  : kind === 'money'
                    ? 'ข้อมูลนี้ใช้เพื่อติดต่อกลับและดำเนินเรื่องเอกสารลดหย่อนภาษีกับคณะวิทยาศาสตร์เท่านั้น'
                    : 'ข้อมูลนี้ใช้เพื่อติดต่อกลับเรื่องการสนับสนุนค่ายเท่านั้น'}
              </p>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
