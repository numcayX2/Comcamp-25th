/**
 * Slip upload on the receipt (Step 06). It only ever renders after a successful submit, so nobody
 * can pay before the seat is secured (30-seat race). The same upload exists on /status for people
 * who pay later or whose slip was rejected. This block stays flat on the .rw-block flow: no card
 * inside the receipt card. The upload itself is the shared SlipUploadPanel.
 */
import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import type { ApplicationStatus, SlipStatus } from '../../lib/api';
import { SlipUploadPanel } from '../slip/SlipUploadPanel';
import { FB_URL, STAFF_CONTACTS } from './model';

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
  defaultVerifyCode,
  onUploaded,
}: {
  appId: string;
  slip: SlipStatus | null;
  appStatus: ApplicationStatus | null;
  /** False until the first status sync finished (the badge shows a neutral "checking" label). */
  synced: boolean;
  /** In-memory 4-digit verify code passed from the register wizard (never persisted). */
  defaultVerifyCode?: string;
  onUploaded: (status: SlipStatus) => void;
}) {
  // Backend PaymentService.UploadSlip only allows PASSED and CONFIRMED.
  const closed = appStatus !== null && appStatus !== 'PASSED' && appStatus !== 'CONFIRMED';
  const hasDefaultCode = Boolean(defaultVerifyCode && /^\d{4}$/.test(defaultVerifyCode));
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
        <span className="rw-slip__step"><b className="font-mono tabular-nums">1</b> โอนภายใน <span className="font-mono tabular-nums">72</span> ชม.</span>
        <span className="rw-slip__step"><b className="font-mono tabular-nums">2</b> {hasDefaultCode ? 'แนบสลิปและกดส่ง' : 'แนบสลิป'}</span>
        {!hasDefaultCode && (
          <span className="rw-slip__step"><b className="font-mono tabular-nums">3</b> กรอกเลข <span className="font-mono tabular-nums">4</span> ตัว</span>
        )}
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
              ({c.name})
            </Fragment>
          ))}
        </p>
      )}

      <div className="rw-slip__panel">
        <SlipUploadPanel
          appId={appId}
          slip={slip}
          disabled={closed}
          defaultVerifyCode={defaultVerifyCode}
          onUploaded={(status) => onUploaded(status)}
          deferLink={{ href: `/status?id=${encodeURIComponent(appId)}`, label: 'ยังไม่สะดวกตอนนี้? ส่งสลิปทีหลังที่หน้าตรวจสอบสถานะ' }}
        />
      </div>
    </section>
  );
}
