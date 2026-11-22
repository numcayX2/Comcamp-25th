import { useEffect, useRef, useState } from 'react';
import { Check, Eye, FilePlus2, FileText, Mail, Phone, RotateCw, Trash2, TriangleAlert } from 'lucide-react';
import {
  SPONSOR_KIND_LABELS,
  deleteSponsorInquiry,
  fetchSponsorInquiries,
  fetchSponsorInquiryFile,
  setSponsorInquiryHandled,
  type SponsorInquiry,
} from '../../lib/api';
import { formatBytes } from '../../lib/slip-upload';
import { formatThaiAddress, formatThaiTaxId } from '../../lib/thai-tax-id';
import { DANGER, FOCUS, INK, INK_2, INK_3, PILL_DANGER, PILL_GHOST, RULE, SUCCESS, SURFACE_SUBTLE, WARNING } from '../admin-ui';
import {
  NoticeBanner,
  UNKNOWN_ERROR,
  focusLater,
  formatBangkokDateTime,
  formatPhone,
  isNotFound,
  sponsorErrorText,
  type Notice,
} from './sponsor-ui';

interface Props {
  token: string;
  canEdit: boolean;
  /** Returns true when the error was an expired session, in which case the parent has logged out. */
  onAuthError: (err: unknown) => boolean;
  /** Number of inquiries not yet marked as contacted (null while unknown). */
  onUnhandledCount: (n: number | null) => void;
  /** "สร้างรายการบริจาค": the parent opens the donation editor prefilled from this inquiry. */
  onCreateDonation: (inquiry: SponsorInquiry) => void;
}

const byNewest = (a: SponsorInquiry, b: SponsorInquiry) =>
  b.createdAt.localeCompare(a.createdAt) || b.id - a.id;

/** A viewed form's blob: URL stays alive this long for the new tab to load it. */
const VIEW_URL_TTL_MS = 60_000;

const fileTypeLabel = (mime: string) => (mime === 'application/pdf' ? 'PDF' : 'รูปภาพ');

/**
 * Inquiries sent from the public /sponsor form: mark as contacted, open the attached donation
 * form, turn into a donation, delete.
 */
export function AdminSponsorInquiries({ token, canEdit, onAuthError, onUnhandledCount, onCreateDonation }: Props) {
  const [items, setItems] = useState<SponsorInquiry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  /** Key of the running mutation (`handled-<id>` / `delete-<id>`), mirrored by `actionRef`. */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const actionRef = useRef(false);
  const loadingRef = useRef(false);
  /** Inquiry id whose attached form is being fetched, mirrored by `viewRef`. */
  const [viewingId, setViewingId] = useState<number | null>(null);
  const viewRef = useRef(false);
  const viewUrlsRef = useRef(new Set<string>());

  async function load(signal?: { cancelled: boolean }) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const list = await fetchSponsorInquiries(token);
      if (signal?.cancelled) return;
      setItems([...list].sort(byNewest));
      setLoadError(null);
    } catch (err) {
      if (signal?.cancelled || onAuthError(err)) return;
      setLoadError(sponsorErrorText(err, 'โหลดรายการผู้สนใจสนับสนุนไม่สำเร็จ', { context: 'list' }));
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

  useEffect(() => {
    onUnhandledCount(items ? items.filter((i) => !i.handled).length : null);
  }, [items, onUnhandledCount]);

  // Revoke any viewed-form URL still alive when the panel goes away.
  useEffect(() => {
    const urls = viewUrlsRef.current;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (confirmDeleteId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !actionRef.current) {
        const id = confirmDeleteId;
        setConfirmDeleteId(null);
        focusLater(`inquiry-delete-${id}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDeleteId]);

  async function onToggleHandled(inq: SponsorInquiry) {
    if (!canEdit || actionRef.current) return;
    actionRef.current = true;
    setBusyKey(`handled-${inq.id}`);
    setNotice(null);
    try {
      const updated = await setSponsorInquiryHandled(token, inq.id, !inq.handled);
      setItems((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)));
      setNotice({
        kind: 'ok',
        text: updated.handled ? `ทำเครื่องหมาย “${updated.name}” ว่าติดต่อแล้ว` : `ย้าย “${updated.name}” กลับเป็นยังไม่ได้ติดต่อ`,
      });
    } catch (err) {
      if (onAuthError(err)) return;
      setNotice({ kind: 'error', text: `บันทึกไม่สำเร็จ: ${sponsorErrorText(err, UNKNOWN_ERROR)}` });
      if (isNotFound(err)) load();
    } finally {
      actionRef.current = false;
      setBusyKey(null);
    }
  }

  async function onConfirmDelete(inq: SponsorInquiry) {
    if (!canEdit || actionRef.current) return;
    actionRef.current = true;
    setBusyKey(`delete-${inq.id}`);
    setNotice(null);
    try {
      await deleteSponsorInquiry(token, inq.id);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== inq.id));
      setConfirmDeleteId(null);
      setNotice({ kind: 'ok', text: `ลบรายการของ “${inq.name}” แล้ว` });
      focusLater('inquiry-reload');
    } catch (err) {
      if (onAuthError(err)) return;
      if (isNotFound(err)) {
        setConfirmDeleteId(null);
        load();
      }
      setNotice({ kind: 'error', text: `ลบไม่สำเร็จ: ${sponsorErrorText(err, UNKNOWN_ERROR)}` });
    } finally {
      actionRef.current = false;
      setBusyKey(null);
    }
  }

  async function onViewFile(inq: SponsorInquiry) {
    if (viewRef.current) return;
    // Open the tab inside the click so popup blockers allow it, then point it at the blob.
    const win = window.open('', '_blank');
    if (!win) {
      setNotice({ kind: 'error', text: 'เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาตป๊อปอัปสำหรับเว็บนี้แล้วลองอีกครั้ง' });
      return;
    }
    win.opener = null;
    viewRef.current = true;
    setViewingId(inq.id);
    setNotice(null);
    try {
      const url = await fetchSponsorInquiryFile(token, inq.id);
      viewUrlsRef.current.add(url);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        viewUrlsRef.current.delete(url);
      }, VIEW_URL_TTL_MS);
      if (!win.closed) win.location.href = url;
    } catch (err) {
      win.close();
      if (onAuthError(err)) return;
      setNotice({ kind: 'error', text: `เปิดแบบฟอร์มไม่สำเร็จ: ${sponsorErrorText(err, UNKNOWN_ERROR)}` });
      if (isNotFound(err)) load();
    } finally {
      viewRef.current = false;
      setViewingId(null);
    }
  }

  if (!canEdit) {
    return (
      <p className="text-sm leading-7" style={{ color: INK_3 }}>
        เฉพาะผู้ดูแลระบบเท่านั้นที่ดูรายการนี้ได้
      </p>
    );
  }

  const busy = busyKey !== null;
  const unhandled = items?.filter((i) => !i.handled).length ?? 0;

  return (
    <section aria-label="ผู้สนใจสนับสนุน" aria-busy={loading} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm leading-7" style={{ color: INK_2 }}>
          {items === null ? (
            loadError ? null : 'กำลังโหลด…'
          ) : (
            <>
              ทั้งหมด{' '}
              <span className="font-mono tabular-nums" style={{ color: INK }}>
                {items.length}
              </span>{' '}
              รายการ · ยังไม่ได้ติดต่อ{' '}
              <span className="font-mono tabular-nums" style={{ color: unhandled > 0 ? INK : INK_3 }}>
                {unhandled}
              </span>
            </>
          )}
        </p>
        <button
          id="inquiry-reload"
          type="button"
          disabled={loading || busy}
          aria-busy={loading || undefined}
          onClick={() => load()}
          className={`${PILL_GHOST} gap-1.5`}
          style={{ borderColor: RULE, color: INK }}
        >
          <RotateCw aria-hidden="true" size={16} strokeWidth={1.5} />
          {loading ? 'กำลังโหลด…' : 'โหลดใหม่'}
        </button>
      </div>

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

      {items && items.length === 0 && (
        <p className="text-sm leading-7" style={{ color: INK_3 }}>
          ยังไม่มีผู้แจ้งความประสงค์สนับสนุนจากหน้า /sponsor
        </p>
      )}

      {items && items.length > 0 && (
        <ul className="flex flex-col border-t" style={{ borderColor: RULE }} aria-label="รายการผู้สนใจสนับสนุน (ใหม่สุดก่อน)">
          {items.map((inq) => {
            const confirming = confirmDeleteId === inq.id;
            const toggling = busyKey === `handled-${inq.id}`;
            const deleting = busyKey === `delete-${inq.id}`;
            return (
              <li key={inq.id} className="border-b py-4" style={{ borderColor: RULE }}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {!inq.handled && (
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: WARNING }} />
                      )}
                      <p className="min-w-0 break-words text-base font-semibold leading-7" style={{ color: INK }}>
                        {inq.name}
                      </p>
                      <span
                        className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5"
                        style={{ borderColor: RULE, color: INK_2 }}
                      >
                        {SPONSOR_KIND_LABELS[inq.kind]}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5"
                        style={{ borderColor: inq.handled ? SUCCESS : WARNING, color: inq.handled ? INK : INK_2 }}
                      >
                        {inq.handled && <Check aria-hidden="true" size={12} strokeWidth={2} style={{ color: SUCCESS }} />}
                        {inq.handled ? 'ติดต่อแล้ว' : 'ยังไม่ได้ติดต่อ'}
                      </span>
                      {inq.file && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5"
                          style={{ borderColor: INK, color: INK }}
                        >
                          <FileText aria-hidden="true" size={12} strokeWidth={2} />
                          แนบแบบฟอร์ม · {fileTypeLabel(inq.file.mime)} ·{' '}
                          <span className="font-mono tabular-nums">{formatBytes(inq.file.size)}</span>
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm leading-7">
                      <a
                        href={`tel:${inq.phone}`}
                        className={`inline-flex items-center gap-1.5 rounded-full font-mono tabular-nums underline-offset-4 hover:underline ${FOCUS}`}
                        style={{ color: INK }}
                      >
                        <Phone aria-hidden="true" size={14} strokeWidth={1.5} style={{ color: INK_3 }} />
                        <span className="sr-only">โทร </span>
                        {formatPhone(inq.phone)}
                      </a>
                      {inq.email && (
                        <a
                          href={`mailto:${inq.email}`}
                          className={`inline-flex min-w-0 items-center gap-1.5 break-all rounded-full underline-offset-4 hover:underline ${FOCUS}`}
                          style={{ color: INK }}
                        >
                          <Mail aria-hidden="true" size={14} strokeWidth={1.5} className="shrink-0" style={{ color: INK_3 }} />
                          <span className="sr-only">อีเมล </span>
                          {inq.email}
                        </a>
                      )}
                    </div>
                    {(inq.taxId || formatThaiAddress(inq)) && (
                      <div className="mt-1.5 flex flex-col gap-0.5 text-sm leading-6" style={{ color: INK_2 }}>
                        {inq.taxId && (
                          <p className="break-words">
                            <span style={{ color: INK_3 }}>เลขประจำตัวผู้เสียภาษี/บัตรประชาชน: </span>
                            <span className="font-mono tabular-nums" style={{ color: INK }}>
                              {formatThaiTaxId(inq.taxId)}
                            </span>
                          </p>
                        )}
                        {formatThaiAddress(inq) && (
                          <p className="max-w-[68ch] break-words">
                            <span style={{ color: INK_3 }}>ที่อยู่: </span>
                            {formatThaiAddress(inq)}
                          </p>
                        )}
                      </div>
                    )}
                    {inq.details && (
                      <p className="mt-2 max-w-[68ch] whitespace-pre-line break-words text-sm leading-[1.75]" style={{ color: INK_2 }}>
                        {inq.details}
                      </p>
                    )}
                    <p className="mt-1 text-xs leading-6" style={{ color: INK_3 }}>
                      ส่งเมื่อ {formatBangkokDateTime(inq.createdAt)}
                      {inq.handled && inq.handledAt && <> · ติดต่อแล้วเมื่อ {formatBangkokDateTime(inq.handledAt)}</>}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
                    {inq.file && (
                      <button
                        type="button"
                        disabled={viewingId !== null}
                        aria-busy={viewingId === inq.id || undefined}
                        aria-label={`ดูแบบฟอร์มที่ ${inq.name} แนบมา (เปิดในแท็บใหม่)`}
                        onClick={() => onViewFile(inq)}
                        className={`${PILL_GHOST} gap-1.5`}
                        style={{ borderColor: INK, color: INK }}
                      >
                        <Eye aria-hidden="true" size={16} strokeWidth={1.5} />
                        {viewingId === inq.id ? 'กำลังเปิด…' : 'ดูแบบฟอร์ม'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={inq.handled}
                      aria-busy={toggling || undefined}
                      onClick={() => onToggleHandled(inq)}
                      className={`${PILL_GHOST} gap-1.5`}
                      style={{ borderColor: inq.handled ? SUCCESS : RULE, color: INK }}
                    >
                      <Check aria-hidden="true" size={16} strokeWidth={1.5} style={{ color: inq.handled ? SUCCESS : INK_3 }} />
                      {toggling ? 'กำลังบันทึก…' : 'ติดต่อแล้ว'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onCreateDonation(inq)}
                      className={`${PILL_GHOST} gap-1.5`}
                      style={{ borderColor: RULE, color: INK }}
                    >
                      <FilePlus2 aria-hidden="true" size={16} strokeWidth={1.5} />
                      สร้างรายการบริจาค
                    </button>
                    <button
                      id={`inquiry-delete-${inq.id}`}
                      type="button"
                      disabled={busy}
                      aria-expanded={confirming}
                      aria-controls={confirming ? `inquiry-delete-strip-${inq.id}` : undefined}
                      aria-label={`ลบรายการของ ${inq.name}`}
                      onClick={() => {
                        setNotice(null);
                        setConfirmDeleteId(confirming ? null : inq.id);
                      }}
                      className={PILL_DANGER}
                      style={{
                        borderColor: DANGER,
                        color: DANGER,
                        backgroundColor: confirming ? 'color-mix(in srgb, var(--color-danger) 10%, transparent)' : undefined,
                      }}
                    >
                      <Trash2 aria-hidden="true" size={16} strokeWidth={1.5} />
                      ลบ
                    </button>
                  </div>
                </div>

                {confirming && (
                  <div
                    id={`inquiry-delete-strip-${inq.id}`}
                    role="region"
                    aria-label={`ยืนยันการลบรายการของ ${inq.name}`}
                    className="mt-4 rounded-xl border p-4"
                    style={{ borderColor: DANGER, backgroundColor: SURFACE_SUBTLE }}
                  >
                    <p className="flex items-start gap-2 text-sm font-semibold leading-6" style={{ color: INK }}>
                      <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: DANGER }} />
                      <span className="min-w-0 break-words">ยืนยันลบรายการของ “{inq.name}”?</span>
                    </p>
                    <p className="mt-1 text-sm leading-6" style={{ color: INK_2 }}>
                      {inq.file
                        ? 'ข้อมูลติดต่อและไฟล์แบบฟอร์มที่แนบมาจะหายไปถาวร กู้คืนไม่ได้ (รายการบริจาคที่สร้างไว้แล้วไม่ถูกลบ)'
                        : 'ข้อมูลติดต่อนี้จะหายไปถาวร กู้คืนไม่ได้ (รายการบริจาคที่สร้างไว้แล้วไม่ถูกลบ)'}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        aria-busy={deleting || undefined}
                        onClick={() => onConfirmDelete(inq)}
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
                          focusLater(`inquiry-delete-${inq.id}`);
                        }}
                        className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                        style={{ color: INK_2 }}
                      >
                        ยกเลิก
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
