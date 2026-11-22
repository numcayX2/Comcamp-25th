/**
 * ComCamp #25 - API Client & Server Time Synchronization
 * Aligns client countdown with authentic server time to prevent clock tampering.
 */
import { fetchSharedPublicSettings } from './public-settings-cache.ts';
import { CAMP_FEE, MAX_CAPACITY, REGISTRATION_CLOSE_AT, REGISTRATION_OPEN_AT } from './camp-facts.ts';

export interface PublicSettings {
  serverTime: string;
  registrationOpenAt: string;
  registrationCloseAt?: string;
  isOpen: boolean;
  currentCount?: number;
  maxCapacity?: number;
  campFee?: number | string | null;
  isCertificateReleased?: boolean;
}

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  serverTime: new Date().toISOString(),
  registrationOpenAt: REGISTRATION_OPEN_AT,
  registrationCloseAt: REGISTRATION_CLOSE_AT,
  isOpen: false,
  currentCount: 0,
  maxCapacity: MAX_CAPACITY,
  campFee: CAMP_FEE,
  isCertificateReleased: false,
};

let cachedOffsetMs: number = 0;
let isSynced: boolean = false;

/**
 * Fetch public settings from backend API (/api/settings/public).
 * Smoothly falls back to realistic default specifications if backend is offline.
 */
export async function fetchPublicSettings(
  options: { fresh?: boolean } = {},
): Promise<{ settings: PublicSettings; offsetMs: number; live: boolean }> {
  try {
    const data: PublicSettings = await fetchSharedPublicSettings(API_BASE, {
      forceFresh: Boolean(options.fresh),
      timeoutMs: 3500,
    });
    const serverEpoch = new Date(data.serverTime).getTime();
    const clientEpoch = Date.now();
    const offsetMs = serverEpoch - clientEpoch;

    cachedOffsetMs = offsetMs;
    isSynced = true;

    return { settings: data, offsetMs, live: true };
  } catch (error) {
    // Graceful offline fallback
    const clientEpoch = Date.now();
    const fallbackSettings: PublicSettings = {
      ...DEFAULT_PUBLIC_SETTINGS,
      serverTime: new Date().toISOString(),
    };
    cachedOffsetMs = 0;
    isSynced = true;

    // `live: false` lets callers tell "server says closed" apart from "server unreachable".
    return { settings: fallbackSettings, offsetMs: 0, live: false };
  }
}

/**
 * Returns current timestamp corrected by verified server time offset.
 */
export function getSynchronizedServerDate(offsetMs: number = cachedOffsetMs): Date {
  return new Date(Date.now() + offsetMs);
}

/* ============================================================
   ComCamp #25 — Full-Stack Skeleton API (Go backend end-to-end)
   Base URL: PUBLIC_API_URL or http://localhost:8000/api
   ============================================================ */

export const API_BASE: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_API_URL) ||
  'http://localhost:8000/api';

/** Where the response came from. Always rendered in UI for backend debugging. */
export type ApiSource = 'LIVE GO API' | 'MOCK FALLBACK';

export interface ApiResult<T> {
  data: T;
  source: ApiSource;
}

/**
 * First come, first served: a new application starts as PASSED (the seat is theirs at once).
 * REJECTED, REFUND_PENDING, REFUNDED and FORFEITED release the seat (they are not counted in the
 * quota) but stay in the staff ledger for accounting. FORFEITED is the automatic cut after the
 * payment window ran out; that phone/email cannot apply again (409 FORFEITED_APPLICATION) until
 * staff restore the application.
 */
export type ApplicationStatus =
  | 'PENDING'
  | 'PASSED'
  | 'RESERVE'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'FORFEITED';

/** Statuses that hold a seat. Mirrors the backend ApplicationStatus.IsActive. */
export function holdsSeat(status: ApplicationStatus): boolean {
  return status === 'PENDING' || status === 'PASSED' || status === 'RESERVE' || status === 'CONFIRMED';
}

/** Official IDO IDEA shirt sizes (strictly synced with register/model.ts & ErrInvalidShirtSize; backend keeps 'XS' only for legacy DB rows). */
export type ShirtSize = 'SSS' | 'SS' | 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL' | '4XL';

/**
 * "Where did you hear about the camp" answers, in form order. Mirrors backend referralCodes
 * (service/referral.go): an unknown code is a 400, `other` needs `referralOther` (≤ 50 characters).
 */
export const REFERRAL_CODES = [
  'social_facebook',
  'social_instagram',
  'social_tiktok',
  'google',
  'website',
  'word_friend',
  'word_senior',
  'word_junior',
  'word_teacher',
  'parent',
  'last_year',
  'other',
] as const;

export type ReferralCode = (typeof REFERRAL_CODES)[number];

/**
 * The question as the form shows it (upgrade decision §2.3). A group with sub-options reveals them
 * when ticked and needs at least one; a single-option group stores its own code. Order = form order
 * = the order the backend sorts the stored codes into.
 */
export interface ReferralGroup {
  id: string;
  label: string;
  options: { code: ReferralCode; label: string }[];
}

export const REFERRAL_GROUPS: ReferralGroup[] = [
  {
    id: 'social',
    label: 'โซเชียลมีเดีย',
    options: [
      { code: 'social_facebook', label: 'Facebook' },
      { code: 'social_instagram', label: 'Instagram' },
      { code: 'social_tiktok', label: 'TikTok' },
    ],
  },
  { id: 'google', label: 'ค้นหาใน Google', options: [{ code: 'google', label: 'ค้นหาใน Google' }] },
  { id: 'website', label: 'เข้าเว็บไซต์โดยตรง', options: [{ code: 'website', label: 'เข้าเว็บไซต์โดยตรง' }] },
  {
    id: 'word',
    label: 'คนรู้จักบอกต่อ',
    options: [
      { code: 'word_friend', label: 'เพื่อน' },
      { code: 'word_senior', label: 'รุ่นพี่' },
      { code: 'word_junior', label: 'รุ่นน้อง' },
      { code: 'word_teacher', label: 'ครู/อาจารย์' },
    ],
  },
  { id: 'parent', label: 'ผู้ปกครองแนะนำ', options: [{ code: 'parent', label: 'ผู้ปกครองแนะนำ' }] },
  { id: 'last_year', label: 'ค่ายปีที่แล้ว', options: [{ code: 'last_year', label: 'ค่ายปีที่แล้ว' }] },
  { id: 'other', label: 'อื่นๆ', options: [{ code: 'other', label: 'อื่นๆ' }] },
];

/** Stand-alone label of one stored code (admin detail, CSV): "คนรู้จักบอกต่อ · รุ่นพี่", "ค้นหาใน Google". */
export const REFERRAL_LABELS = Object.fromEntries(
  REFERRAL_GROUPS.flatMap((g) =>
    g.options.map((o) => [o.code, g.options.length > 1 ? `${g.label} · ${o.label}` : g.label]),
  ),
) as Record<ReferralCode, string>;

export const REFERRAL_OTHER_MAX = 50;

export function isReferralCode(value: string): value is ReferralCode {
  return (REFERRAL_CODES as readonly string[]).includes(value);
}

export interface ApplicationPayload {
  /** Title before the name (นาย, นางสาว, ...). Stored apart from fullName; never on the public list. */
  prefix?: string;
  fullName: string;
  nickname: string;
  phone: string;
  email: string;
  parentName?: string;
  parentRelation?: string;
  parentPhone?: string;
  school: string;
  grade: string;
  shirtSize: ShirtSize;
  motivation: string;
  allergies?: string;
  medicalConditions?: string;
  province?: string;
  /** At least one is required by the form; the API accepts none so older pages keep working. */
  referralSources?: ReferralCode[];
  /** Required when `referralSources` includes 'other'; dropped otherwise. */
  referralOther?: string;
  /** Cloudflare Turnstile response token (single-use). Verified by the server, never stored. */
  turnstileToken?: string;
}

export type SlipStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * Applicant record matching the Go backend DTO.
 *
 * Public endpoints (code lookup, confirm, submit) return identifiers masked by the server
 * (AGENTS.md §13.5): phone `XXX-XXX-XX78` (last 2 digits only), email `s***@x.com`, and never a slip URL.
 * There is no national ID anywhere any more: the application code (CC25-XXXXXX) is the
 * applicant's proof. Only /admin endpoints return full values and `slipUrl`, which is an
 * authenticated API path — load it with fetchAdminSlip, not an <img src>.
 */
export interface ApplicantRecord {
  id: string;
  /** 'code' on a public lookup by application code; absent elsewhere. */
  lookup?: 'code';
  /** Admin responses only; the public and masked views never carry it. */
  prefix?: string;
  fullName: string;
  nickname?: string;
  phone: string;
  email?: string;
  parentName?: string;
  parentRelation?: string;
  parentPhone?: string;
  school: string;
  grade: string;
  shirtSize: ShirtSize;
  motivation?: string;
  allergies?: string;
  medicalConditions?: string;
  province?: string;
  /** Admin responses only. */
  referralSources?: string[];
  referralOther?: string;
  status: ApplicationStatus;
  attendanceConfirmed: boolean;
  hasSlip?: boolean;
  slipStatus?: SlipStatus | null;
  slipUrl?: string | null;
  /**
   * Admin only: id of the latest slip. Sent back with the verdict (verifyPaymentSlip) so a slip the
   * applicant replaced while staff were looking at the old one is not approved by mistake.
   */
  slipPaymentId?: string | null;
  /** Admin only: persisted slip review note, rejection reason, and verification timestamp from the latest slip row. */
  adminNote?: string | null;
  rejectionReason?: string | null;
  verifiedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export type Application = ApplicantRecord;

/**
 * GET /applications/status?q=<phone> answer. It never carries the application code (no `id`,
 * nothing derived from it): a phone number is easy to know, so it only shows a short masked
 * status. Every write action (slip, confirm, withdraw) needs the code, which the applicant got
 * on the receipt and in the email (`codeRequired`).
 */
export interface PhoneLookupResult {
  lookup: 'phone';
  codeRequired: boolean;
  /** Masked, e.g. "ส*** ใ***". */
  fullName: string;
  phone: string;
  email?: string;
  status: ApplicationStatus;
  hasSlip: boolean;
  slipStatus?: SlipStatus | null;
  createdAt: string;
  updatedAt?: string;
}

export type StatusLookupResult = Application | PhoneLookupResult;

/** True for the phone-shaped answer, which must never enable a write action. */
export function isPhoneLookup(r: StatusLookupResult | null | undefined): r is PhoneLookupResult {
  return !!r && (r as PhoneLookupResult).lookup === 'phone';
}

export interface SlipUploadResult {
  id: string;
  status: string;
  hasSlip: boolean;
  slipStatus: SlipStatus;
  message: string;
}

export interface VerifySlipResponse {
  message: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  time: string;
}

/** Admin roles (backend domain.AdminRole). */
export type AdminRole = 'admin';

export interface AdminInfo {
  role: AdminRole;
}

export function isAdminRole(role: string | null | undefined): role is AdminRole {
  return role === 'admin';
}

export interface LoginResponse {
  token: string;
  /**
   * The account's role, so the dashboard can verify UI state. Only a UI hint: the server
   * re-reads the role from the database on every /api/admin request and answers 403 FORBIDDEN.
   */
  role?: AdminRole | string;
}

/** What an admin role may do in the dashboard. */
export interface AdminPermissions {
  changeStatus: boolean;
  editProfile: boolean;
  deleteApplication: boolean;
  viewSlip: boolean;
  verifySlip: boolean;
  editSettings: boolean;
  /**
   * The CSV export: admin only, matching POST /admin/applications/export-audit.
   * Every export is recorded in audit_logs before the file is built.
   */
  exportCsv: boolean;
}

/**
 * Mirrors the route permissions in backend/internal/server/router.go. The server is the only
 * check that counts; fails closed when role is not `'admin'`.
 */
export function adminPermissions(role: string | null | undefined): AdminPermissions {
  const isAdmin = role === 'admin';
  return {
    changeStatus: isAdmin,
    editProfile: isAdmin,
    deleteApplication: isAdmin,
    viewSlip: isAdmin,
    verifySlip: isAdmin,
    editSettings: isAdmin,
    exportCsv: isAdmin,
  };
}

/**
 * The `role` claim of a JWT, read without verifying the signature: a display hint for a token
 * restored from sessionStorage after a refresh. null when the token has no readable payload.
 */
export function roleFromToken(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

export interface LoginResult {
  token: string;
}

/* ── Input cleaning (AGENTS.md §9.2.2) ─────────────────────────────────────
   IDs and phone numbers copied from a LINE / Facebook chat carry invisible characters
   (U+200B–U+200D zero-width space/joiners, U+2060 word joiner, U+FEFF BOM) and are often written
   with hyphens ("081-234-5678"). The Go backend strips the same characters; cleaning here as well
   keeps the client-side validation and the payload in agreement. */

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/** Converts Thai numerals (๐-๙) to ASCII digits (0-9). */
export function normalizeThaiDigits(value: string): string {
  return value.replace(/[๐-๙]/g, (c) => String(THAI_DIGITS.indexOf(c)));
}

/** Removes zero-width characters only. */
export function stripZeroWidth(value: string): string {
  return value.replace(ZERO_WIDTH_RE, '');
}

/** Phone as the API expects it: digits only (normalises Thai digits, drops zero-width chars, hyphens, spaces). */
export function sanitizeDigits(value: string): string {
  return normalizeThaiDigits(value).replace(/\D/g, '');
}

/**
 * Status lookup query: a phone written with Thai numerals or hyphens/spaces becomes ASCII digits
 * only; anything else is treated as an application code (CC25-XXXXXX), whose own hyphen is kept
 * (a missing hyphen, a space or a Unicode dash between CC25 and the hex all become '-').
 */
export function normalizeLookupQuery(raw: string): string {
  const q = normalizeThaiDigits(stripZeroWidth(raw)).trim();
  const digits = q.replace(/[\s\-\u2010-\u2015\u2212]/g, '');
  if (/^\d+$/.test(digits)) return digits;
  const up = q.toUpperCase().replace(/\s+/g, '');
  // Same leniency as the backend normalizeAppNo: CC25 1A2B3C, cc251a2b3c and a Unicode dash all
  // become the canonical CC25-1A2B3C.
  const m = /^CC25[-\u2010-\u2015\u2212]?([0-9A-F]{6})$/.exec(up);
  return m ? `CC25-${m[1]}` : up.replace(/[\u2010-\u2015\u2212]/g, '-');
}

/** A 10-digit Thai mobile number starting with 0 (what the server accepts as a phone lookup). */
export function isPhoneQuery(q: string): boolean {
  return /^0\d{9}$/.test(q);
}

/** CC25-XXXXXX after normalizeLookupQuery. */
export function isApplicationCodeQuery(q: string): boolean {
  return /^CC25-[0-9A-F]{6}$/.test(q);
}

/** Whether the applicant has uploaded a payment slip. */
export function hasSlip(app?: Partial<ApplicantRecord> | null): boolean {
  if (!app) return false;
  return Boolean(app.hasSlip ?? app.slipUrl);
}

/** The server answered with a non-2xx status. Anything else thrown by fetchJson is a network/timeout failure. */
export class ApiHttpError extends Error {
  readonly status: number;
  /** Machine-readable code from the backend, e.g. QUOTA_FULL, DUPLICATE_APPLICATION, RATE_LIMITED. */
  readonly code?: string;
  /** Seconds from the Retry-After header (429 / 503), when the server sent a number. */
  readonly retryAfterSeconds?: number;
  constructor(status: number, message: string, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Retry-After as whole seconds. An HTTP-date form is ignored (the backend sends seconds). */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function toApiError(res: Response): Promise<ApiHttpError> {
  const errData = await res.json().catch(() => null);
  const errMsg = errData?.error || `HTTP ${res.status} ${res.statusText}`;
  return new ApiHttpError(
    res.status,
    errMsg,
    typeof errData?.code === 'string' ? errData.code : undefined,
    parseRetryAfter(res.headers.get('Retry-After')),
  );
}

/** multipart POST through XMLHttpRequest, the only way to report upload progress. */
function xhrUpload<T>(
  url: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
  timeoutMs = 20000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Accept', 'application/json');
    if (onProgress) {
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && ev.total > 0) onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
      };
    }
    // Network failure and timeout are plain Errors (not ApiHttpError), like a failed fetch.
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      const errData = (body ?? {}) as { error?: string; code?: string };
      reject(
        new ApiHttpError(
          xhr.status,
          errData.error || `HTTP ${xhr.status} ${xhr.statusText}`,
          typeof errData.code === 'string' ? errData.code : undefined,
          parseRetryAfter(xhr.getResponseHeader('Retry-After')),
        ),
      );
    };
    xhr.send(formData);
  });
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Runs the live call; falls back to mock data only in `astro dev` and only when the server could
 * not be reached at all. An HTTP error (401 wrong password, 409, 403 …) is always re-thrown:
 * a mock answer there would, for example, tell staff a slip was approved when the server
 * refused, or show a student a made-up status (AGENTS.md §8 "never guess the state").
 */
async function withFallback<T>(live: () => Promise<T>, mock: () => T): Promise<ApiResult<T>> {
  try {
    const data = await live();
    return { data, source: 'LIVE GO API' };
  } catch (err) {
    if (import.meta.env.DEV && !(err instanceof ApiHttpError)) {
      return { data: mock(), source: 'MOCK FALLBACK' };
    }
    throw err;
  }
}

function mockId(): string {
  return `CC25-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** GET /health */
export function checkHealth(): Promise<ApiResult<HealthResponse>> {
  return withFallback(
    () => fetchJson<HealthResponse>('/health'),
    () => ({
      status: 'mock-offline',
      service: 'comcamp25-backend',
      time: new Date().toISOString(),
    }),
  );
}

/**
 * POST /applications
 *
 * `idempotencyKey` (a UUID kept in sessionStorage until a successful response) is sent as
 * X-Idempotency-Key, so resending after a dropped connection, a timeout or a 5xx returns the
 * application that was already saved instead of creating a duplicate (AGENTS.md §9.2.4 / §13.4).
 * The server answers 201 the first time and 200 + Idempotent-Replayed for a replay.
 *
 * Unlike the other calls this never masks a real failure in production: a mock receipt would
 * tell a student they applied when nothing was saved. The offline mock is a dev-only convenience
 * and only kicks in when the server could not be reached at all — an HTTP error is always thrown.
 */
export async function submitApplication(
  payload: ApplicationPayload,
  idempotencyKey: string,
): Promise<ApiResult<Application>> {
  try {
    const data = await fetchJson<Application>('/applications', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    return { data, source: 'LIVE GO API' };
  } catch (err) {
    if (import.meta.env.DEV && !(err instanceof ApiHttpError)) {
      // The token is a transport detail: it must not end up in the mock application record.
      const { turnstileToken: _token, ...fields } = payload;
      return {
        data: {
          id: mockId(),
          ...fields,
          status: 'PASSED' as ApplicationStatus,
          attendanceConfirmed: false,
          hasSlip: false,
          createdAt: new Date().toISOString(),
        },
        source: 'MOCK FALLBACK',
      };
    }
    throw err;
  }
}

/**
 * GET /applications/status?q=... — by application code the full masked record (`lookup: 'code'`,
 * with `id`); by phone a PhoneLookupResult that never contains the code. Anything else is
 * 400 VALIDATION_ERROR. Unknown codes count against a per-client and a global miss budget:
 * 429 RATE_LIMITED + Retry-After when it is used up.
 */
export function getApplicationStatus(query: string): Promise<ApiResult<StatusLookupResult>> {
  const q = encodeURIComponent(query);
  return withFallback<StatusLookupResult>(
    () => fetchJson<StatusLookupResult>(`/applications/status?q=${q}`),
    // Dev-only offline mock: shaped like the real answer, so a phone query has NO code in it.
    () =>
      !query.toUpperCase().startsWith('CC25')
        ? {
            lookup: 'phone',
            codeRequired: true,
            fullName: 'ส*** ส***',
            phone: 'XXX-XXX-XX43',
            email: 's***@school.ac.th',
            status: 'PASSED' as ApplicationStatus,
            hasSlip: false,
            createdAt: new Date().toISOString(),
          }
        : {
            id: query.toUpperCase(),
            lookup: 'code',
            fullName: 'ส*** ส***',
            nickname: 'เกียรติ',
            phone: 'XXX-XXX-XX43',
            email: 's***@school.ac.th',
            school: 'โรงเรียนแม่โจ้วิทยาคม',
            grade: 'ม.5',
            shirtSize: 'XL',
            province: 'เชียงใหม่',
            status: 'PASSED' as ApplicationStatus,
            attendanceConfirmed: false,
            hasSlip: false,
            createdAt: new Date().toISOString(),
          }
  );
}

/**
 * POST /api/applications/:id/withdraw — the applicant cancels their own application. The code in
 * the path plus the full registered phone are the proof (body `{ phone, reason? }`, owner ruling
 * R24). The server soft-deletes the row, which frees the seat and lets the same person register
 * again. An unknown code and a missing/wrong phone get the SAME 404 (the UI must not say which part
 * was wrong); 429 RATE_LIMITED + Retry-After after too many misses; 409 when the application cannot
 * be cancelled online (CONFIRMED, a slip already sent or approved, or already REJECTED /
 * REFUND_PENDING / REFUNDED: staff handle the refund). No offline fallback: this is a real mutation.
 * The phone is held by the caller in component state only, never in browser storage.
 */
export async function withdrawApplication(
  id: string,
  phone: string,
  reason?: string,
): Promise<ApiResult<{ message: string; id: string }>> {
  const data = await fetchJson<{ message: string; id: string }>(`/applications/${encodeURIComponent(id)}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ phone: sanitizeDigits(phone), reason: reason || 'ผู้สมัครขอยกเลิกด้วยตนเอง' }),
  });
  return { data, source: 'LIVE GO API' };
}

/**
 * POST /applications/:id/confirm — body { confirmed }. The application code in the path is the
 * proof; unknown codes count against the miss budget (404, then 429 RATE_LIMITED + Retry-After).
 */
export function confirmAttendance(id: string, confirmed: boolean): Promise<ApiResult<Application>> {
  return withFallback(
    () =>
      fetchJson<Application>(`/applications/${encodeURIComponent(id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmed }),
      }),
    () => ({
      id,
      fullName: 'ส*** ส***',
      nickname: 'เกียรติ',
      phone: 'XXX-XXX-XX43',
      email: 's***@school.ac.th',
      school: 'โรงเรียนแม่โจ้วิทยาคม',
      grade: 'ม.5',
      shirtSize: 'XL',
      province: 'เชียงใหม่',
      status: (confirmed ? 'CONFIRMED' : 'PASSED') as ApplicationStatus,
      attendanceConfirmed: confirmed,
      hasSlip: false,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * POST /applications/:id/slip
 * Uploads a payment slip image (multipart/form-data: 'slip'). The application code in the path is
 * the proof (404 unknown code, 429 RATE_LIMITED + Retry-After after too many unknown codes). The
 * server checks the magic bytes and caps the image at 4096×4096 px (400 INVALID_IMAGE_DIMENSIONS).
 */
export function uploadPaymentSlip(
  id: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<ApiResult<SlipUploadResult>> {
  const formData = new FormData();
  formData.append('slip', file);

  return withFallback(
    () => xhrUpload<SlipUploadResult>(`${API_BASE}/applications/${encodeURIComponent(id)}/slip`, formData, onProgress),
    () => ({
      id,
      status: 'PASSED',
      hasSlip: true,
      slipStatus: 'PENDING' as SlipStatus,
      message: 'อัปโหลดสลิปสำเร็จ รอดำเนินการตรวจสอบโดยเจ้าหน้าที่ (Mock Mode)',
    }),
  );
}

/** Staff edit: any field may be sent; fields left out keep their stored value. */
export interface AdminProfilePayload {
  fullName?: string;
  nickname?: string;
  phone?: string;
  email?: string;
  parentName?: string;
  parentRelation?: string;
  parentPhone?: string;
  school?: string;
  province?: string;
  grade?: string;
  shirtSize?: ShirtSize;
  motivation?: string;
  allergies?: string;
  medicalConditions?: string;
  /** Replaces the whole list when sent. */
  referralSources?: ReferralCode[];
  referralOther?: string;
  reason?: string;
}

/**
 * PATCH /admin/applications/:id/profile — full validation server-side (phone, email, shirt size,
 * lengths). 409 DUPLICATE_APPLICATION when the phone or email belongs to another live applicant. Every change is written to audit_logs with old -> new values.
 */
export async function updateApplicantProfile(
  token: string,
  id: string,
  payload: AdminProfilePayload,
): Promise<ApiResult<Application>> {
  const data = await fetchJson<Application>(`/admin/applications/${encodeURIComponent(id)}/profile`, {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify(payload),
  });
  return { data, source: 'LIVE GO API' };
}

/** POST /auth/login */
export function adminLogin(username: string, password: string): Promise<ApiResult<LoginResponse>> {
  return withFallback(
    () =>
      fetchJson<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    () => ({ token: 'mock-jwt-token', role: 'admin' }),
  );
}

/* ── Admin settings (GET/PATCH /api/admin/settings) ─────────────────────── */

/** Staff view of the camp settings. `campFee` is a decimal string from the Go backend (e.g. "1200"). */
export interface AdminSettings {
  id: number;
  campName: string;
  registrationOpenAt: string;
  registrationCloseAt: string;
  announcementAt?: string;
  paymentOpenAt?: string;
  paymentDeadline?: string;
  certificateReleaseAt?: string;
  maxCapacity: number;
  campFee: string | number;
  isManualClosed: boolean;
  updatedByAdminId?: number;
  updatedAt?: string;
  isCertificateReleased?: boolean;
  currentCount?: number;
}

/** Partial update, mirroring the Go `UpdateSettingsRequest`. Omitted fields are left unchanged. */
export interface UpdateAdminSettingsPayload {
  campName?: string;
  maxCapacity?: number;
  campFee?: number;
  isManualClosed?: boolean;
  registrationOpenAt?: string;
  registrationCloseAt?: string;
  announcementAt?: string;
  paymentOpenAt?: string;
  paymentDeadline?: string;
  certificateReleaseAt?: string;
}

/** Offline-dev stand-in only, used when the server cannot be reached under `astro dev`. */
const MOCK_ADMIN_SETTINGS: AdminSettings = {
  id: 1,
  campName: 'ComCamp #25 (Mock)',
  registrationOpenAt: REGISTRATION_OPEN_AT,
  registrationCloseAt: REGISTRATION_CLOSE_AT,
  maxCapacity: MAX_CAPACITY,
  campFee: CAMP_FEE,
  isManualClosed: false,
  updatedAt: new Date().toISOString(),
};

/** GET /admin/settings */
export function fetchAdminSettings(token: string): Promise<ApiResult<AdminSettings>> {
  return withFallback(
    () => fetchJson<AdminSettings>('/admin/settings', { headers: authHeader(token) }),
    () => MOCK_ADMIN_SETTINGS,
  );
}

/**
 * PATCH /admin/settings. The server checks the quota (1–1000, and not below the current applicant
 * count, 400) and the fee range, and writes an audit entry for every change.
 */
export async function updateAdminSettings(
  token: string,
  payload: UpdateAdminSettingsPayload,
): Promise<ApiResult<AdminSettings>> {
  const data = await fetchJson<AdminSettings>('/admin/settings', {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify(payload),
  });
  return { data, source: 'LIVE GO API' };
}

const MOCK_SLIP_PAYMENT_IDS: Record<string, string> = {
  'CC25-9A8B1C': '11111111-1111-4111-8111-111111111111',
  'CC25-4D5E6F': '22222222-2222-4222-8222-222222222222',
};

/** GET /admin/applications */
export function listApplications(
  token: string,
  statusFilter?: ApplicationStatus,
): Promise<ApiResult<Application[]>> {
  const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
  return withFallback(
    () => fetchJson<Application[]>(`/admin/applications${qs}`, { headers: authHeader(token) }),
    () => [
      {
        id: 'CC25-9A8B1C',
        fullName: 'สมเกียรติ สุขสมบูรณ์',
        nickname: 'เกียรติ',
        phone: '0819876543',
        email: 'somkiat@school.ac.th',
        parentName: 'สมชาย สุขสมบูรณ์',
        parentRelation: 'บิดา',
        parentPhone: '0811112233',
        school: 'โรงเรียนแม่โจ้วิทยาคม',
        grade: 'ม.5',
        shirtSize: 'XL',
        motivation: 'อยากเรียนรู้การต่อวงจรเซนเซอร์และบอร์ด ESP8266 ทำ AI Dashboard',
        allergies: 'แพ้กุ้ง',
        medicalConditions: '',
        province: 'เชียงใหม่',
        status: 'PASSED' as ApplicationStatus,
        attendanceConfirmed: false,
        hasSlip: true,
        slipStatus: 'PENDING' as SlipStatus,
        slipUrl: '/api/admin/applications/CC25-9A8B1C/slip',
        slipPaymentId: MOCK_SLIP_PAYMENT_IDS['CC25-9A8B1C'],
        createdAt: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: 'CC25-4D5E6F',
        fullName: 'กัญญาภัทร สิริวัฒน์',
        nickname: 'ฟ้า',
        phone: '0891234567',
        email: 'kanya@school.ac.th',
        parentName: 'กัญญา สิริวัฒน์',
        parentRelation: 'มารดา',
        parentPhone: '0892223344',
        school: 'โรงเรียนยุพราชวิทยาลัย',
        grade: 'ม.6',
        shirtSize: 'M',
        motivation: 'สนใจศึกษาด้าน AI Image Processing และ Computer Vision',
        province: 'เชียงใหม่',
        status: 'CONFIRMED' as ApplicationStatus,
        attendanceConfirmed: true,
        hasSlip: true,
        slipStatus: 'APPROVED' as SlipStatus,
        slipUrl: '/api/admin/applications/CC25-4D5E6F/slip',
        slipPaymentId: MOCK_SLIP_PAYMENT_IDS['CC25-4D5E6F'],
        adminNote: 'ยอดเงิน 1,200 บาท ถูกต้องครบถ้วน',
        verifiedAt: new Date(Date.now() - 86400000).toISOString(),
        createdAt: new Date(Date.now() - 172800000).toISOString(),
      },
      {
        id: 'CC25-112233',
        fullName: 'ธีรเดช เจริญผล',
        nickname: 'บอย',
        phone: '0845556677',
        email: 'teeradej@school.ac.th',
        parentName: 'มานะ เจริญผล',
        parentRelation: 'บิดา',
        parentPhone: '0843334455',
        school: 'โรงเรียนเชียงใหม่คริสเตียน',
        grade: 'ม.4',
        shirtSize: 'L',
        motivation: 'อยากเริ่มต้นเรียนเขียนโปรแกรมภาษา Go และสร้าง Web App',
        province: 'เชียงใหม่',
        status: 'PASSED' as ApplicationStatus,
        attendanceConfirmed: false,
        hasSlip: false,
        createdAt: new Date(Date.now() - 259200000).toISOString(),
      },
    ],
  );
}

/**
 * POST /admin/applications/export-audit — records a CSV export (application.export.csv in
 * audit_logs) before the dashboard builds the file. The search text is not sent: staff search by
 * phone number, application code or name; only whether a search narrowed the list.
 */
export function recordCsvExport(
  token: string,
  body: { applicationIds: string[]; statusFilter?: ApplicationStatus; searchFiltered: boolean },
): Promise<ApiResult<{ count: number }>> {
  return withFallback(
    () =>
      fetchJson<{ count: number }>('/admin/applications/export-audit', {
        method: 'POST',
        headers: authHeader(token),
        body: JSON.stringify(body),
      }),
    () => ({ count: body.applicationIds.length }),
  );
}

/** One application the applicant withdrew themselves (read-only staff list). */
export interface WithdrawnApplicant {
  id: string;
  fullName: string;
  nickname: string;
  phone: string;
  school: string;
  province: string;
  /** Status the application had when it was withdrawn. */
  status: ApplicationStatus;
  createdAt: string;
  withdrawnAt: string;
  /** What the applicant typed when withdrawing; may be empty. */
  reason: string;
}

/**
 * GET /admin/applications/withdrawn — applications the applicant withdrew (newest first). Admin
 * deletions are not included. No offline fallback beyond an empty list in `astro dev`.
 */
export function fetchWithdrawnApplicants(token: string): Promise<ApiResult<WithdrawnApplicant[]>> {
  return withFallback(
    async () => {
      const data = await fetchJson<WithdrawnApplicant[] | null>('/admin/applications/withdrawn', {
        headers: authHeader(token),
      });
      return Array.isArray(data) ? data : [];
    },
    () => [],
  );
}

/** PATCH /admin/applications/:id — body { status: "...", reason: "..." } */
export async function updateApplicationStatus(
  token: string,
  id: string,
  status: ApplicationStatus,
  reason?: string,
  /** Take the seat back even when the quota is full (reason required; audited). */
  overCapacity = false,
): Promise<ApiResult<Application>> {
  const data = await fetchJson<Application>(`/admin/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify(overCapacity ? { status, reason, overCapacity: true } : { status, reason }),
  });
  return { data, source: 'LIVE GO API' };
}

const SLIP_PAYMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /admin/applications/:id/verify-slip
 * Verifies or rejects the payment slip of an applicant.
 * Body: { approved: boolean, note: string, paymentId: string }
 *
 * paymentId is required (UUID from `X-Slip-Payment-Id` or matching `slipPaymentId`) and pins the
 * verdict to the slip on screen. If the applicant uploaded a newer slip meanwhile, the server
 * answers 409 SLIP_CHANGED and changes nothing.
 */
export async function verifyPaymentSlip(
  token: string,
  id: string,
  approved: boolean,
  note: string = '',
  paymentId: string,
): Promise<ApiResult<VerifySlipResponse>> {
  const normalizedPaymentId = (paymentId ?? '').trim();
  if (!SLIP_PAYMENT_UUID_RE.test(normalizedPaymentId)) {
    throw new ApiHttpError(400, 'paymentId is required and must be a valid UUID', 'VALIDATION_ERROR');
  }
  const data = await fetchJson<VerifySlipResponse>(`/admin/applications/${encodeURIComponent(id)}/verify-slip`, {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify({
      approved,
      note: note || (approved ? 'ยอดเงินถูกต้องครบถ้วน' : 'สลิปไม่ถูกต้อง'),
      paymentId: normalizedPaymentId,
    }),
  });
  return { data, source: 'LIVE GO API' };
}

export interface AdminSlipInfo {
  url: string;
  /** Value of `X-Slip-Payment-Id` returned by the server, used to pin slip verification to this exact image. */
  paymentId: string | null;
}

/** Dev-only mock slip image blob when the Go backend is unreachable under `astro dev`. */
function createMockSlipInfo(id: string): AdminSlipInfo {
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '');
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="540" height="720" viewBox="0 0 540 720">',
    '<rect width="540" height="720" fill="#F9F8F4"/>',
    '<rect x="28" y="28" width="484" height="664" rx="16" fill="#FFFFFF" stroke="#1E1F24" stroke-width="2"/>',
    '<text x="270" y="92" text-anchor="middle" font-family="monospace" font-size="22" font-weight="700" fill="#1E1F24">MOCK PAYMENT SLIP (DEV)</text>',
    `<text x="270" y="142" text-anchor="middle" font-family="monospace" font-size="18" fill="#4B5563">REF: ${safeId}</text>`,
    '<line x1="64" y1="180" x2="476" y2="180" stroke="#D1D5DB" stroke-width="1.5"/>',
    '<text x="270" y="260" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#4B5563">Bangkok Bank · ComCamp #25</text>',
    '<text x="270" y="328" text-anchor="middle" font-family="monospace" font-size="40" font-weight="700" fill="#047857">1,200.00 THB</text>',
    '<text x="270" y="388" text-anchor="middle" font-family="monospace" font-size="16" fill="#6B7280">587-0-84106-0</text>',
    '<text x="270" y="640" text-anchor="middle" font-family="monospace" font-size="14" fill="#9CA3AF">OFFLINE MOCK FALLBACK</text>',
    '</svg>',
  ].join('');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  return {
    url,
    paymentId: MOCK_SLIP_PAYMENT_IDS[id] ?? '00000000-0000-4000-8000-000000000000',
  };
}

/**
 * GET /admin/applications/:id/slip — returns both the object URL and the `X-Slip-Payment-Id`
 * response header so `verifyPaymentSlip` can guard against concurrent re-uploads (409 SLIP_CHANGED).
 * The caller must URL.revokeObjectURL(info.url) when done.
 */
export async function fetchAdminSlipInfo(token: string, id: string): Promise<AdminSlipInfo> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}/slip`, {
      headers: authHeader(token),
      signal: controller.signal,
    });
    if (!res.ok) throw await toApiError(res);
    const rawPid = res.headers.get('X-Slip-Payment-Id')?.trim();
    const url = URL.createObjectURL(await res.blob());
    return { url, paymentId: rawPid || null };
  } catch (err) {
    if (import.meta.env.DEV && !(err instanceof ApiHttpError)) {
      return createMockSlipInfo(id);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * GET /admin/applications/:id/slip — the slip image is only served to an authenticated admin
 * (AGENTS.md §13.3/§13.5), so it cannot be an <img src>. Returns an object URL for the image;
 * the caller must URL.revokeObjectURL it when done.
 */
export async function fetchAdminSlip(token: string, id: string): Promise<string> {
  const { url } = await fetchAdminSlipInfo(token, id);
  return url;
}

/** DELETE /admin/applications/:id — soft-deletes the applicant and writes an audit log */
export async function deleteApplication(
  token: string,
  id: string,
  reason?: string,
): Promise<ApiResult<{ message: string }>> {
  const data = await fetchJson<{ message: string }>(`/admin/applications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeader(token),
    body: JSON.stringify({ reason: reason || 'ลบโดยผู้ดูแลระบบ' }),
  });
  return { data, source: 'LIVE GO API' };
}

/**
 * DELETE /admin/applications/withdrawn/:id — permanently deletes a self-withdrawn application
 * (row, payments, status history, slip files). Irreversible; 404 for any other application.
 */
export async function purgeWithdrawnApplication(
  token: string,
  id: string,
): Promise<ApiResult<{ message: string; id: string }>> {
  const data = await fetchJson<{ message: string; id: string }>(
    `/admin/applications/withdrawn/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: authHeader(token) },
  );
  return { data, source: 'LIVE GO API' };
}

/* ── Public applicants list (/applicants) ─────────────────────────────────── */

/** Public status labels (Thai), exactly as the server sends them. */
export type PublicApplicantStatus = 'รอชำระเงิน' | 'ยืนยันสิทธิ์แล้ว';

/**
 * One row of GET /applications/public. This is the complete PDPA allowlist the registration
 * consent discloses (name, nickname, school, province) plus order and status. The server never
 * sends the application code, phone, email, parent, health, motivation, slip or any id, and the
 * client must not add them (CLAUDE_REVAMP_HANDOFF.md 5.4).
 */
export interface PublicApplicant {
  no: number;
  fullName: string;
  nickname: string;
  school: string;
  province: string;
  status: PublicApplicantStatus;
}

/** Copies only the allowlisted keys, so an unexpected server field can never reach the UI. */
function pickPublicApplicant(raw: unknown): PublicApplicant | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const status = r.status === 'ยืนยันสิทธิ์แล้ว' ? 'ยืนยันสิทธิ์แล้ว' : r.status === 'รอชำระเงิน' ? 'รอชำระเงิน' : null;
  if (status === null || typeof r.no !== 'number') return null;
  return {
    no: r.no,
    fullName: str(r.fullName),
    nickname: str(r.nickname),
    school: str(r.school),
    province: str(r.province),
    status,
  };
}

/**
 * GET /applications/public — the public applicants list (live PASSED / CONFIRMED applications,
 * oldest first). Before registration opens it is simply empty. The offline mock runs only in
 * `astro dev` when the server cannot be reached; a real 4xx/5xx (e.g. 429 RATE_LIMITED) is always
 * thrown so the page shows its error state instead of made-up names.
 */
export function fetchPublicApplicants(): Promise<ApiResult<PublicApplicant[]>> {
  return withFallback(
    async () => {
      const data = await fetchJson<{ applicants?: unknown }>('/applications/public', { method: 'GET' });
      const list = Array.isArray(data?.applicants) ? data.applicants : [];
      return list.map(pickPublicApplicant).filter((row): row is PublicApplicant => row !== null);
    },
    () => [
      { no: 1, fullName: 'สมเกียรติ สุขสมบูรณ์ (Mock)', nickname: 'เกียรติ', school: 'โรงเรียนแม่โจ้วิทยาคม', province: 'เชียงใหม่', status: 'ยืนยันสิทธิ์แล้ว' },
      { no: 2, fullName: 'สมหญิง ใจดี (Mock)', nickname: 'หญิง', school: 'โรงเรียนสันทรายวิทยาคม', province: 'เชียงใหม่', status: 'รอชำระเงิน' },
      { no: 3, fullName: 'ปิยะ รักเรียน (Mock)', nickname: 'ปิยะ', school: 'โรงเรียนลำพูนวิทยา', province: 'ลำพูน', status: 'รอชำระเงิน' },
    ],
  );
}

/* ── Sponsors ─────────────────────────────────────────────────────────────── */

/** One logo in GET /sponsors. `url` is '' or an absolute http(s) link; `name` is always the alt text. */
export interface Sponsor {
  id: number;
  name: string;
  url: string;
  showName: boolean;
  /** Same-origin `/api/sponsors/:id/logo?v=…` path (prefix with API_BASE origin when cross-origin). */
  logoUrl: string;
}

export interface AdminSponsor extends Sponsor {
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Fields for create/update; `logo` is required on create, optional (= keep) on update. */
export interface SponsorPayload {
  name?: string;
  url?: string;
  showName?: boolean;
  logo?: File | Blob | null;
}

export const SPONSOR_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const SPONSOR_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Only http(s) links ever reach an href; anything else is dropped. */
function safeSponsorUrl(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

function pickSponsor(raw: unknown): Sponsor | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || typeof r.name !== 'string' || typeof r.logoUrl !== 'string') return null;
  // The logo is always served by our API; refuse anything that is not a same-API path.
  if (!/^\/api\/sponsors\/\d+\/logo(\?v=[0-9a-f]+)?$/.test(r.logoUrl)) return null;
  return { id: r.id, name: r.name, url: safeSponsorUrl(r.url), showName: r.showName === true, logoUrl: r.logoUrl };
}

function pickAdminSponsor(raw: unknown): AdminSponsor | null {
  const base = pickSponsor(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  return {
    ...base,
    sortOrder: typeof r.sortOrder === 'number' ? r.sortOrder : 0,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
}

/** Absolute URL for a sponsor logo path, honouring a cross-origin PUBLIC_API_URL in dev. */
export function sponsorLogoSrc(logoUrl: string): string {
  return API_BASE.replace(/\/api\/?$/, '') + logoUrl;
}

/** GET /sponsors — public; an empty list hides the home section. No mock fallback. */
export async function fetchSponsors(): Promise<Sponsor[]> {
  const data = await fetchJson<{ sponsors?: unknown }>('/sponsors', { method: 'GET' });
  const list = Array.isArray(data?.sponsors) ? data.sponsors : [];
  return list.map(pickSponsor).filter((s): s is Sponsor => s !== null);
}

export async function fetchAdminSponsors(token: string): Promise<AdminSponsor[]> {
  const data = await fetchJson<{ sponsors?: unknown }>('/admin/sponsors', { method: 'GET', headers: authHeader(token) });
  const list = Array.isArray(data?.sponsors) ? data.sponsors : [];
  return list.map(pickAdminSponsor).filter((s): s is AdminSponsor => s !== null);
}

async function sponsorMultipart(token: string, path: string, method: 'POST' | 'PATCH', p: SponsorPayload): Promise<AdminSponsor> {
  const form = new FormData();
  if (p.name !== undefined) form.append('name', p.name);
  if (p.url !== undefined) form.append('url', p.url);
  if (p.showName !== undefined) form.append('showName', p.showName ? 'true' : 'false');
  if (p.logo) form.append('logo', p.logo);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    // No Content-Type header: the browser sets the multipart boundary.
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      body: form,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...authHeader(token) },
    });
    if (!res.ok) throw await toApiError(res);
    const s = pickAdminSponsor(await res.json());
    if (!s) throw new Error('invalid sponsor response');
    return s;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** POST /admin/sponsors (multipart). PNG/JPG/WebP ≤ 2 MB; SVG is refused by the server. */
export function createSponsor(token: string, p: SponsorPayload & { name: string; logo: File | Blob }): Promise<AdminSponsor> {
  return sponsorMultipart(token, '/admin/sponsors', 'POST', p);
}

/** PATCH /admin/sponsors/:id (multipart); omitted fields keep their value, a logo replaces the image. */
export function updateSponsor(token: string, id: number, p: SponsorPayload): Promise<AdminSponsor> {
  return sponsorMultipart(token, `/admin/sponsors/${id}`, 'PATCH', p);
}

export async function deleteSponsor(token: string, id: number): Promise<void> {
  await fetchJson<void>(`/admin/sponsors/${id}`, { method: 'DELETE', headers: authHeader(token) });
}

/** PUT /admin/sponsors/order — `ids` must be every sponsor id, in the new order. */
export async function reorderSponsors(token: string, ids: number[]): Promise<AdminSponsor[]> {
  const data = await fetchJson<{ sponsors?: unknown }>('/admin/sponsors/order', {
    method: 'PUT',
    headers: authHeader(token),
    body: JSON.stringify({ ids }),
  });
  const list = Array.isArray(data?.sponsors) ? data.sponsors : [];
  return list.map(pickAdminSponsor).filter((s): s is AdminSponsor => s !== null);
}

/* ── Sponsor inquiries & donations (contract: migration 000015) ──────────────── */

export type SponsorKind = 'money' | 'goods';
export const SPONSOR_KIND_LABELS: Record<SponsorKind, string> = {
  money: 'เงิน (โอน/เงินสด)',
  goods: 'สิ่งของ',
};
export function isSponsorKind(v: unknown): v is SponsorKind {
  return v === 'money' || v === 'goods';
}

export const SPONSOR_NAME_MAX = 120;
export const SPONSOR_DETAILS_MAX = 500;

/** Body of POST /sponsor-inquiries. `website` is the honeypot and must stay empty. */
export interface SponsorInquiryPayload {
  name: string;
  phone: string;
  email: string;
  kind: SponsorKind;
  details: string;
  turnstileToken: string;
  website?: string;
}

/** POST /sponsor-inquiries — public. No mock fallback: a fake success would lose the inquiry. */
export async function submitSponsorInquiry(payload: SponsorInquiryPayload): Promise<void> {
  await fetchJson<{ ok?: boolean }>('/sponsor-inquiries', {
    method: 'POST',
    body: JSON.stringify({ ...payload, website: payload.website ?? '' }),
  });
}

/** Body of POST /sponsor-inquiries/upload besides the file: `kind` defaults to money server-side. */
export type SponsorFormUploadPayload = Pick<
  SponsorInquiryPayload,
  'name' | 'phone' | 'email' | 'details' | 'turnstileToken' | 'website'
>;

/**
 * POST /sponsor-inquiries/upload — public multipart: the filled donation form (PDF/JPG/PNG/WebP
 * ≤ 8 MB) instead of the typed inquiry. XHR for upload progress; 2 min timeout so an 8 MB scan
 * still makes it over a slow mobile uplink. No mock fallback.
 */
export async function submitSponsorFormUpload(
  payload: SponsorFormUploadPayload,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const form = new FormData();
  form.append('name', payload.name);
  form.append('phone', payload.phone);
  form.append('email', payload.email ?? '');
  form.append('details', payload.details ?? '');
  form.append('turnstileToken', payload.turnstileToken);
  form.append('website', payload.website ?? '');
  form.append('file', file, file.name);
  await xhrUpload<{ ok?: boolean }>(`${API_BASE}/sponsor-inquiries/upload`, form, onProgress, 120000);
}

export interface SponsorInquiry {
  id: number;
  name: string;
  phone: string;
  email: string;
  kind: SponsorKind;
  details: string;
  /** The filled donation form the sponsor attached (uploadedAt = createdAt); null when typed. */
  file: SponsorDonationFile | null;
  handled: boolean;
  handledAt: string | null;
  createdAt: string;
}

export type SponsorFileKind = 'signed' | 'slip';
export const SPONSOR_FILE_LABELS: Record<SponsorFileKind, string> = {
  signed: 'ฟอร์มที่เซ็นแล้ว',
  slip: 'สลิปโอน',
};
export const SPONSOR_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const SPONSOR_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;

export interface SponsorDonationFile {
  mime: string;
  size: number;
  uploadedAt: string;
}

export interface SponsorDonation {
  id: number;
  donorName: string;
  address: string;
  phone: string;
  kind: SponsorKind;
  /** Decimal string such as "1200" or "1500.5"; null when not set. */
  amount: string | null;
  goodsDescription: string;
  /** "YYYY-MM-DD" or "". */
  donatedOn: string;
  note: string;
  facultySubmitted: boolean;
  facultySubmittedAt: string | null;
  files: Record<SponsorFileKind, SponsorDonationFile | null>;
  createdAt: string;
  updatedAt: string;
}

/** Body of POST / PATCH /admin/sponsor-donations — PATCH replaces every editable field. */
export interface SponsorDonationInput {
  donorName: string;
  address: string;
  phone: string;
  kind: SponsorKind;
  amount: string | null;
  goodsDescription: string;
  donatedOn: string;
  note: string;
  facultySubmitted: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function pickInquiry(raw: unknown): SponsorInquiry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isSponsorKind(r.kind)) return null;
  return {
    id: r.id,
    name: str(r.name),
    phone: str(r.phone),
    email: str(r.email),
    kind: r.kind,
    details: str(r.details),
    file: pickDonationFile(r.file),
    handled: r.handled === true,
    handledAt: strOrNull(r.handledAt),
    createdAt: str(r.createdAt),
  };
}

function pickDonationFile(raw: unknown): SponsorDonationFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.mime !== 'string') return null;
  return { mime: r.mime, size: typeof r.size === 'number' ? r.size : 0, uploadedAt: str(r.uploadedAt) };
}

function pickDonation(raw: unknown): SponsorDonation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isSponsorKind(r.kind)) return null;
  const files = (r.files && typeof r.files === 'object' ? r.files : {}) as Record<string, unknown>;
  return {
    id: r.id,
    donorName: str(r.donorName),
    address: str(r.address),
    phone: str(r.phone),
    kind: r.kind,
    amount: strOrNull(r.amount),
    goodsDescription: str(r.goodsDescription),
    donatedOn: str(r.donatedOn),
    note: str(r.note),
    facultySubmitted: r.facultySubmitted === true,
    facultySubmittedAt: strOrNull(r.facultySubmittedAt),
    files: { signed: pickDonationFile(files.signed), slip: pickDonationFile(files.slip) },
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

function mustDonation(raw: unknown): SponsorDonation {
  const d = pickDonation(raw);
  if (!d) throw new Error('invalid donation response');
  return d;
}

export async function fetchSponsorInquiries(token: string): Promise<SponsorInquiry[]> {
  const data = await fetchJson<{ inquiries?: unknown }>('/admin/sponsor-inquiries', { method: 'GET', headers: authHeader(token) });
  const list = Array.isArray(data?.inquiries) ? data.inquiries : [];
  return list.map(pickInquiry).filter((x): x is SponsorInquiry => x !== null);
}

export async function setSponsorInquiryHandled(token: string, id: number, handled: boolean): Promise<SponsorInquiry> {
  const data = await fetchJson<unknown>(`/admin/sponsor-inquiries/${id}`, {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify({ handled }),
  });
  const inq = pickInquiry(data);
  if (!inq) throw new Error('invalid inquiry response');
  return inq;
}

export async function deleteSponsorInquiry(token: string, id: number): Promise<void> {
  await fetchJson<void>(`/admin/sponsor-inquiries/${id}`, { method: 'DELETE', headers: authHeader(token) });
}

/** GET the form a sponsor attached as a blob: URL (admin-only, no-store). Revoke it when done. */
export async function fetchSponsorInquiryFile(token: string, id: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API_BASE}/admin/sponsor-inquiries/${id}/file`, {
      method: 'GET',
      signal: controller.signal,
      headers: authHeader(token),
    });
    if (!res.ok) throw await toApiError(res);
    return URL.createObjectURL(await res.blob());
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchSponsorNotifyEmails(token: string): Promise<string[]> {
  const data = await fetchJson<{ emails?: unknown }>('/admin/sponsor-notify-emails', { method: 'GET', headers: authHeader(token) });
  return Array.isArray(data?.emails) ? data.emails.filter((e): e is string => typeof e === 'string') : [];
}

export async function updateSponsorNotifyEmails(token: string, emails: string[]): Promise<string[]> {
  const data = await fetchJson<{ emails?: unknown }>('/admin/sponsor-notify-emails', {
    method: 'PUT',
    headers: authHeader(token),
    body: JSON.stringify({ emails }),
  });
  return Array.isArray(data?.emails) ? data.emails.filter((e): e is string => typeof e === 'string') : [];
}

export async function fetchSponsorDonations(token: string): Promise<SponsorDonation[]> {
  const data = await fetchJson<{ donations?: unknown }>('/admin/sponsor-donations', { method: 'GET', headers: authHeader(token) });
  const list = Array.isArray(data?.donations) ? data.donations : [];
  return list.map(pickDonation).filter((x): x is SponsorDonation => x !== null);
}

export async function createSponsorDonation(token: string, input: SponsorDonationInput): Promise<SponsorDonation> {
  return mustDonation(
    await fetchJson<unknown>('/admin/sponsor-donations', { method: 'POST', headers: authHeader(token), body: JSON.stringify(input) }),
  );
}

export async function updateSponsorDonation(token: string, id: number, input: SponsorDonationInput): Promise<SponsorDonation> {
  return mustDonation(
    await fetchJson<unknown>(`/admin/sponsor-donations/${id}`, { method: 'PATCH', headers: authHeader(token), body: JSON.stringify(input) }),
  );
}

export async function deleteSponsorDonation(token: string, id: number): Promise<void> {
  await fetchJson<void>(`/admin/sponsor-donations/${id}`, { method: 'DELETE', headers: authHeader(token) });
}

/** PUT /admin/sponsor-donations/:id/files/:kind (multipart `file`): PDF/JPG/PNG/WebP ≤ 8 MB; replaces the old file. */
export async function uploadSponsorDonationFile(
  token: string,
  id: number,
  kind: SponsorFileKind,
  file: File | Blob,
): Promise<SponsorDonation> {
  const form = new FormData();
  form.append('file', file);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${API_BASE}/admin/sponsor-donations/${id}/files/${kind}`, {
      method: 'PUT',
      body: form,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...authHeader(token) },
    });
    if (!res.ok) throw await toApiError(res);
    return mustDonation(await res.json());
  } finally {
    clearTimeout(timeoutId);
  }
}

/** GET the stored file as a blob: URL (admin-only, no-store). Revoke it when done. */
export async function fetchSponsorDonationFile(token: string, id: number, kind: SponsorFileKind): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API_BASE}/admin/sponsor-donations/${id}/files/${kind}`, {
      method: 'GET',
      signal: controller.signal,
      headers: authHeader(token),
    });
    if (!res.ok) throw await toApiError(res);
    return URL.createObjectURL(await res.blob());
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function deleteSponsorDonationFile(token: string, id: number, kind: SponsorFileKind): Promise<SponsorDonation> {
  return mustDonation(
    await fetchJson<unknown>(`/admin/sponsor-donations/${id}/files/${kind}`, { method: 'DELETE', headers: authHeader(token) }),
  );
}
