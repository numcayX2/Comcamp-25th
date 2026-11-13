/**
 * The slip upload flow, shared by the /register receipt (SlipBlock) and /status (#slip-section) so
 * the two pages cannot drift apart. Flat on purpose: zones are separated by whitespace and 1px
 * hairlines, never by nested bordered cards (AGENTS.md section 2.3).
 *
 *   empty  -> a dashed drop tile (tap, drag a file in, or paste an image)
 *   picked -> a flat strip: thumbnail (opens a lightbox) + name, size, change / remove
 *   sent   -> a summary with "send a new one to replace"
 *
 * Oversized photos are shrunk in the browser (see prepareSlipFile). The verify code is state only.
 * With `verifyCode` given the field lives elsewhere (/status shares one field with confirm, edit
 * and withdraw); without it the panel renders its own field.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { CircleCheck } from 'lucide-react';
import { ApiHttpError, uploadPaymentSlip, type ApiSource, type SlipStatus } from '../../lib/api';
import {
  SLIP_ACCEPT,
  describeApiError,
  firstImageFile,
  formatBytes,
  middleTruncate,
  prepareSlipFile,
} from '../../lib/slip-upload';
import { SlipLightbox } from './SlipLightbox';
import { VerifyCodeField } from './VerifyCodeField';
import '../../styles/slip-upload.css';

/** Student-friendly success copy. Fixed on purpose: the API message names "เจ้าหน้าที่" and differs
    between the live server and the dev mock, so it is never shown. */
export const SLIP_OK_HEADLINE = 'อัปโหลดสลิปเรียบร้อยแล้ว รอทีมงานตรวจสอบสลิป';
export const SLIP_OK_NEXT =
  'ไม่ต้องส่งสลิปซ้ำและยังไม่ต้องทำอะไรเพิ่ม ทีมงานจะตรวจสอบความถูกต้องและอัปเดตสถานะเป็น “ยืนยันสิทธิ์สมบูรณ์” ให้โดยเร็วที่สุด น้องสามารถกลับมาดูผลได้ตลอดที่หน้าตรวจสอบสถานะ (/status) ด้วยรหัสใบสมัคร เลขบัตรประชาชน หรือเบอร์โทรศัพท์ และติดตามข่าวสารได้ทางเพจ Facebook ของโครงการ';

interface Sent {
  url: string;
  name: string;
  size: number;
}

export function SlipUploadPanel({
  appId,
  slip,
  disabled,
  verifyCode: externalCode,
  defaultVerifyCode,
  codeInputId,
  onCodeInvalid,
  onUploaded,
  submitLabel = 'ส่งสลิป',
  deferLink,
  notPhone,
}: {
  appId: string;
  /** What the server knows: null = no slip yet. */
  slip: SlipStatus | null;
  /** The application cannot take a slip (e.g. no longer holds a seat). */
  disabled?: boolean;
  /** Controlled by the parent when the code field lives elsewhere on the page. */
  verifyCode?: string;
  /** Pre-filled 4-digit verify code kept in React memory (never persisted); hides the redundant input until edited. */
  defaultVerifyCode?: string;
  /** DOM id of that external field: refocused and selected after a wrong code. */
  codeInputId?: string;
  /** External mode: show (or clear with null) the wrong-code message beneath the parent's field. */
  onCodeInvalid?: (message: string | null) => void;
  onUploaded: (status: SlipStatus, message: string, source: ApiSource) => void;
  submitLabel?: string;
  /** Quiet link under the submit button, e.g. "send it later on /status". */
  deferLink?: { href: string; label: string };
  notPhone?: boolean;
}) {
  const uid = useId();
  const ids = { file: `${uid}-file`, code: `${uid}-code`, fileErr: `${uid}-fileerr`, subErr: `${uid}-suberr`, hint: `${uid}-hint` };
  const external = externalCode !== undefined;
  const validDefaultCode = !external && defaultVerifyCode && /^\d{4}$/.test(defaultVerifyCode) ? defaultVerifyCode : '';
  const [innerCode, setInnerCode] = useState(validDefaultCode);
  const [editingCode, setEditingCode] = useState(false);
  const code = external ? externalCode : innerCode;

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [resized, setResized] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const refocusCode = useRef(false);
  const replaceBtnRef = useRef<HTMLButtonElement>(null);
  const refocusReplace = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusStatus = useRef(false);
  const pickLocked = useRef(false);
  pickLocked.current = busy || preparing;

  // After "ไม่ส่งใหม่" folds the form, focus returns to the replace trigger once it is rendered again.
  useEffect(() => {
    if (!replace && refocusReplace.current) {
      refocusReplace.current = false;
      replaceBtnRef.current?.focus();
    }
  }, [replace]);

  // When an upload succeeds and {showForm} unmounts, move focus to the status box instead of dropping to <body>.
  useEffect(() => {
    if (message && focusStatus.current) {
      focusStatus.current = false;
      statusRef.current?.focus();
    }
  }, [message]);

  function cancelReplace() {
    clearPicked();
    setCodeError(null);
    onCodeInvalid?.(null);
    refocusReplace.current = true;
    setReplace(false);
  }

  // Object URLs are revoked on unmount so a long session does not leak the pictures.
  const urls = useRef<{ preview: string | null; sent: string | null }>({ preview: null, sent: null });
  urls.current = { preview, sent: sent?.url ?? null };
  useEffect(
    () => () => {
      if (urls.current.preview) URL.revokeObjectURL(urls.current.preview);
      if (urls.current.sent) URL.revokeObjectURL(urls.current.sent);
    },
    [],
  );

  const state: SlipStatus | null = slip;
  const showForm = !disabled && state !== 'APPROVED' && (state === null || state === 'REJECTED' || replace);
  const codeReady = code.length === 4;
  const ready = Boolean(file) && codeReady;

  /** Validates, shrinks when needed, and shows the picked slip. */
  const pick = useCallback(
    async (picked: File | null | undefined) => {
      if (pickLocked.current) return;
      setFileError(null);
      setSubmitError(null);
      setMessage(null);
      if (!picked) return;
      setPreparing(true);
      try {
        const check = await prepareSlipFile(picked);
        setInputKey((k) => k + 1); // clear the native input so the same file can be picked again
        if (!check.ok) {
          setFileError(check.message);
          return;
        }
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return check.previewUrl;
        });
        setFile(check.file);
        setResized(check.resized);
      } finally {
        setPreparing(false);
      }
    },
    [],
  );

  function clearPicked() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFile(null);
    setResized(false);
    setFileError(null);
    setSubmitError(null);
  }

  // Paste an image (a copied screenshot) anywhere while the form is open.
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    if (!showForm || busy || preparing) return;
    const onPaste = (e: ClipboardEvent) => {
      const f = firstImageFile(e.clipboardData?.files);
      if (!f) return;
      e.preventDefault();
      void pickRef.current(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [showForm, busy, preparing]);

  // Keep in-memory default code in sync in internal mode without ever touching browser storage.
  useEffect(() => {
    if (external) return;
    if (validDefaultCode) {
      if (!editingCode) setInnerCode(validDefaultCode);
    } else {
      setEditingCode(false);
      setInnerCode('');
    }
  }, [external, validDefaultCode, editingCode]);

  // A disabled input cannot take focus, so a wrong code refocuses and selects the digits once busy clears.
  useEffect(() => {
    if (busy || !refocusCode.current) return;
    refocusCode.current = false;
    const el = document.getElementById(codeInputId ?? ids.code);
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    }
  }, [busy, editingCode, codeInputId, ids.code]);

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    if (busy || preparing) return;
    const files = e.dataTransfer?.files;
    void pick(firstImageFile(files) ?? files?.[0]);
  }
  const dropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (busy || preparing) return;
      if (!dragging) setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop,
  };

  function focusExternalCode() {
    const el = document.getElementById(codeInputId ?? 'verify-code');
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    if (el instanceof HTMLElement) {
      el.focus({ preventScroll: true });
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || preparing || !file || !codeReady) return;
    setBusy(true);
    setProgress(0);
    setSubmitError(null);
    setCodeError(null);
    setMessage(null);
    onCodeInvalid?.(null);
    try {
      const res = await uploadPaymentSlip(appId, file, code, setProgress);
      if (sent) URL.revokeObjectURL(sent.url);
      if (preview) setSent({ url: preview, name: file.name, size: file.size }); // ownership of the URL moves to `sent`
      setPreview(null);
      setFile(null);
      setResized(false);
      setReplace(false);
      if (!external) {
        setInnerCode(validDefaultCode);
        setEditingCode(false);
      }
      focusStatus.current = true;
      setMessage(SLIP_OK_HEADLINE);
      onUploaded(res.data.slipStatus ?? 'PENDING', SLIP_OK_HEADLINE, res.source);
    } catch (err) {
      const text = describeApiError(err, 'ส่งสลิปไม่สำเร็จ กรุณาลองอีกครั้ง');
      // The picked file and the typed digits are kept so a retry is one tap.
      const isCodeError =
        err instanceof ApiHttpError &&
        (err.code === 'INVALID_VERIFY_CODE' ||
          (err.code === 'VALIDATION_ERROR' && /verifycode/i.test(err.message)));
      if (isCodeError) {
        if (external) onCodeInvalid?.(text);
        else {
          setEditingCode(true);
          setCodeError(text);
        }
        refocusCode.current = true;
      } else {
        setSubmitError(text);
      }
    } finally {
      setBusy(false);
    }
  }

  /* ───────────── render ───────────── */

  if (state === 'APPROVED') {
    return (
      <div className="su">
        <p className="su-note">ชำระเงินเรียบร้อยแล้ว ไม่ต้องส่งสลิปเพิ่ม</p>
      </div>
    );
  }

  return (
    <div className="su">
      {!showForm && !disabled && (
        <div className="su-strip su-strip--sent">
          {sent && (
            <button type="button" className="su-strip__thumb" onClick={() => setZoom(sent.url)} aria-label="แตะดูรูปเต็ม">
              <img src={sent.url} alt="สลิปที่เพิ่งส่ง" />
              <span className="su-strip__zoom">แตะดูรูปเต็ม</span>
            </button>
          )}
          <div className="su-strip__meta">
            <p className="su-strip__title">ส่งสลิปแล้ว</p>
            {sent && (
              <p className="su-strip__size">
                {middleTruncate(sent.name)} · {formatBytes(sent.size)}
              </p>
            )}
            <p className="su-note">
              {sent ? 'รูปนี้แสดงจากเครื่องของน้องเท่านั้น ' : 'ทีมงานได้รับสลิปแล้ว '}
              เพื่อความปลอดภัย รูปสลิปเปิดดูได้เฉพาะทีมงานในระบบของโครงการ
            </p>
            <div className="su-strip__actions">
              <button ref={replaceBtnRef} type="button" className="su-btn su-btn--ghost" onClick={() => setReplace(true)}>
                ส่งสลิปใหม่เพื่อแทนที่
              </button>
            </div>
          </div>
        </div>
      )}

      {message && (
        <div ref={statusRef} tabIndex={-1} className="su-msg su-msg--ok" role="status">
          <CircleCheck className="su-msg__icon" size={18} strokeWidth={1.75} aria-hidden="true" />
          <div className="su-msg__body">
            <p className="su-msg__title">{message}</p>
            <p className="su-msg__text">{SLIP_OK_NEXT}</p>
          </div>
        </div>
      )}

      {showForm && (
        <form className="su-form" onSubmit={onSubmit} noValidate>
          <div>
            {/* The real input is visually hidden but stays focusable, so the keyboard still works. */}
            <input
              key={inputKey}
              ref={inputRef}
              id={ids.file}
              className="su-sr"
              type="file"
              accept={SLIP_ACCEPT}
              onChange={(e) => void pick(e.target.files?.[0])}
              disabled={busy || preparing}
              aria-describedby={`${ids.hint}${fileError ? ` ${ids.fileErr}` : ''}`}
            />

            {!file ? (
              <label
                htmlFor={ids.file}
                className="su-zone"
                data-drag={dragging || undefined}
                data-busy={preparing || undefined}
                aria-busy={preparing || undefined}
                {...dropProps}
              >
                <span className="su-zone__title" role={preparing ? 'status' : undefined} aria-live={preparing ? 'polite' : undefined}>
                  {preparing ? 'กำลังย่อขนาดรูปสลิป…' : 'เลือกรูปสลิป'}
                </span>
                <span className="su-zone__hint">
                  แตะเพื่อเลือกภาพแคปหน้าจอสลิปจากอัลบั้มหรือแกลเลอรี (JPG, PNG หรือ WebP)
                </span>
                <span className="su-zone__hint su-zone__hint--desk">หรือลากรูปมาวาง / กด Ctrl+V เพื่อวางรูปที่คัดลอกไว้</span>
              </label>
            ) : (
              <div className="su-strip" data-busy={preparing || undefined} aria-busy={preparing || undefined} {...dropProps}>
                <button type="button" className="su-strip__thumb" onClick={() => preview && setZoom(preview)} aria-label="แตะดูรูปเต็ม">
                  {preview && <img src={preview} alt="ตัวอย่างสลิปที่เลือก" />}
                  <span className="su-strip__zoom">แตะดูรูปเต็ม</span>
                </button>
                <div className="su-strip__meta">
                  <p className="su-strip__title">{middleTruncate(file.name)}</p>
                  <p className="su-strip__size">
                    {formatBytes(file.size)}
                    {resized && ' · ย่อรูปให้พอดีอัตโนมัติแล้ว'}
                  </p>
                  {preparing && (
                    <p className="su-strip__status" role="status" aria-live="polite">
                      กำลังย่อขนาดรูปสลิป…
                    </p>
                  )}
                  <div className="su-strip__actions">
                    <button type="button" className="su-btn su-btn--ghost" onClick={() => inputRef.current?.click()} disabled={busy || preparing}>
                      เปลี่ยนรูป
                    </button>
                    <button type="button" className="su-btn su-btn--ghost" onClick={clearPicked} disabled={busy || preparing}>
                      ลบ
                    </button>
                  </div>
                </div>
              </div>
            )}

            <p id={ids.hint} className="su-hint">
              รองรับ JPG, PNG หรือ WebP ถ้ารูปใหญ่เกินไประบบจะย่อให้อัตโนมัติ
            </p>
            {fileError && (
              <p id={ids.fileErr} className="su-msg su-msg--err" role="alert">
                {fileError}
              </p>
            )}
          </div>

          {!external &&
            (validDefaultCode && !editingCode ? (
              <div className="su-code-prompt">
                <p className="su-note">ใช้รหัสยืนยันจากบัตรประชาชนที่คุณกรอกสมัครอัตโนมัติ</p>
                <button
                  type="button"
                  className="su-link-btn"
                  disabled={busy}
                  onClick={() => {
                    refocusCode.current = true;
                    setEditingCode(true);
                  }}
                >
                  แก้ไขรหัส 4 ตัว
                </button>
              </div>
            ) : (
              <VerifyCodeField
                id={ids.code}
                value={innerCode}
                onChange={(v) => {
                  setInnerCode(v);
                  if (codeError) setCodeError(null);
                }}
                error={codeError}
                enterKeyHint="send"
                disabled={busy}
                notPhone={notPhone}
              />
            ))}
          {external && !codeReady && (
            <div className="su-code-prompt">
              <p className="su-note">
                {file
                  ? 'กรอกเลข 4 ตัวท้ายของบัตรประชาชนในช่องด้านบนก่อนส่งสลิป'
                  : 'เลือกรูปสลิปและกรอกเลข 4 ตัวท้ายของบัตรประชาชนด้านบนก่อนส่งสลิป'}
              </p>
              <button type="button" className="su-link-btn" onClick={focusExternalCode}>
                ไปกรอกรหัส 4 ตัวท้ายด้านบน
              </button>
            </div>
          )}

          <div>
            <div className="su-actions">
              <button
                type="submit"
                className="su-btn su-btn--primary su-btn--block"
                disabled={busy || preparing || !ready}
                aria-busy={busy || preparing || undefined}
              >
                {busy ? `กำลังส่งสลิป… ${progress}%` : preparing ? 'กำลังย่อขนาดรูปสลิป…' : submitLabel}
              </button>
              {replace && (
                <button type="button" className="su-btn su-btn--ghost su-btn--cancel" onClick={cancelReplace} disabled={busy || preparing}>
                  ไม่ส่งใหม่
                </button>
              )}
            </div>
            {!ready && !busy && !preparing && (!external || (codeReady && !file)) && (
              <p className="su-hint" aria-live="polite">
                {external || codeReady ? 'เลือกรูปสลิปก่อนจึงจะส่งได้' : 'เลือกรูปสลิปและกรอกเลข 4 ตัวท้ายให้ครบก่อนจึงจะส่งได้'}
              </p>
            )}
            {submitError && (
              <p id={ids.subErr} className="su-msg su-msg--err" role="alert">
                {submitError}
              </p>
            )}
            {deferLink && (
              <p className="su-defer">
                <a href={deferLink.href}>{deferLink.label}</a>
              </p>
            )}
          </div>
        </form>
      )}

      <SlipLightbox src={zoom} open={zoom !== null} onClose={() => setZoom(null)} />
    </div>
  );
}
