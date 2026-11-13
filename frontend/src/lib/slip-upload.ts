/**
 * Shared slip-upload helpers for /status (StatusSection) and the receipt on /register.
 *
 * Hard server limits mirror the backend (AGENTS.md section 13.4): JPG/PNG/WebP only, 5 MB,
 * 4096x4096 px. Any PNG screenshot, oversized image (> 1600 px), or file > 300 KB is shrunk to
 * a longest edge of 1600 px and re-encoded as WebP (with safe JPEG fallback for older WebViews)
 * in the browser first, keeping banking text and Mini QR crisp while dropping EXIF and upload size.
 * The server still re-validates everything. The verifyCode (last 4 digits of the national ID,
 * section 13.5) is held in component state only: these helpers never touch localStorage or
 * sessionStorage.
 */
import { ApiHttpError } from './api';

/** Server limit on slip width and height (AGENTS.md section 13.4). */
export const MAX_SLIP_PX = 4096;
export const MAX_SLIP_BYTES = 5 * 1024 * 1024;
/** Target longest edge and size threshold for automatic client-side WebP optimization. */
const OPTIMIZE_MAX_EDGE = 1600;
const OPTIMIZE_TARGET_BYTES = 300 * 1024;

/** Must match the backend allow-list (magic-byte checked server-side). */
export const SLIP_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const SLIP_ACCEPT = SLIP_TYPES.join(',');

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/**
 * Normalises what a student typed or pasted into the 4-digit code: Thai digits become 0-9, then
 * everything that is not a digit (dashes, spaces, zero-width characters pasted from LINE) is
 * dropped and the result is capped at 4.
 */
export function cleanVerifyCode(value: string): string {
  return value
    .replace(/[๐-๙]/g, (c) => String(THAI_DIGITS.indexOf(c)))
    .replace(/\D/g, '')
    .slice(0, 4);
}

/**
 * The same cleaning for the full 13-digit national ID asked for by self-service withdrawal: Thai
 * digits become 0-9, separators and zero-width characters are dropped, capped at 13. Held in
 * component state only, never in browser storage.
 */
export function cleanNationalIdInput(value: string): string {
  return value
    .replace(/[๐-๙]/g, (c) => String(THAI_DIGITS.indexOf(c)))
    .replace(/\D/g, '')
    .slice(0, 13);
}

/** True when the raw input holds Thai letters: the phone keyboard is still on Thai. Thai digits do not count. */
export function hasThaiKeyboardChars(raw: string): boolean {
  return /[ก-๏]/.test(raw);
}

/** "3.88 MB" / "412 KB" / "900 B", for display next to a picked slip. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Keeps the start and the extension: "Screenshot_2026-11-1…0123.png". */
export function middleTruncate(name: string, max = 30): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  const base = ext ? name.slice(0, dot) : name;
  const keep = Math.max(6, max - ext.length - 1);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${base.slice(0, head)}…${tail > 0 ? base.slice(-tail) : ''}${ext}`;
}

export type SlipCheck =
  | { ok: true; file: File; previewUrl: string; resized: boolean }
  | { ok: false; message: string };

function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void } | null> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file)
      .then((bmp) => ({ source: bmp as CanvasImageSource, width: bmp.width, height: bmp.height, close: () => bmp.close() }))
      .catch(() => decodeWithImage(file));
  }
  return decodeWithImage(file);
}

function decodeWithImage(file: File) {
  return new Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void } | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

type EncodedCanvas = {
  blob: Blob;
  ext: 'webp' | 'jpg';
  mime: 'image/webp' | 'image/jpeg';
};

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encodeCanvasOptimal(canvas: HTMLCanvasElement, quality: number): Promise<EncodedCanvas | null> {
  // Prefer WebP for smaller banking slips; verify blob.type because older WebKit WebViews may
  // silently fall back to returning image/png when asked for image/webp.
  const webp = await canvasToBlob(canvas, 'image/webp', quality);
  if (webp && webp.type === 'image/webp') {
    return { blob: webp, ext: 'webp', mime: 'image/webp' };
  }
  const jpeg = await canvasToBlob(canvas, 'image/jpeg', Math.min(0.9, quality + 0.03));
  if (!jpeg || (jpeg.type && jpeg.type !== 'image/jpeg')) return null;
  return { blob: jpeg, ext: 'jpg', mime: 'image/jpeg' };
}

/** Re-encodes via canvas (WebP with JPEG fallback), dropping EXIF metadata from phone photos. */
async function shrink(
  src: { source: CanvasImageSource; width: number; height: number },
  edge: number,
  quality: number,
): Promise<EncodedCanvas | null> {
  const scale = Math.min(1, edge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff'; // fill transparent PNG areas with white so text/QR stay legible
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src.source, 0, 0, w, h);
  return encodeCanvasOptimal(canvas, quality);
}

const UNREADABLE = 'เปิดรูปนี้ไม่ได้ กรุณาเลือกรูปอื่น หรือแคปหน้าจอสลิปจากแอปธนาคารอีกครั้ง';
const STILL_TOO_BIG = 'รูปนี้ใหญ่เกินไปแม้ย่อให้แล้ว กรุณาแคปหน้าจอสลิปจากแอปธนาคารแล้วเลือกรูปใหม่';

/**
 * Validates and optimizes a chosen slip: type first, then decoding. Any PNG screenshot, image
 * wider/taller than 1600 px, or file above 300 KB is shrunk to <= 1600 px as WebP (or JPEG when
 * WebP encoding is unavailable). Smaller valid JPG/WebP files are sent directly. On success the
 * caller owns `previewUrl` and must URL.revokeObjectURL it when done.
 */
export async function prepareSlipFile(file: File): Promise<SlipCheck> {
  if (!SLIP_TYPES.includes(file.type)) {
    return { ok: false, message: 'กรุณาเลือกไฟล์รูปภาพ (JPG, PNG หรือ WebP)' };
  }
  const img = await decode(file);
  if (!img) return { ok: false, message: UNREADABLE };

  try {
    const withinHardLimit = img.width <= MAX_SLIP_PX && img.height <= MAX_SLIP_PX && file.size <= MAX_SLIP_BYTES;
    const needsOptimize =
      !withinHardLimit ||
      img.width > OPTIMIZE_MAX_EDGE ||
      img.height > OPTIMIZE_MAX_EDGE ||
      file.size > OPTIMIZE_TARGET_BYTES ||
      file.type === 'image/png';
    if (!needsOptimize) return { ok: true, file, previewUrl: URL.createObjectURL(file), resized: false };

    let encoded: EncodedCanvas | null = null;
    for (const [edge, q] of [[OPTIMIZE_MAX_EDGE, 0.82], [1280, 0.76], [1024, 0.7]] as const) {
      encoded = await shrink(img, edge, q);
      if (encoded && encoded.blob.size <= MAX_SLIP_BYTES) break;
    }
    if (!encoded) return { ok: false, message: UNREADABLE };
    if (encoded.blob.size > MAX_SLIP_BYTES) return { ok: false, message: STILL_TOO_BIG };

    // Rare tiny PNGs may already be smaller than lossy re-encoding; keep the original when valid.
    if (withinHardLimit && encoded.blob.size >= file.size) {
      return { ok: true, file, previewUrl: URL.createObjectURL(file), resized: false };
    }

    const base = file.name.replace(/\.[^.]+$/, '') || 'slip';
    const out = new File([encoded.blob], `${base}.${encoded.ext}`, { type: encoded.mime, lastModified: Date.now() });
    return { ok: true, file: out, previewUrl: URL.createObjectURL(out), resized: true };
  } finally {
    img.close();
  }
}

/** First image file on a drop or paste event, or null. */
export function firstImageFile(files: FileList | null | undefined): File | null {
  if (!files) return null;
  for (const f of Array.from(files)) if (f.type.startsWith('image/')) return f;
  return null;
}

/** "HH:MM น." for the moment a rate-limit lock ends, rounded up to the next minute. */
function clockAfter(seconds: number): string {
  const t = new Date(Math.ceil((Date.now() + seconds * 1000) / 60000) * 60000);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} น.`;
}

/**
 * The per-IP limit answers within a minute; a Retry-After longer than that means the application
 * itself is locked after 5 wrong verify answers (backend VerifyGuard, 15 minutes).
 */
const VERIFY_LOCK_MIN_SECONDS = 60;

/** Thai copy for the 15-minute lock after repeated wrong verify codes / national IDs, else null. */
export function describeVerifyLock(err: unknown): string | null {
  if (!(err instanceof ApiHttpError) || err.status !== 429) return null;
  if (!err.retryAfterSeconds || err.retryAfterSeconds <= VERIFY_LOCK_MIN_SECONDS) return null;
  return `กรอกเลขยืนยันตัวตนผิดหลายครั้ง เพื่อความปลอดภัยระบบจึงพักการยืนยันตัวตนของใบสมัครนี้ไว้ชั่วคราว กรุณาลองใหม่หลังเวลา ${clockAfter(err.retryAfterSeconds)}`;
}

/** Thai copy for validation errors, differentiating query lookup, slip upload, profile edit, and withdraw. */
function describeValidationError(message: string, fallback: string): string {
  const msg = message.toLowerCase();
  if (msg.includes('search query') || msg.includes("query parameter 'q'")) {
    return 'ข้อมูลที่ค้นหาไม่ถูกต้อง กรุณาระบุเลขบัตรประชาชน 13 หลัก เบอร์โทร 10 หลัก หรือรหัส CC25-XXXXXX';
  }
  if (msg.includes('file type') || msg.includes('slip') || msg.includes('multipart')) {
    return 'ไฟล์รูปภาพไม่ถูกต้อง รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP เท่านั้น';
  }
  if (msg.includes('verifycode')) {
    return 'กรุณากรอกเลข 4 ตัวท้ายของบัตรประชาชนให้ครบ 4 หลัก';
  }
  if (msg.includes('national id')) {
    return 'เลขประจำตัวประชาชน 13 หลักไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
  }
  if (msg.includes('grade')) {
    return 'ระดับชั้นไม่ถูกต้อง กรุณาเลือกระดับชั้นหรือระบุความยาว 2–20 ตัวอักษร';
  }
  if (msg.includes('shirt size')) {
    return 'ไซส์เสื้อไม่ถูกต้อง กรุณาเลือกไซส์ที่กำหนด';
  }
  if (msg.includes('too long')) {
    return 'ข้อความที่กรอกยาวเกินกำหนด กรุณาย่อให้สั้นลง';
  }
  if (msg.includes('blank') || msg.includes('required')) {
    return 'กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน';
  }
  return fallback;
}

/** Thai copy keyed by the backend error code; never exposes raw English developer errors to users. */
export function describeApiError(err: unknown, fallback: string): string {
  const locked = describeVerifyLock(err);
  if (locked) return locked;
  if (err instanceof ApiHttpError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return 'ไม่พบข้อมูลใบสมัครในระบบ กรุณาตรวจสอบเลขประจำตัวประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัครอีกครั้ง';
      case 'INVALID_VERIFY_CODE':
        return 'เลข 4 ตัวท้ายของบัตรประชาชนไม่ตรงกับใบสมัครนี้ กรุณาตรวจสอบแล้วลองอีกครั้ง';
      case 'INVALID_IMAGE_DIMENSIONS':
        return `รูปสลิปมีขนาดใหญ่เกิน ${MAX_SLIP_PX}×${MAX_SLIP_PX} พิกเซล กรุณาส่งภาพหน้าจอสลิปจากแอปธนาคาร หรือย่อรูปก่อนอัปโหลด`;
      case 'DUPLICATE_SLIP':
        return 'สลิปนี้เคยถูกอัปโหลดในระบบแล้ว กรุณาใช้สลิปการโอนของใบสมัครนี้';
      case 'ALREADY_VERIFIED':
        return 'สลิปนี้ได้รับการตรวจสอบยืนยันเรียบร้อยแล้ว ไม่จำเป็นต้องอัปโหลดซ้ำ';
      case 'SLIP_CHANGED':
        return 'ผู้สมัครได้อัปโหลดสลิปใหม่แทนใบเดิมแล้ว กรุณาโหลดข้อมูลล่าสุดเพื่อตรวจสอบสลิปปัจจุบัน';
      case 'PAYLOAD_TOO_LARGE':
        return 'ขนาดไฟล์รูปภาพใหญ่เกิน 5 MB กรุณาเลือกรูปภาพที่มีขนาดเล็กลง';
      case 'RATE_LIMITED':
        return err.retryAfterSeconds
          ? `ทำรายการถี่เกินไป กรุณาลองใหม่หลังเวลา ${clockAfter(err.retryAfterSeconds)}`
          : 'ทำรายการถี่เกินไป เพื่อความปลอดภัยกรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
      case 'VALIDATION_ERROR':
        return describeValidationError(err.message, fallback);
      case 'SERVICE_UNAVAILABLE':
        return 'ระบบกำลังมีผู้ใช้งานจำนวนมาก กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
      case 'REGISTRATION_CLOSED':
        return 'ระบบปิดรับสมัครตามกำหนดการแล้ว หากมีข้อสงสัยกรุณาติดต่อทีมงานพี่ค่าย';
      case 'QUOTA_FULL':
        return 'ขณะนี้มีผู้สมัครครบตามจำนวนที่รับแล้ว';
      case 'DUPLICATE_APPLICATION':
        return 'เลขบัตรประชาชน เบอร์โทรศัพท์ หรืออีเมลนี้เคยใช้สมัครแล้ว';
      case 'CAPTCHA_FAILED':
        return 'การยืนยันตัวตนไม่ผ่านหรือหมดอายุ กรุณายืนยันใหม่อีกครั้ง';
      case 'IDEMPOTENCY_KEY_REUSED':
        return 'รหัสอ้างอิงการส่งถูกใช้กับใบสมัครอื่นแล้ว กรุณารีเฟรชหน้าแล้วลองใหม่';
      case 'UNAUTHORIZED':
        return 'เซสชันหมดอายุหรือไม่มีสิทธิ์เข้าถึง กรุณาเข้าสู่ระบบใหม่อีกครั้ง';
      case 'FORBIDDEN':
        return 'ใบสมัครนี้อยู่ในสถานะที่ดำเนินการขั้นตอนนี้ไม่ได้ หากมีข้อสงสัยกรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ';
    }
    if (err.status === 429) {
      return err.retryAfterSeconds
        ? `ทำรายการถี่เกินไป กรุณาลองใหม่หลังเวลา ${clockAfter(err.retryAfterSeconds)}`
        : 'ทำรายการถี่เกินไป เพื่อความปลอดภัยกรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
    }
    if (err.status === 404) {
      return 'ไม่พบข้อมูลใบสมัครในระบบ กรุณาตรวจสอบเลขประจำตัวประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัครอีกครั้ง';
    }
    if (err.status === 403) {
      return 'ไม่สามารถดำเนินการได้ในขณะนี้ กรุณาติดต่อทีมงานพี่ค่าย';
    }
    if (err.status === 413) {
      return 'ขนาดไฟล์รูปภาพใหญ่เกิน 5 MB กรุณาเลือกรูปภาพที่มีขนาดเล็กลง';
    }
    if (err.status >= 500) {
      return 'ระบบขัดข้องชั่วคราว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
    }
    return fallback;
  }
  return 'ไม่สามารถเชื่อมต่อกับระบบได้ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง';
}
