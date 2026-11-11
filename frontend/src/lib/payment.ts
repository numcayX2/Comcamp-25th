/** Payment details for the camp fee, shared by the /register receipt and the /status slip section. */

/** Payment account for the camp fee. There is no QR code: transfer by account number only. */
export const PAY_ACCOUNT = {
  bank: 'ธนาคารกรุงเทพ',
  name: 'ชมรมคอมพิวเตอร์',
  holders: 'นายภานุวัฒน์ นายอรรถวิท นายปวีณ',
  number: '587-0-84106-0',
} as const;

/** The only wording about how to pay: no PromptPay, no QR code. */
export const NO_QR_NOTE = 'ไม่มี QR Code สำหรับชำระเงิน โอนผ่านเลขบัญชีด้านบนเท่านั้น';

/** Digits only, so banking apps accept the paste. */
export const PAY_ACCOUNT_DIGITS = PAY_ACCOUNT.number.replace(/\D/g, '');

/** Clipboard API first; fall back to execCommand for Facebook / LINE in-app browsers. */
export async function copyText(text: string): Promise<boolean> {
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
