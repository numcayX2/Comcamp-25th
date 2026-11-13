/**
 * Slip upload on the receipt (Step 06). It only ever renders after a successful submit, so nobody
 * can pay before the seat is secured (30-seat race). The same upload exists on /status for people
 * who pay later or whose slip was rejected. This block stays flat on the .rw-block flow: no card
 * inside the receipt card. The upload itself is the shared SlipUploadPanel.
 */
import type { CSSProperties } from 'react';
import type { ApplicationStatus, SlipStatus } from '../../lib/api';
import { SlipUploadPanel } from '../slip/SlipUploadPanel';

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
      <p className="rw-slip__lead">
        ที่นั่งของคุณถูกจองไว้แล้วตั้งแต่ส่งใบสมัคร โอนเงินแล้วแนบสลิปที่นี่ได้เลย หรือจะส่งทีหลังที่หน้าตรวจสอบสถานะก็ได้
      </p>

      {closed && (
        <p className="rw-slip__note">
          ใบสมัครนี้ไม่อยู่ในสถานะที่ส่งสลิปได้แล้ว หากมีข้อสงสัยกรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ
        </p>
      )}

      <div className="rw-slip__panel">
        <SlipUploadPanel
          appId={appId}
          slip={slip}
          disabled={closed}
          onUploaded={(status) => onUploaded(status)}
          deferLink={{ href: `/status?id=${encodeURIComponent(appId)}`, label: 'ยังไม่สะดวกตอนนี้? ส่งสลิปทีหลังที่หน้าตรวจสอบสถานะ' }}
        />
      </div>
    </section>
  );
}
