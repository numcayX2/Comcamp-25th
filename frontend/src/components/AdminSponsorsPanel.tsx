import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, CircleCheck, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import {
  ApiHttpError,
  SPONSOR_LOGO_MAX_BYTES,
  SPONSOR_LOGO_TYPES,
  createSponsor,
  deleteSponsor,
  fetchAdminSponsors,
  reorderSponsors,
  sponsorLogoSrc,
  updateSponsor,
  type AdminSponsor,
} from '../lib/api';
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
} from './admin-ui';

/** Backend limits (contract: name 1–120 runes, url "" or absolute http(s) ≤ 500). */
const NAME_MAX = 120;
const URL_MAX = 500;
const LOGO_ACCEPT = SPONSOR_LOGO_TYPES.join(',');

type Notice = { kind: 'ok' | 'error'; text: string } | null;
type FieldErrors = { name?: string; url?: string; logo?: string };
/** null = form closed, 'new' = add form, number = editing that sponsor id. */
type FormTarget = null | 'new' | number;

interface Props {
  token: string;
  /** Super admins only (same gate as the settings panel); others see the list read-only. */
  canEdit: boolean;
  /** Returns true when the error was an expired session, in which case the parent has logged out. */
  onAuthError: (err: unknown) => boolean;
}

function errorText(err: unknown, fallback: string, context: 'list' | 'item' = 'item'): string {
  if (err instanceof ApiHttpError) {
    if (err.status === 401 || err.status === 403) return 'เซสชันหมดอายุหรือไม่เพียงพอ กรุณาเข้าสู่ระบบใหม่';
    if (err.code === 'PAYLOAD_TOO_LARGE' || err.status === 413) return 'ไฟล์ใหญ่เกิน 2 MB';
    if (err.code === 'INVALID_IMAGE_DIMENSIONS') return 'รูปใหญ่เกิน 4096×4096 px';
    if (err.code === 'NOT_FOUND' || err.status === 404) {
      return context === 'list'
        ? 'โหลดรายการผู้สนับสนุนไม่สำเร็จ (เซิร์ฟเวอร์ยังไม่รองรับหรือบริการไม่พร้อม) ลองรีเฟรชหน้าหรือแจ้งผู้ดูแลระบบ'
        : 'ไม่พบผู้สนับสนุนรายการนี้ อาจถูกลบไปแล้ว';
    }
    if (err.status === 429) {
      return err.retryAfterSeconds
        ? `ส่งคำขอบ่อยเกินไป กรุณารอ ${err.retryAfterSeconds} วินาทีแล้วลองใหม่`
        : 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
    if (err.code === 'VALIDATION_ERROR') {
      const msg = err.message.toLowerCase();
      if (msg.includes('ids') || msg.includes('order')) return 'ลำดับไม่ตรงกับรายการล่าสุด ระบบโหลดรายการใหม่แล้ว กรุณาลองอีกครั้ง';
      if (msg.includes('url') || msg.includes('link')) return 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https:// และยาวไม่เกิน 500 ตัวอักษร';
      if (msg.includes('logo') || msg.includes('image') || msg.includes('file')) {
        return 'ไฟล์รูปไม่ถูกต้อง รองรับเฉพาะ PNG, JPG หรือ WebP (ไม่รับ SVG)';
      }
      if (msg.includes('name')) return 'ชื่อต้องมี 1–120 ตัวอักษร และอยู่ในบรรทัดเดียว';
      return 'ข้อมูลไม่ถูกต้องตามเงื่อนไข';
    }
    if (err.status >= 500) return 'เซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่';
  }
  if (err instanceof Error && err.name === 'AbortError') return 'หมดเวลาเชื่อมต่อ กรุณาลองใหม่';
  if (err instanceof Error && (err.message.includes('fetch') || err.message.includes('network'))) {
    return 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสัญญาณอินเทอร์เน็ต';
  }
  return fallback;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiHttpError && (err.code === 'NOT_FOUND' || err.status === 404);
}

/** Client-side logo check; returns a Thai message when the file must be refused. */
function logoProblem(file: File): string | null {
  const type = file.type.toLowerCase();
  if (type === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) {
    return 'ไม่รับไฟล์ SVG เพื่อความปลอดภัย กรุณาแปลงเป็น PNG, JPG หรือ WebP';
  }
  if (!(SPONSOR_LOGO_TYPES as readonly string[]).includes(type)) return 'รองรับเฉพาะไฟล์ PNG, JPG หรือ WebP';
  if (file.size > SPONSOR_LOGO_MAX_BYTES) return 'ไฟล์ใหญ่เกิน 2 MB';
  if (file.size === 0) return 'ไฟล์ว่างเปล่า กรุณาเลือกไฟล์ใหม่';
  return null;
}

/** Moves focus once React has committed the next render (the target may not exist yet). */
function focusLater(id: string, fallbackId?: string) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el && !el.disabled) el.focus();
    else if (fallbackId) document.getElementById(fallbackId)?.focus();
  });
}

function NoticeBanner({ notice }: { notice: NonNullable<Notice> }) {
  return (
    <p
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className="flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm leading-6"
      style={{
        borderColor: notice.kind === 'error' ? DANGER : SUCCESS,
        backgroundColor: SURFACE_SUBTLE,
        color: notice.kind === 'error' ? DANGER : INK,
      }}
    >
      {notice.kind === 'ok' ? (
        <CircleCheck aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: SUCCESS }} />
      ) : (
        <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: DANGER }} />
      )}
      <span>{notice.text}</span>
    </p>
  );
}

function LogoThumb({ src, alt }: { src: string; alt: string }) {
  return (
    <span
      className="flex h-16 w-32 shrink-0 items-center justify-center rounded-xl border px-2"
      style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE }}
    >
      <img src={src} alt={alt} loading="lazy" decoding="async" className="h-12 w-full object-contain" />
    </span>
  );
}

/**
 * Collapsible /admin panel for the home-page sponsor logos: list in display order, add, edit,
 * delete (2-step confirm) and move up/down. Read-only list when `canEdit` is false.
 */
export function AdminSponsorsPanel({ token, canEdit, onAuthError }: Props) {
  const [sponsors, setSponsors] = useState<AdminSponsor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [nameInput, setNameInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [reorderingId, setReorderingId] = useState<number | null>(null);

  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const reorderingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = saving || deletingId !== null || reorderingId !== null;
  const editing = typeof formTarget === 'number' ? (sponsors?.find((s) => s.id === formTarget) ?? null) : null;

  async function load(signal?: { cancelled: boolean }) {
    try {
      const list = await fetchAdminSponsors(token);
      if (signal?.cancelled) return;
      setSponsors(list);
      setLoadError(null);
    } catch (err) {
      if (signal?.cancelled || onAuthError(err)) return;
      setLoadError(errorText(err, 'โหลดรายชื่อผู้สนับสนุนไม่สำเร็จ', 'list'));
    }
  }

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [token]);

  // One object URL per chosen file; revoked when the file changes and on unmount.
  useEffect(() => {
    if (!logoFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  useEffect(() => {
    if (confirmDeleteId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && deletingId === null) {
        const id = confirmDeleteId;
        setConfirmDeleteId(null);
        focusLater(`sponsor-delete-${id}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDeleteId, deletingId]);

  function clearFile() {
    setLogoFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function openForm(target: 'new' | AdminSponsor) {
    if (busy) return;
    setNotice(null);
    setConfirmDeleteId(null);
    setFieldErrors({});
    clearFile();
    if (target === 'new') {
      setFormTarget('new');
      setNameInput('');
      setUrlInput('');
      setShowNameInput(false);
    } else {
      setFormTarget(target.id);
      setNameInput(target.name);
      setUrlInput(target.url);
      setShowNameInput(target.showName);
    }
    focusLater('sponsor-name-input');
  }

  function closeForm(returnFocus = true) {
    const target = formTarget;
    setFormTarget(null);
    setFieldErrors({});
    clearFile();
    if (!returnFocus) return;
    if (typeof target === 'number') focusLater(`sponsor-edit-${target}`, 'sponsor-add-button');
    else focusLater('sponsor-add-button');
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setLogoFile(null);
      return;
    }
    const problem = logoProblem(file);
    if (problem) {
      clearFile();
      setFieldErrors((prev) => ({ ...prev, logo: problem }));
      return;
    }
    setFieldErrors((prev) => ({ ...prev, logo: undefined }));
    setLogoFile(file);
  }

  /** Validates the form; focuses the first bad field and returns null when anything is invalid. */
  function checkInputs(): { name: string; url: string } | null {
    const next: FieldErrors = {};
    const name = nameInput.trim();
    const nameLen = [...name].length;
    if (nameLen === 0) next.name = 'กรุณากรอกชื่อผู้สนับสนุน';
    else if (nameLen > NAME_MAX) next.name = `ชื่อยาวได้ไม่เกิน ${NAME_MAX} ตัวอักษร`;
    else if (/[\r\n]/.test(name)) next.name = 'ชื่อต้องอยู่ในบรรทัดเดียว';

    let url = urlInput.trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          next.url = 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://';
        } else {
          url = parsed.href;
          if (url.length > URL_MAX) next.url = `ลิงก์ยาวได้ไม่เกิน ${URL_MAX} ตัวอักษร`;
        }
      } catch {
        next.url = 'ลิงก์ไม่ถูกต้อง ต้องเป็นลิงก์เต็ม เช่น https://example.com';
      }
    }

    if (formTarget === 'new' && !logoFile) next.logo = 'กรุณาเลือกไฟล์โลโก้';
    else if (logoFile) {
      const problem = logoProblem(logoFile);
      if (problem) next.logo = problem;
    }

    setFieldErrors(next);
    const first = (
      [
        ['name', 'sponsor-name-input'],
        ['url', 'sponsor-url-input'],
        ['logo', 'sponsor-logo-input'],
      ] as const
    ).find(([k]) => Boolean(next[k]));
    if (first) {
      document.getElementById(first[1])?.focus();
      return null;
    }
    return { name, url };
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!canEdit || formTarget === null || savingRef.current || saving) return;
    const values = checkInputs();
    if (!values) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      if (formTarget === 'new') {
        if (!logoFile) return;
        const created = await createSponsor(token, {
          name: values.name,
          url: values.url,
          showName: showNameInput,
          logo: logoFile,
        });
        setSponsors((prev) => [...(prev ?? []), created]);
        setNotice({ kind: 'ok', text: `เพิ่ม “${created.name}” แล้ว` });
        closeForm(false);
        focusLater(`sponsor-edit-${created.id}`, 'sponsor-add-button');
      } else {
        const updated = await updateSponsor(token, formTarget, {
          name: values.name,
          url: values.url,
          showName: showNameInput,
          logo: logoFile ?? undefined,
        });
        setSponsors((prev) => (prev ?? []).map((s) => (s.id === updated.id ? updated : s)));
        setNotice({ kind: 'ok', text: `บันทึก “${updated.name}” แล้ว` });
        closeForm();
      }
    } catch (err) {
      if (onAuthError(err)) return;
      setNotice({ kind: 'error', text: `บันทึกไม่สำเร็จ: ${errorText(err, 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')}` });
      if (isNotFound(err)) {
        closeForm(false);
        load();
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function onConfirmDelete(s: AdminSponsor) {
    if (!canEdit || deletingRef.current || deletingId !== null) return;
    deletingRef.current = true;
    setDeletingId(s.id);
    setNotice(null);
    try {
      await deleteSponsor(token, s.id);
      setSponsors((prev) => (prev ?? []).filter((x) => x.id !== s.id));
      setConfirmDeleteId(null);
      setNotice({ kind: 'ok', text: `ลบ “${s.name}” แล้ว` });
      focusLater('sponsor-add-button');
    } catch (err) {
      if (onAuthError(err)) return;
      if (isNotFound(err)) {
        setConfirmDeleteId(null);
        load();
      }
      setNotice({ kind: 'error', text: `ลบไม่สำเร็จ: ${errorText(err, 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')}` });
    } finally {
      deletingRef.current = false;
      setDeletingId(null);
    }
  }

  async function onMove(index: number, dir: -1 | 1) {
    if (!canEdit || !sponsors || reorderingRef.current || reorderingId !== null) return;
    const to = index + dir;
    if (to < 0 || to >= sponsors.length) return;
    const ids = sponsors.map((s) => s.id);
    const movedId = ids[index];
    [ids[index], ids[to]] = [ids[to], ids[index]];
    reorderingRef.current = true;
    setReorderingId(movedId);
    setNotice(null);
    try {
      const list = await reorderSponsors(token, ids);
      setSponsors(list);
      const moved = list.find((s) => s.id === movedId);
      setNotice({ kind: 'ok', text: `ย้าย “${moved?.name ?? ''}” ${dir < 0 ? 'ขึ้น' : 'ลง'}แล้ว` });
      const primary = dir < 0 ? 'up' : 'down';
      const other = dir < 0 ? 'down' : 'up';
      focusLater(`sponsor-${primary}-${movedId}`, `sponsor-${other}-${movedId}`);
    } catch (err) {
      if (onAuthError(err)) return;
      setNotice({ kind: 'error', text: `เปลี่ยนลำดับไม่สำเร็จ: ${errorText(err, 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')}` });
      if (err instanceof ApiHttpError && (err.code === 'VALIDATION_ERROR' || isNotFound(err))) load();
    } finally {
      reorderingRef.current = false;
      setReorderingId(null);
    }
  }

  function renderForm() {
    const isNew = formTarget === 'new';
    const currentLogo = editing ? sponsorLogoSrc(editing.logoUrl) : null;
    const shownPreview = previewUrl ?? currentLogo;
    const previewAlt = nameInput.trim() || editing?.name || 'ตัวอย่างโลโก้';
    return (
      <form
        onSubmit={onSave}
        noValidate
        aria-busy={saving}
        aria-labelledby="sponsor-form-title"
        className="flex flex-col gap-5 rounded-xl border p-4 sm:p-5"
        style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE }}
      >
        <h3 id="sponsor-form-title" className="text-base font-semibold leading-snug" style={{ color: INK }}>
          {isNew ? 'เพิ่มผู้สนับสนุน' : `แก้ไข “${editing?.name ?? ''}”`}
        </h3>

        <div>
          <label htmlFor="sponsor-name-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
            ชื่อผู้สนับสนุน
          </label>
          <input
            id="sponsor-name-input"
            type="text"
            required
            maxLength={NAME_MAX}
            autoComplete="off"
            value={nameInput}
            onChange={(e) => {
              setNameInput(e.target.value);
              setFieldErrors((prev) => ({ ...prev, name: undefined }));
            }}
            disabled={saving}
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={fieldErrors.name ? 'sponsor-name-help sponsor-name-error' : 'sponsor-name-help'}
            className={`${INPUT_BASE} min-h-11 rounded-xl`}
            style={{ borderColor: fieldErrors.name ? DANGER : INPUT_BORDER, color: INK }}
          />
          <p id="sponsor-name-help" className="mt-1.5 text-xs leading-5" style={{ color: INK_3 }}>
            ใช้เป็นข้อความแทนรูป (alt) เสมอ ยาวได้ไม่เกิน {NAME_MAX} ตัวอักษร
          </p>
          {fieldErrors.name && (
            <p id="sponsor-name-error" className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
              {fieldErrors.name}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="sponsor-url-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
            ลิงก์ (ไม่บังคับ)
          </label>
          <input
            id="sponsor-url-input"
            type="url"
            inputMode="url"
            maxLength={URL_MAX}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              setFieldErrors((prev) => ({ ...prev, url: undefined }));
            }}
            disabled={saving}
            aria-invalid={fieldErrors.url ? true : undefined}
            aria-describedby={fieldErrors.url ? 'sponsor-url-help sponsor-url-error' : 'sponsor-url-help'}
            className={`${INPUT_BASE} min-h-11 rounded-xl font-mono text-sm`}
            style={{ borderColor: fieldErrors.url ? DANGER : INPUT_BORDER, color: INK }}
          />
          <p id="sponsor-url-help" className="mt-1.5 text-xs leading-5" style={{ color: INK_3 }}>
            ต้องขึ้นต้นด้วย http:// หรือ https:// เว้นว่างได้ถ้าไม่ต้องการให้กดโลโก้ได้
          </p>
          {fieldErrors.url && (
            <p id="sponsor-url-error" className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
              {fieldErrors.url}
            </p>
          )}
        </div>

        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 self-start text-sm" style={{ color: INK_2 }}>
          <input
            type="checkbox"
            checked={showNameInput}
            onChange={(e) => setShowNameInput(e.target.checked)}
            disabled={saving}
            className="size-4 accent-[var(--color-tech)]"
          />
          <span>แสดงชื่อใต้โลโก้</span>
        </label>

        <div>
          <label htmlFor="sponsor-logo-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
            {isNew ? 'ไฟล์โลโก้' : 'เปลี่ยนโลโก้ (ไม่บังคับ)'}
          </label>
          <input
            ref={fileInputRef}
            id="sponsor-logo-input"
            type="file"
            accept={LOGO_ACCEPT}
            onChange={onFileChange}
            disabled={saving}
            aria-invalid={fieldErrors.logo ? true : undefined}
            aria-describedby={fieldErrors.logo ? 'sponsor-logo-help sponsor-logo-error' : 'sponsor-logo-help'}
            className={`block w-full min-w-0 rounded-xl text-sm leading-7 file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-full file:border file:border-solid file:border-[var(--color-border)] file:bg-transparent file:px-4 file:py-2 file:text-sm file:font-semibold file:text-[var(--color-ink)] hover:file:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
            style={{ color: INK_2 }}
          />
          <p id="sponsor-logo-help" className="mt-1.5 text-xs leading-5" style={{ color: INK_3 }}>
            PNG, JPG หรือ WebP ไม่เกิน 2 MB และไม่เกิน 4096×4096 px (ไม่รับ SVG)
            {isNew ? '' : ' ถ้าไม่เลือกไฟล์จะใช้โลโก้เดิม'}
          </p>
          {fieldErrors.logo && (
            <p id="sponsor-logo-error" className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
              {fieldErrors.logo}
            </p>
          )}
          {shownPreview && (
            <div className="mt-3 flex items-center gap-3">
              <LogoThumb src={shownPreview} alt={previewAlt} />
              <span className="text-xs leading-5" style={{ color: INK_3 }}>
                {previewUrl ? 'ตัวอย่างไฟล์ใหม่' : 'โลโก้ปัจจุบัน'}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            aria-busy={saving || undefined}
            className={`inline-flex min-h-11 items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
            style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
          >
            {saving ? 'กำลังบันทึก…' : isNew ? 'เพิ่มผู้สนับสนุน' : 'บันทึกการแก้ไข'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => closeForm()}
            className={PILL_GHOST}
            style={{ borderColor: RULE, color: INK_2 }}
          >
            ยกเลิก
          </button>
        </div>
      </form>
    );
  }

  const panelId = 'admin-sponsors-body';
  const count = sponsors?.length ?? null;
  const iconBtn = `inline-flex size-11 shrink-0 items-center justify-center rounded-full border transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-40 ${FOCUS}`;

  return (
    <section aria-label="ผู้สนับสนุน (หน้าแรก)">
      <div id={panelId} className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm leading-7" style={{ color: INK_2 }}>
              {count === null ? (
                loadError ? null : 'กำลังโหลด…'
              ) : (
                <>
                  <span className="font-mono tabular-nums" style={{ color: INK }}>
                    {count}
                  </span>{' '}
                  รายการ
                </>
              )}
              {!canEdit && <span style={{ color: INK_3 }}> · ดูอย่างเดียว</span>}
            </p>
            {canEdit && sponsors && formTarget !== 'new' && (
              <button
                id="sponsor-add-button"
                type="button"
                disabled={busy}
                onClick={() => openForm('new')}
                className={`${PILL_GHOST} gap-1.5`}
                style={{ borderColor: RULE, color: INK }}
              >
                <Plus aria-hidden="true" size={16} strokeWidth={1.5} />
                เพิ่มผู้สนับสนุน
              </button>
            )}
          </div>
          {loadError && (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm leading-7" style={{ color: DANGER }}>
                {loadError}
              </p>
              <button type="button" onClick={() => load()} className={PILL_GHOST} style={{ borderColor: RULE, color: INK }}>
                ลองใหม่
              </button>
            </div>
          )}
          {!sponsors && !loadError && (
            <p className="text-sm leading-7" style={{ color: INK_3 }}>
              กำลังโหลดรายชื่อผู้สนับสนุน…
            </p>
          )}

          {notice && <NoticeBanner notice={notice} />}

          {sponsors && sponsors.length === 0 && (
            <p className="text-sm leading-7" style={{ color: INK_3 }}>
              ยังไม่มีผู้สนับสนุน — ส่วนนี้จะไม่แสดงบนหน้าแรก
            </p>
          )}

          {sponsors && sponsors.length > 0 && (
            <ol className="flex flex-col border-t" style={{ borderColor: RULE }} aria-label="ลำดับโลโก้บนหน้าแรก">
              {sponsors.map((s, i) => {
                const confirming = confirmDeleteId === s.id;
                const deleting = deletingId === s.id;
                const moving = reorderingId === s.id;
                return (
                  <li key={s.id} className="border-b py-4" style={{ borderColor: RULE }}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center sm:gap-4">
                        <span
                          className="mt-1 w-6 shrink-0 text-right font-mono text-sm tabular-nums sm:mt-0"
                          style={{ color: INK_3 }}
                          aria-hidden="true"
                        >
                          {i + 1}
                        </span>
                        <LogoThumb src={sponsorLogoSrc(s.logoUrl)} alt={s.name} />
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-semibold leading-7" style={{ color: INK }}>
                            <span className="sr-only">ลำดับที่ {i + 1}: </span>
                            {s.name}
                          </p>
                          {s.url ? (
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`inline-block max-w-full break-all rounded-xl font-mono text-xs leading-6 underline underline-offset-4 ${FOCUS}`}
                              style={{ color: INK_2 }}
                            >
                              {s.url}
                              <span className="sr-only"> (เปิดในแท็บใหม่)</span>
                            </a>
                          ) : (
                            <p className="text-xs leading-6" style={{ color: INK_3 }}>
                              ไม่มีลิงก์
                            </p>
                          )}
                          <p className="text-xs leading-6" style={{ color: INK_3 }}>
                            แสดงชื่อใต้โลโก้: {s.showName ? 'เปิด' : 'ปิด'}
                          </p>
                        </div>
                      </div>

                      {canEdit && (
                        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                          <button
                            id={`sponsor-up-${s.id}`}
                            type="button"
                            disabled={busy || i === 0}
                            aria-busy={moving || undefined}
                            aria-label={moving ? `กำลังย้าย ${s.name}…` : `ย้าย ${s.name} ขึ้น`}
                            onClick={() => onMove(i, -1)}
                            className={iconBtn}
                            style={{ borderColor: RULE, color: INK }}
                          >
                            <ArrowUp aria-hidden="true" size={18} strokeWidth={1.5} />
                          </button>
                          <button
                            id={`sponsor-down-${s.id}`}
                            type="button"
                            disabled={busy || i === sponsors.length - 1}
                            aria-busy={moving || undefined}
                            aria-label={moving ? `กำลังย้าย ${s.name}…` : `ย้าย ${s.name} ลง`}
                            onClick={() => onMove(i, 1)}
                            className={iconBtn}
                            style={{ borderColor: RULE, color: INK }}
                          >
                            <ArrowDown aria-hidden="true" size={18} strokeWidth={1.5} />
                          </button>
                          <button
                            id={`sponsor-edit-${s.id}`}
                            type="button"
                            disabled={busy || formTarget === s.id}
                            aria-expanded={formTarget === s.id}
                            aria-label={`แก้ไข ${s.name}`}
                            onClick={() => openForm(s)}
                            className={`${PILL_GHOST} gap-1.5`}
                            style={{ borderColor: RULE, color: INK }}
                          >
                            <Pencil aria-hidden="true" size={16} strokeWidth={1.5} />
                            แก้ไข
                          </button>
                          <button
                            id={`sponsor-delete-${s.id}`}
                            type="button"
                            disabled={busy}
                            aria-expanded={confirming}
                            aria-controls={confirming ? `sponsor-delete-strip-${s.id}` : undefined}
                            aria-label={`ลบ ${s.name}`}
                            onClick={() => {
                              setNotice(null);
                              setConfirmDeleteId(confirming ? null : s.id);
                            }}
                            className={PILL_DANGER}
                            style={{
                              borderColor: DANGER,
                              color: DANGER,
                              backgroundColor: confirming
                                ? 'color-mix(in srgb, var(--color-danger) 10%, transparent)'
                                : undefined,
                            }}
                          >
                            <Trash2 aria-hidden="true" size={16} strokeWidth={1.5} />
                            ลบ
                          </button>
                        </div>
                      )}
                    </div>

                    {canEdit && confirming && (
                      <div
                        id={`sponsor-delete-strip-${s.id}`}
                        role="region"
                        aria-label={`ยืนยันการลบ ${s.name}`}
                        className="mt-4 rounded-xl border p-4"
                        style={{ borderColor: DANGER, backgroundColor: SURFACE_SUBTLE }}
                      >
                        <p className="flex items-start gap-2 text-sm font-semibold leading-6" style={{ color: INK }}>
                          <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: DANGER }} />
                          <span className="min-w-0 break-words">ยืนยันลบ “{s.name}”?</span>
                        </p>
                        <p className="mt-1 text-sm leading-6" style={{ color: INK_2 }}>
                          โลโก้จะหายจากหน้าแรกทันทีและลบไฟล์ออกจากเซิร์ฟเวอร์ กู้คืนไม่ได้
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={deleting}
                            aria-busy={deleting || undefined}
                            onClick={() => onConfirmDelete(s)}
                            className={`inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                            style={{ borderColor: DANGER, color: DANGER }}
                          >
                            {deleting ? 'กำลังลบ…' : 'ยืนยันลบ'}
                          </button>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => {
                              setConfirmDeleteId(null);
                              focusLater(`sponsor-delete-${s.id}`);
                            }}
                            className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                            style={{ color: INK_2 }}
                          >
                            ยกเลิก
                          </button>
                        </div>
                      </div>
                    )}

                    {canEdit && formTarget === s.id && <div className="mt-4">{renderForm()}</div>}
                  </li>
                );
              })}
            </ol>
          )}

          {canEdit && sponsors && formTarget === 'new' && renderForm()}
        </div>
    </section>
  );
}
