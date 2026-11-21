import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { fetchSponsorNotifyEmails, stripZeroWidth, updateSponsorNotifyEmails } from '../../lib/api';
import { BTN_DARK, BTN_DARK_TEXT, DANGER, FOCUS, INK, INK_2, INK_3, INPUT_BASE, INPUT_BORDER, PILL_GHOST, RULE } from '../admin-ui';
import { NoticeBanner, UNKNOWN_ERROR, focusLater, sponsorErrorText, type Notice } from './sponsor-ui';

/** Contract: max 10 addresses, each a bare address ≤ 150 characters (server lowercases + dedupes). */
const MAX_EMAILS = 10;
const EMAIL_MAX = 150;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

interface Props {
  token: string;
  canEdit: boolean;
  /** Returns true when the error was an expired session, in which case the parent has logged out. */
  onAuthError: (err: unknown) => boolean;
}

/** Staff addresses emailed for every new application and every inquiry sent from the public /sponsor form. */
export function AdminSponsorNotify({ token, canEdit, onAuthError }: Props) {
  const [saved, setSaved] = useState<string[] | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function load(signal?: { cancelled: boolean }) {
    try {
      const list = await fetchSponsorNotifyEmails(token);
      if (signal?.cancelled) return;
      setSaved(list);
      setEmails(list);
      setLoadError(null);
    } catch (err) {
      if (signal?.cancelled || onAuthError(err)) return;
      setLoadError(sponsorErrorText(err, 'โหลดรายชื่ออีเมลไม่สำเร็จ', { context: 'list' }));
    }
  }

  useEffect(() => {
    if (!canEdit) return;
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [token, canEdit]);

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const email = stripZeroWidth(draft).trim().toLowerCase();
    let problem: string | null = null;
    if (!email) problem = 'กรุณากรอกอีเมล';
    else if (email.length > EMAIL_MAX) problem = `อีเมลยาวได้ไม่เกิน ${EMAIL_MAX} ตัวอักษร`;
    else if (!EMAIL_RE.test(email)) problem = 'รูปแบบอีเมลไม่ถูกต้อง เช่น staff@example.com';
    else if (emails.includes(email)) problem = 'มีอีเมลนี้ในรายการแล้ว';
    else if (emails.length >= MAX_EMAILS) problem = `เพิ่มได้สูงสุด ${MAX_EMAILS} อีเมล`;
    setDraftError(problem);
    if (problem) {
      document.getElementById('sponsor-notify-input')?.focus();
      return;
    }
    setNotice(null);
    setEmails((prev) => [...prev, email]);
    setDraft('');
  }

  function onRemove(index: number) {
    if (saving) return;
    setNotice(null);
    setEmails((prev) => prev.filter((_, i) => i !== index));
    const next = emails[index + 1] ?? emails[index - 1];
    focusLater(next ? `sponsor-notify-remove-${next}` : 'sponsor-notify-input', 'sponsor-notify-input');
  }

  async function onSave() {
    if (!canEdit || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      const list = await updateSponsorNotifyEmails(token, emails);
      setSaved(list);
      setEmails(list);
      setNotice({
        kind: 'ok',
        text: list.length > 0 ? `บันทึกแล้ว ระบบจะแจ้งเตือนไปยัง ${list.length} อีเมล` : 'บันทึกแล้ว ตอนนี้ไม่มีอีเมลรับแจ้งเตือน',
      });
    } catch (err) {
      if (onAuthError(err)) return;
      setNotice({
        kind: 'error',
        text: `บันทึกไม่สำเร็จ: ${sponsorErrorText(err, UNKNOWN_ERROR, {
          validation: `อีเมลไม่ถูกต้อง (สูงสุด ${MAX_EMAILS} อีเมล แต่ละอีเมลไม่เกิน ${EMAIL_MAX} ตัวอักษร)`,
        })}`,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (!canEdit) {
    return (
      <p className="text-sm leading-7" style={{ color: INK_3 }}>
        เฉพาะผู้ดูแลระบบเท่านั้นที่ตั้งค่านี้ได้
      </p>
    );
  }

  const dirty = saved !== null && (saved.length !== emails.length || saved.some((e, i) => e !== emails[i]));
  const full = emails.length >= MAX_EMAILS;

  return (
    <section aria-label="อีเมลแจ้งเตือน" className="flex max-w-2xl flex-col gap-5">
      <p className="text-sm leading-[1.75]" style={{ color: INK_2 }}>
        ระบบจะส่งอีเมลแจ้งไปยังทุกอีเมลในรายการนี้ เมื่อมีน้องสมัครค่ายเข้ามาใหม่ (ชื่อ โรงเรียน จังหวัด และจำนวนที่นั่ง — ไม่มีรหัสใบสมัครหรือเบอร์โทร) และเมื่อมีคนส่งฟอร์ม “แจ้งความประสงค์สนับสนุน” จากหน้า /sponsor
      </p>

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
      {saved === null && !loadError && (
        <p className="text-sm leading-7" style={{ color: INK_3 }}>
          กำลังโหลด…
        </p>
      )}

      {saved !== null && (
        <>
          {emails.length === 0 ? (
            <p className="text-sm leading-7" style={{ color: INK_3 }}>
              ยังไม่มีอีเมลรับแจ้งเตือน — ใบสมัครและข้อมูลจากฟอร์มสนับสนุนยังถูกเก็บไว้ในหน้าแอดมินเสมอ
            </p>
          ) : (
            <ul className="flex flex-col border-t" style={{ borderColor: RULE }} aria-label="อีเมลรับแจ้งเตือน">
              {emails.map((email, i) => (
                <li key={email} className="flex items-center justify-between gap-3 border-b py-2" style={{ borderColor: RULE }}>
                  <span className="min-w-0 break-all font-mono text-sm leading-7" style={{ color: INK }}>
                    {email}
                  </span>
                  <button
                    id={`sponsor-notify-remove-${email}`}
                    type="button"
                    disabled={saving}
                    aria-label={`นำ ${email} ออก`}
                    onClick={() => onRemove(i)}
                    className={`inline-flex size-11 shrink-0 items-center justify-center rounded-full border transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-40 ${FOCUS}`}
                    style={{ borderColor: RULE, color: INK }}
                  >
                    <X aria-hidden="true" size={18} strokeWidth={1.5} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={onAdd} noValidate className="flex flex-col gap-2">
            <label htmlFor="sponsor-notify-input" className="text-sm font-semibold" style={{ color: INK }}>
              เพิ่มอีเมล
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="sponsor-notify-input"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                maxLength={EMAIL_MAX}
                placeholder="staff@example.com"
                value={draft}
                disabled={saving || full}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDraftError(null);
                }}
                aria-invalid={draftError ? true : undefined}
                aria-describedby={draftError ? 'sponsor-notify-help sponsor-notify-error' : 'sponsor-notify-help'}
                className={`${INPUT_BASE} min-h-11 rounded-xl font-mono text-base`}
                style={{ borderColor: draftError ? DANGER : INPUT_BORDER, color: INK }}
              />
              <button
                type="submit"
                disabled={saving || full}
                className={`${PILL_GHOST} shrink-0 gap-1.5`}
                style={{ borderColor: RULE, color: INK }}
              >
                <Plus aria-hidden="true" size={16} strokeWidth={1.5} />
                เพิ่ม
              </button>
            </div>
            <p id="sponsor-notify-help" className="text-xs leading-5" style={{ color: INK_3 }}>
              สูงสุด {MAX_EMAILS} อีเมล (ตอนนี้ <span className="font-mono tabular-nums">{emails.length}</span>) · กด “บันทึก” เพื่อใช้งานรายการใหม่
            </p>
            {draftError && (
              <p id="sponsor-notify-error" className="text-sm leading-6" style={{ color: DANGER }}>
                {draftError}
              </p>
            )}
          </form>

          {notice && <NoticeBanner notice={notice} />}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={saving || !dirty}
              aria-busy={saving || undefined}
              onClick={onSave}
              className={`inline-flex min-h-11 items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
              style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
            >
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
            {dirty && !saving && (
              <button
                type="button"
                onClick={() => {
                  setEmails(saved);
                  setDraftError(null);
                  setNotice(null);
                }}
                className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 ${FOCUS}`}
                style={{ color: INK_2 }}
              >
                ยกเลิกการเปลี่ยนแปลง
              </button>
            )}
            {dirty && (
              <span className="text-xs leading-5" style={{ color: INK_3 }}>
                มีการเปลี่ยนแปลงที่ยังไม่บันทึก
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
