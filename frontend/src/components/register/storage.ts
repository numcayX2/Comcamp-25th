/**
 * Client-side persistence for the /register wizard (AGENTS.md §9.2).
 *
 * Draft   → localStorage, one key, 24h TTL, cleared on successful submit.
 *           Allowlist only: personal + education fields and shirt size. Never stored: the
 *           13-digit national ID (§9.2.1), free-text motivation, health data, the PDPA tick.
 * Idempotency key → sessionStorage (this tab only), §9.2.4: written before POST /applications,
 *           reused by every retry after a timeout / dropped connection / 5xx, and removed only
 *           after a successful response (201, or 200 replay) or when the user starts over.
 * Receipt → sessionStorage (this tab only): just the application id + source, so a refresh
 *           on the receipt screen does not lose the payment instructions.
 *
 * Every access is wrapped: in-app browsers and private modes can throw on storage.
 */
import type { ApiSource } from '../../lib/api';
import { EMPTY_FORM, SHIRT_SIZES, type FormState } from './model';

const DRAFT_KEY = 'comcamp25-register-draft';
const RECEIPT_KEY = 'comcamp25-register-receipt';
const IDEMPOTENCY_KEY = 'cc25_register_idempotency_key';
const TTL_MS = 24 * 60 * 60 * 1000;

const DRAFT_FIELDS = [
  'fullName',
  'nickname',
  'phone',
  'email',
  'school',
  'province',
  'grade',
  'gradeOther',
  'shirtSize',
] as const satisfies readonly (keyof FormState)[];

type DraftFields = Pick<FormState, (typeof DRAFT_FIELDS)[number]>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh X-Idempotency-Key (UUID v4) for one application attempt. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Older in-app WebViews: build a v4 UUID from getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The key of the submission still in flight in this tab, if any. */
export function loadIdempotencyKey(): string | null {
  try {
    const key = sessionStorage.getItem(IDEMPOTENCY_KEY);
    return key && UUID_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

export function saveIdempotencyKey(key: string): void {
  try {
    sessionStorage.setItem(IDEMPOTENCY_KEY, key);
  } catch {
    /* storage blocked: the key still lives in memory for retries until the tab is refreshed */
  }
}

export function clearIdempotencyKey(): void {
  try {
    sessionStorage.removeItem(IDEMPOTENCY_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Restores a ≤24h draft. `legacyKey` is the idempotency key that builds before v2.4 kept inside
 * the localStorage draft; the caller moves it to sessionStorage so an in-flight retry still replays.
 */
export function loadDraft(): { form: FormState; savedAt: number; legacyKey: string | null } | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; savedAt?: number; form?: Partial<DraftFields>; key?: unknown };
    if (parsed.v !== 1 || typeof parsed.savedAt !== 'number' || !parsed.form) throw new Error('bad draft');
    if (Date.now() - parsed.savedAt > TTL_MS) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    // Allowlist on read too: a national ID saved by an older build is dropped here and
    // disappears from storage on the next autosave.
    const form: FormState = { ...EMPTY_FORM };
    for (const key of DRAFT_FIELDS) {
      const v = parsed.form[key];
      if (typeof v === 'string') (form as unknown as Record<string, string>)[key] = v;
    }
    if (form.shirtSize && !SHIRT_SIZES.includes(form.shirtSize)) form.shirtSize = '';
    const legacyKey = typeof parsed.key === 'string' && UUID_RE.test(parsed.key) ? parsed.key : null;
    return { form, savedAt: parsed.savedAt, legacyKey };
  } catch {
    clearDraft();
    return null;
  }
}

export function saveDraft(form: FormState): void {
  try {
    const picked = {} as Record<string, string>;
    let any = false;
    for (const key of DRAFT_FIELDS) {
      picked[key] = form[key];
      if (form[key].trim()) any = true;
    }
    if (!any) return clearDraft();
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), form: picked }));
  } catch {
    /* storage full or blocked: the form still works, it just won't survive a refresh */
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

export function loadReceipt(): { id: string; source: ApiSource } | null {
  try {
    const raw = sessionStorage.getItem(RECEIPT_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as { id?: unknown; source?: unknown };
    if (typeof r.id !== 'string' || !/^CC25-[A-Z0-9]+$/i.test(r.id)) return null;
    return { id: r.id, source: r.source === 'MOCK FALLBACK' ? 'MOCK FALLBACK' : 'LIVE GO API' };
  } catch {
    return null;
  }
}

/** After the applicant withdraws: the receipt no longer describes a live application. */
export function clearReceipt(): void {
  try {
    sessionStorage.removeItem(RECEIPT_KEY);
  } catch {
    /* ignore */
  }
}

export function saveReceipt(id: string, source: ApiSource): void {
  try {
    sessionStorage.setItem(RECEIPT_KEY, JSON.stringify({ id, source }));
  } catch {
    /* ignore */
  }
}
