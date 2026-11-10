/** Step 06 — receipt + payment instructions, shown after a successful submit. */
import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { ArrowRight, Check, Copy } from 'lucide-react';
import type { ApiSource } from '../../lib/api';
import { FB_URL, FEE_TEXT, RECEIPT_META, RECEIPT_STEP } from './model';
import { StepHeader } from './parts';

type CopyState = 'idle' | 'copied' | 'failed';

/** Clipboard API first; fall back to execCommand for Facebook / LINE in-app browsers. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function Receipt({
  appId,
  source,
  showSource,
  headingRef,
}: {
  appId: string;
  source: ApiSource | null;
  showSource: boolean;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onCopy() {
    const ok = await copyText(appId);
    setCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopy('idle'), ok ? 2200 : 5000);
  }

  return (
    <div className="rw-receipt">
      <StepHeader
        no={RECEIPT_STEP + 1}
        title={RECEIPT_META.title}
        lead="บันทึกรหัสด้านล่างไว้ ใช้ตรวจสอบสถานะและส่งสลิปการชำระเงิน"
        headingRef={headingRef}
      />

      <section className="rw-block" aria-label="รหัสใบสมัคร">
        <p className="rw-block__label">รหัสใบสมัคร</p>
        <p className="rw-id" data-app-id>{appId}</p>
        <div className="rw-copyrow">
          <button type="button" className="rw-btn rw-btn--ghost rw-btn--sm" onClick={onCopy}>
            {copy === 'copied' ? <Check size={18} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={18} strokeWidth={1.5} aria-hidden="true" />}
            {copy === 'copied' ? 'คัดลอกแล้ว' : 'คัดลอกรหัส'}
          </button>
          <p className="rw-copyrow__msg" role="status" aria-live="polite">
            {copy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่รหัสแล้วเลือกคัดลอก'}
          </p>
        </div>
      </section>

      <section className="rw-block" aria-labelledby="rw-pay-title">
        <h3 id="rw-pay-title" className="rw-block__title">
          ชำระค่าสมัคร <span className="font-mono">{FEE_TEXT}</span> บาท
        </h3>
        <div className="rw-pay">
          <dl className="rw-dl rw-dl--pay">
            {/* TODO(content): รอประกาศอย่างเป็นทางการ — ชื่อธนาคาร / ชื่อบัญชี / เลขที่บัญชี */}
            <dt>ธนาคาร</dt>
            <dd className="rw-todo">รอประกาศ</dd>
            <dt>ชื่อบัญชี</dt>
            <dd className="rw-todo">รอประกาศ</dd>
            <dt>เลขที่บัญชี</dt>
            <dd className="rw-todo">รอประกาศ</dd>
            <dt>จำนวนเงิน</dt>
            <dd><span className="font-mono">{FEE_TEXT}</span> บาท</dd>
          </dl>

          <figure className="rw-qr-fig">
            {/*
              TODO(content): ใส่รูป QR สำหรับชำระเงิน — วางไฟล์ใน public/assets/ แล้วใส่
              <img src="/assets/payment-qr.png" alt="QR Code สำหรับชำระเงิน" /> ไว้ใน .rw-qr
              กล่องนี้เป็นสี่เหลี่ยมจัตุรัสคงที่ ใส่รูปแล้วเลย์เอาต์ไม่ขยับ
            */}
            <div className="rw-qr" />
            <figcaption className="rw-qr-cap">QR Code สำหรับชำระเงิน (รออัปเดตรูปภาพ)</figcaption>
          </figure>
        </div>
      </section>

      <section className="rw-block" aria-labelledby="rw-next-title">
        <h3 id="rw-next-title" className="rw-block__title">ขั้นตอนถัดไป</h3>
        <ol className="rw-steps">
          <li>โอนเงินตามรายละเอียดด้านบน แล้วบันทึกหรือแคปหน้าจอสลิป</li>
          <li>เข้าหน้าตรวจสอบสถานะ ค้นหาด้วยรหัสใบสมัคร เลขบัตรประชาชน หรือเบอร์โทรศัพท์ แล้วอัปโหลดสลิป</li>
          <li>รอทีมงานตรวจสอบสลิปและยืนยันสิทธิ์ ติดตามประกาศได้ที่หน้าตรวจสอบสถานะและเพจ Facebook ของโครงการ</li>
        </ol>
        <div className="rw-actions">
          <a href="/status" className="rw-btn rw-btn--primary">
            ไปอัปโหลดสลิปที่หน้าตรวจสอบสถานะ
            <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
          </a>
          <a href={FB_URL} className="rw-textlink" target="_blank" rel="noopener noreferrer">
            เพจ Facebook โครงการ
          </a>
        </div>
      </section>

      {showSource && source && (
        <p className="rw-devnote">
          <span className="font-mono">source: {source}</span>
        </p>
      )}
    </div>
  );
}
