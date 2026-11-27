/**
 * Slip upload on the receipt (Step 06). It only ever renders after a successful submit, so nobody
 * can pay before the seat is secured (40-seat race). The same upload exists on /status for people
 * who pay later or whose slip was rejected. This block stays flat on the .rw-block flow: no card
 * inside the receipt card. The upload itself is the shared SlipUploadPanel. Until a slip is in,
 * a quiet "ยังไม่สะดวกตอนนี้?" card points to /status for paying later.
 */
import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import { ArrowRight, Mail, MailSearch } from 'lucide-react';
import type { ApplicationStatus, SlipStatus } from '../../lib/api';
import { SlipUploadPanel } from '../slip/SlipUploadPanel';
import { FB_URL, PAYMENT_WINDOW_HOURS, STAFF_CONTACTS } from './model';

/** The dot colour carries the state, the label carries the meaning (never colour alone). */
const SLIP_BADGE: Record<SlipStatus | 'NONE', { dot: string; label: string }> = {
  NONE: { dot: 'var(--rw-ink-3)', label: 'ยังไม่ได้ส่งสลิป' },
  PENDING: { dot: 'var(--rw-warn)', label: 'รอทีมงานตรวจสลิป' },
  APPROVED: { dot: 'var(--rw-ok)', label: 'อนุมัติสลิปแล้ว' },
  REJECTED: { dot: 'var(--rw-danger)', label: 'สลิปไม่ผ่าน กรุณาส่งใหม่' },
};

export function SlipBlock({
  appId,
  slip,
  appStatus,
  synced,
  onUploaded,
}: {
  appId: string;
  slip: SlipStatus | null;
  appStatus: ApplicationStatus | null;
  /** False until the first status sync finished (the badge shows a neutral "checking" label). */
  synced: boolean;
  onUploaded: (status: SlipStatus) => void;
}) {
  // Backend PaymentService.UploadSlip only allows PASSED and CONFIRMED.
  const closed = appStatus !== null && appStatus !== 'PASSED' && appStatus !== 'CONFIRMED';
  const held = slip === 'PENDING' || slip === 'APPROVED' || appStatus === 'CONFIRMED';
  const badge = SLIP_BADGE[slip ?? 'NONE'];

  return (
    <section className="rw-block" aria-labelledby="rw-slip-title">
      <div className="rw-slip__head">
        <h3 id="rw-slip-title" className="rw-block__title">
          แนบสลิปเพื่อยืนยันสิทธิ์
        </h3>
        <p className="rw-pill" aria-live="polite" style={{ '--pill': badge.dot } as CSSProperties}>
          <span className="rw-pill__dot" aria-hidden="true" />
          {synced ? badge.label : 'กำลังตรวจสถานะสลิป…'}
        </p>
      </div>
      <p className="rw-slip__steps" aria-label="ขั้นตอนยืนยันสิทธิ์">
        <span className="rw-slip__step"><b className="font-mono tabular-nums">1</b> โอนภายใน <span className="font-mono tabular-nums">{PAYMENT_WINDOW_HOURS}</span> ชม.</span>
        <span className="rw-slip__step"><b className="font-mono tabular-nums">2</b> แนบสลิปและกดส่ง</span>
      </p>
      <p className="rw-slip__privacy">รูปสลิปเปิดดูได้เฉพาะทีมงานในระบบของโครงการ</p>

      {closed && (
        <p className="rw-slip__note">
          ใบสมัครนี้ไม่อยู่ในสถานะที่ส่งสลิปได้แล้ว หากมีข้อสงสัยกรุณาติดต่อทีมงานผ่าน{' '}
          <a href={FB_URL} className="rw-inline-link" target="_blank" rel="noopener noreferrer">
            เพจ Facebook ของโครงการ
          </a>{' '}
          หรือโทร{' '}
          {STAFF_CONTACTS.map((c, idx) => (
            <Fragment key={c.tel}>
              {idx > 0 && ' / '}
              <a href={`tel:${c.tel}`} className="rw-inline-link font-mono tabular-nums">
                {c.phone}
              </a>{' '}
              · {c.name}
            </Fragment>
          ))}
        </p>
      )}

      <div className="rw-slip__panel">
        <SlipUploadPanel
          appId={appId}
          slip={slip}
          disabled={closed}
          onUploaded={(status) => onUploaded(status)}
        />
      </div>

      {!held && !closed && (
        <aside className="rw-later" aria-labelledby="rw-later-title">
          <Mail className="rw-later__deco" size={128} strokeWidth={1.5} aria-hidden="true" />
          <h4 id="rw-later-title" className="rw-later__title">
            <MailSearch size={18} strokeWidth={1.5} aria-hidden="true" />
            ยังไม่สะดวกตอนนี้?
          </h4>
          <p className="rw-later__text">ส่งสลิปและตรวจสอบสถานะได้ทุกเมื่อที่หน้าตรวจสอบสถานะ โดยค้นหาด้วยรหัสใบสมัคร</p>
          <p className="rw-later__text">
            รหัสใบสมัครส่งไปที่อีเมลที่กรอกในใบสมัครแล้ว และจะมีอีเมลแจ้งอีกครั้งเมื่อทีมงานยืนยันสิทธิ์
          </p>
          <p className="rw-later__quiet">ไม่พบอีเมล? ลองดูในโฟลเดอร์ Spam / จดหมายขยะ หรือแท็บ Promotions (Gmail)</p>
          <div className="rw-later__actions">
            <a href="/status" className="rw-btn rw-btn--ghost rw-btn--forward">
              ไปหน้าตรวจสอบสถานะ
              <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </div>
        </aside>
      )}
    </section>
  );
}
