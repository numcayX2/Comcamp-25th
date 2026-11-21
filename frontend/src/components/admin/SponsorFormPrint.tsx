import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { SponsorDonation } from '../../lib/api';
import { bahtText, formatThaiLongDate } from '../../lib/thai-baht-text';
import { formatAmount, formatPhone } from './sponsor-ui';
import '../../styles/sponsor-print.css';

/**
 * The donation fields printed on the faculty form. The tax / national ID is never stored: on a money
 * (or blank) form its line stays blank for the donor to write; a goods donation cannot be claimed as a
 * tax deduction, so its form has no such line.
 */
export type PrintableDonation = Pick<
  SponsorDonation,
  'donorName' | 'address' | 'phone' | 'kind' | 'amount' | 'goodsDescription' | 'donatedOn'
>;

interface Props {
  /** null prints the blank form. */
  donation: PrintableDonation | null;
  /** Called after the print dialog closes (or the component is torn down). */
  onDone: () => void;
}

const PRINTING_CLASS = 'sponsor-printing';
/** Body size of the sheet in pt; very long records shrink in steps down to MIN_PT to stay on one page. */
const BASE_PT = 12.5;
const MIN_PT = 8;

/** A short value on a dotted line, at least `min` em wide (blank when there is no value). */
function Fill({ value, min }: { value?: string; min: number }) {
  return (
    <span className="sponsor-sheet__fill" style={{ minWidth: `${min}em` }}>
      {value?.trim() || '\u00A0'}
    </span>
  );
}

/** A value that takes the rest of its row; every wrapped line gets its own dotted rule. */
function Rule({ value }: { value?: string }) {
  return <span className="sponsor-sheet__rule">{value?.trim() || '\u00A0'}</span>;
}

function Box({ checked }: { checked: boolean }) {
  return (
    <span className="sponsor-sheet__box">
      {checked && (
        <svg viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 13 10 19 21 5" />
        </svg>
      )}
    </span>
  );
}

/**
 * Prints the faculty donation form ("แบบฟอร์มบริจาคเงินหรือสิ่งของ…") on one A4 page, pre-filled
 * from a donation record or blank. Mount it to print: it portals the sheet into <body>, waits for
 * the header image and fonts, shrinks the type if the record would overflow the page, flags <html>
 * so print CSS hides the app, calls window.print() and cleans up on `afterprint`.
 */
export function SponsorFormPrint({ donation, onDone }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    const html = document.documentElement;
    const onAfterPrint = () => {
      html.classList.remove(PRINTING_CLASS);
      window.removeEventListener('afterprint', onAfterPrint);
      if (!cancelled) onDoneRef.current();
    };

    (async () => {
      const img = imgRef.current;
      const imgReady = Promise.withResolvers<void>();
      if (img && !img.complete) {
        img.addEventListener('load', () => imgReady.resolve(), { once: true });
        img.addEventListener('error', () => imgReady.resolve(), { once: true });
      } else {
        imgReady.resolve();
      }
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, 3000);
      await Promise.race([Promise.all([imgReady.promise, document.fonts?.ready]), timeout.promise]);
      clearTimeout(timer);
      if (cancelled) return;
      const sheet = sheetRef.current;
      if (sheet) {
        let pt = BASE_PT;
        sheet.style.fontSize = `${pt}pt`;
        // Bottom of the signature block, with ~2 mm of slack for print rasterisation differences.
        const overflows = () =>
          (sheet.lastElementChild?.getBoundingClientRect().bottom ?? 0) - sheet.getBoundingClientRect().top >
          sheet.clientHeight - 8;
        while (overflows() && pt > MIN_PT) {
          pt -= 0.25;
          sheet.style.fontSize = `${pt}pt`;
        }
      }
      html.classList.add(PRINTING_CLASS);
      window.addEventListener('afterprint', onAfterPrint);
      window.print();
    })();

    return () => {
      cancelled = true;
      html.classList.remove(PRINTING_CLASS);
      window.removeEventListener('afterprint', onAfterPrint);
    };
  }, []);

  const d = donation;
  const isMoney = d?.kind === 'money';
  const isGoods = d?.kind === 'goods';
  const amount = d?.amount ?? '';
  const moneyAmount = isMoney && amount ? formatAmount(amount) : '';
  const goodsValue = isGoods && amount ? formatAmount(amount) : '';
  const dateText = d ? formatThaiLongDate(d.donatedOn) : '';

  return createPortal(
    <div className="sponsor-print-root" aria-hidden="true">
      <style>{'@page { size: A4; margin: 0; }'}</style>
      <div ref={sheetRef} className="sponsor-sheet">
        <img
          ref={imgRef}
          className="sponsor-sheet__logos"
          src="/assets/docs/sponsor-form-logos.jpg"
          width={438}
          height={141}
          alt=""
        />
        <div className="sponsor-sheet__title">
          <span>แบบฟอร์มบริจาคเงินหรือสิ่งของเพื่อสนับสนุน</span>
          <span>การดำเนินงานของหลักสูตรวิทยาศาสตรบัณฑิต</span>
          <span>สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้</span>
        </div>

        <p className="sponsor-sheet__date">
          วันที่ <Fill value={dateText} min={12} />
        </p>

        <p className="sponsor-sheet__line">
          <span className="sponsor-sheet__label">เรื่อง</span>
          ขอบริจาคเงินหรือสิ่งของเพื่อสนับสนุนการดำเนินงานของหลักสูตรฯ สาขาวิชาวิทยาการคอมพิวเตอร์
        </p>
        <p className="sponsor-sheet__line">
          <span className="sponsor-sheet__label">เรียน</span>
          คณบดีคณะวิทยาศาสตร์
        </p>

        <div className="sponsor-sheet__block">
          <p className="sponsor-sheet__row sponsor-sheet__row--indent">
            <span className="sponsor-sheet__nw">ข้าพเจ้า</span>
            <Rule value={d?.donorName} />
          </p>
          <p className="sponsor-sheet__row">
            <span className="sponsor-sheet__nw">ที่อยู่</span>
            <Rule value={d?.address} />
          </p>
          <p className="sponsor-sheet__row">
            <span className="sponsor-sheet__nw">หมายเลขโทรศัพท์มือถือ</span>
            <Fill value={d?.phone ? formatPhone(d.phone) : undefined} min={14} />
          </p>
          {!isGoods && (
            <p className="sponsor-sheet__row">
              <span className="sponsor-sheet__nw">เลขประจำตัวผู้เสียภาษี/เลขบัตรประชาชน</span>
              <Rule />
            </p>
          )}
        </div>

        <p className="sponsor-sheet__para">
          มีความประสงค์ ขอบริจาคเพื่อสนับสนุนการดำเนินงานของหลักสูตรวิทยาศาสตรบัณฑิต สาขาวิชาวิทยาการคอมพิวเตอร์
          คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้ โดยบริจาคเป็น
        </p>
        <p className="sponsor-sheet__row sponsor-sheet__row--choice">
          <Box checked={isMoney} />
          <span className="sponsor-sheet__nw">เงินสด จำนวน</span>
          <Fill value={moneyAmount} min={7} />
          <span className="sponsor-sheet__nw">บาท (ตัวอักษร)</span>
          <Rule value={moneyAmount ? bahtText(amount) : ''} />
        </p>
        <p className="sponsor-sheet__row sponsor-sheet__row--choice">
          <Box checked={isGoods} />
          <span className="sponsor-sheet__nw">สิ่งของ ได้แก่</span>
          <Rule value={isGoods ? d?.goodsDescription : ''} />
        </p>
        <p className="sponsor-sheet__row sponsor-sheet__row--sub">
          <span className="sponsor-sheet__nw">มูลค่าโดยประมาณ</span>
          <Fill value={goodsValue} min={7} />
          <span className="sponsor-sheet__nw">บาท (ตัวอักษร)</span>
          <Rule value={goodsValue ? bahtText(amount) : ''} />
        </p>

        <div className="sponsor-sheet__sign">
          <p className="sponsor-sheet__row">
            <span className="sponsor-sheet__nw">ลงชื่อ</span>
            <Rule />
            <span className="sponsor-sheet__nw">ผู้บริจาค</span>
          </p>
          <p>
            ( <Fill value={d?.donorName} min={16} /> )
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
