/**
 * Client-side check for the filled sponsor donation form on /sponsor (POST
 * /api/sponsor-inquiries/upload). Mirrors the backend allow-list: PDF, JPG, PNG or WebP up to
 * 8 MB, images at most 10000 px a side. A phone photo of the form that is large, or in a format
 * the server refuses (iPhone HEIC from the Files app), is re-encoded in the browser to WebP/JPEG
 * with a 2400 px long edge: about 200 dpi on A4, so handwriting stays legible. PDFs are sent as
 * they are. The server re-validates everything; nothing here touches storage.
 */
import { SPONSOR_FILE_MAX_BYTES } from './api';
import { decodeImage, shrinkImage, type EncodedCanvas } from './slip-upload';

/** `accept` for the file input. Listing image types explicitly makes iOS hand over JPEG, not HEIC. */
export const SPONSOR_FORM_ACCEPT = 'application/pdf,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';

const SERVER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_PX = 10000;
/** Images above this size are shrunk even when the server would accept them: faster on 4G. */
const OPTIMIZE_ABOVE_BYTES = 3 * 1024 * 1024;
const OPTIMIZE_MAX_EDGE = 2400;

export type SponsorFormCheck = { ok: true; file: File; resized: boolean } | { ok: false; message: string };

const WRONG_TYPE = 'กรุณาเลือกไฟล์ PDF หรือรูปภาพ (JPG, PNG, WebP)';
const UNREADABLE = 'เปิดไฟล์รูปนี้ไม่ได้ กรุณาถ่ายรูปแบบฟอร์มใหม่ หรือเลือกไฟล์ PDF';
const PDF_TOO_BIG = 'ไฟล์ PDF ใหญ่เกิน 8 MB กรุณาถ่ายรูปแบบฟอร์มแทน หรือสแกนให้ไฟล์เล็กลง';
const IMAGE_TOO_BIG = 'รูปนี้ใหญ่เกินไปแม้ย่อแล้ว กรุณาถ่ายรูปแบบฟอร์มใหม่';

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || (file.type === '' && /\.pdf$/i.test(file.name));
}

/** Validates the chosen form file and shrinks a heavy or non-web image before upload. */
export async function prepareSponsorFormFile(file: File): Promise<SponsorFormCheck> {
  if (file.size === 0) return { ok: false, message: 'ไฟล์นี้ว่างเปล่า กรุณาเลือกไฟล์ใหม่' };

  if (isPdf(file)) {
    if (file.size > SPONSOR_FILE_MAX_BYTES) return { ok: false, message: PDF_TOO_BIG };
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (String.fromCharCode(...head) !== '%PDF-') return { ok: false, message: 'ไฟล์ PDF นี้เปิดไม่ได้ กรุณาเลือกไฟล์ใหม่' };
    return { ok: true, file, resized: false };
  }
  if (!file.type.startsWith('image/')) return { ok: false, message: WRONG_TYPE };

  const img = await decodeImage(file);
  if (!img) return { ok: false, message: SERVER_IMAGE_TYPES.includes(file.type) ? UNREADABLE : WRONG_TYPE };
  try {
    const sendable =
      SERVER_IMAGE_TYPES.includes(file.type) &&
      file.size <= SPONSOR_FILE_MAX_BYTES &&
      img.width <= MAX_IMAGE_PX &&
      img.height <= MAX_IMAGE_PX;
    if (sendable && file.size <= OPTIMIZE_ABOVE_BYTES && Math.max(img.width, img.height) <= OPTIMIZE_MAX_EDGE * 2) {
      return { ok: true, file, resized: false };
    }

    let encoded: EncodedCanvas | null = null;
    for (const [edge, q] of [[OPTIMIZE_MAX_EDGE, 0.85], [2000, 0.8], [1600, 0.76]] as const) {
      encoded = await shrinkImage(img, edge, q);
      if (encoded && encoded.blob.size <= SPONSOR_FILE_MAX_BYTES) break;
    }
    if (!encoded) return sendable ? { ok: true, file, resized: false } : { ok: false, message: UNREADABLE };
    if (encoded.blob.size > SPONSOR_FILE_MAX_BYTES) {
      return sendable ? { ok: true, file, resized: false } : { ok: false, message: IMAGE_TOO_BIG };
    }
    if (sendable && encoded.blob.size >= file.size) return { ok: true, file, resized: false };

    const base = file.name.replace(/\.[^.]+$/, '') || 'sponsor-form';
    const out = new File([encoded.blob], `${base}.${encoded.ext}`, { type: encoded.mime, lastModified: Date.now() });
    return { ok: true, file: out, resized: true };
  } finally {
    img.close();
  }
}
