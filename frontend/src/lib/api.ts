/**
 * ComCamp #25 - API Client & Server Time Synchronization
 * Aligns client countdown with authentic server time to prevent clock tampering.
 */
import { fetchSharedPublicSettings } from './public-settings-cache';

export interface PublicSettings {
  serverTime: string;
  registrationOpenAt: string;
  isOpen: boolean;
  currentCount?: number;
  maxCapacity?: number;
  campFee?: number | null;
  isCertificateReleased?: boolean;
}

export const DEFAULT_TARGET_DATE = "2026-11-16T00:00:00+07:00";

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  serverTime: new Date().toISOString(),
  registrationOpenAt: DEFAULT_TARGET_DATE,
  isOpen: false,
  currentCount: 0,
  maxCapacity: 30,
  campFee: 1000,
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
 * REJECTED, REFUND_PENDING and REFUNDED release the seat (they are not counted in the quota) but
 * stay in the staff ledger for accounting.
 */
export type ApplicationStatus =
  | 'PENDING'
  | 'PASSED'
  | 'RESERVE'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'REFUND_PENDING'
  | 'REFUNDED';

/** Statuses that hold a seat. Mirrors the backend ApplicationStatus.IsActive. */
export function holdsSeat(status: ApplicationStatus): boolean {
  return status === 'PENDING' || status === 'PASSED' || status === 'RESERVE' || status === 'CONFIRMED';
}

export type ShirtSize = 'XS' | 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';

export interface ApplicationPayload {
  fullName: string;
  nickname: string;
  nationalId: string;
  phone: string;
  email: string;
  school: string;
  grade: string;
  shirtSize: ShirtSize;
  motivation: string;
  province?: string;
  /** Cloudflare Turnstile response token (single-use). Verified by the server, never stored. */
  turnstileToken?: string;
}

export type SlipStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * Applicant record matching the Go backend DTO.
 *
 * Public endpoints (status lookup, confirm, submit) return identifiers masked by the server
 * (AGENTS.md §13.5): nationalId `1-5099-XXXXX-XX-X`, phone `XXX-XXX-5678`, email `s***@x.com`,
 * and never a slip URL. Only /admin endpoints return full values and `slipUrl`, which is an
 * authenticated API path — load it with fetchAdminSlip, not an <img src>.
 */
export interface ApplicantRecord {
  id: string;
  fullName: string;
  nickname?: string;
  nationalId: string;
  phone: string;
  email?: string;
  school: string;
  grade: string;
  shirtSize: ShirtSize;
  motivation?: string;
  province?: string;
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
  createdAt: string;
  updatedAt?: string;
}

export type Application = ApplicantRecord;

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
export type AdminRole = 'superadmin' | 'staff' | 'finance' | 'reviewer';

export interface LoginResponse {
  token: string;
  /**
   * The account's role, so the dashboard can hide what it may not do. Only a UI hint: the server
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
   * The CSV export: superadmin and staff only, the roles the server gives full national IDs and the
   * only roles POST /admin/applications/export-audit accepts. Every export is recorded in
   * audit_logs before the file is built.
   */
  exportCsv: boolean;
}

/**
 * Mirrors the route permissions in backend/internal/server/router.go. The server is the only
 * check that counts; this keeps finance / staff / reviewer accounts from seeing buttons that would
 * only answer 403. Every role (and only these four) may read the list and the settings.
 */
export function adminPermissions(role: string | null | undefined): AdminPermissions {
  const superadmin = role === 'superadmin';
  const editor = superadmin || role === 'staff';
  const payments = editor || role === 'finance';
  return {
    changeStatus: editor,
    editProfile: editor,
    deleteApplication: superadmin,
    viewSlip: payments,
    verifySlip: payments,
    editSettings: superadmin,
    exportCsv: editor,
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

/** Removes zero-width characters only. */
export function stripZeroWidth(value: string): string {
  return value.replace(ZERO_WIDTH_RE, '');
}

/** National ID / phone as the API expects them: digits only (drops zero-width chars, hyphens, spaces). */
export function sanitizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Status lookup query: an ID or phone written with hyphens/spaces becomes digits only; anything
 * else is treated as an application ID (CC25-XXXXXX), whose own hyphen is kept.
 */
export function normalizeLookupQuery(raw: string): string {
  const q = stripZeroWidth(raw).trim();
  const digits = q.replace(/[\s\-\u2010-\u2015\u2212]/g, '');
  return /^\d+$/.test(digits) ? digits : q.toUpperCase();
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
function xhrUploadSlip(
  url: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<SlipUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = 20000;
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
        resolve(body as SlipUploadResult);
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

/** GET /applications/status?q=... */
export function getApplicationStatus(query: string): Promise<ApiResult<Application>> {
  const q = encodeURIComponent(query);
  return withFallback(
    () => fetchJson<Application>(`/applications/status?q=${q}`),
    () => ({
      id: query.toUpperCase().startsWith('CC25') ? query.toUpperCase() : 'CC25-MOCK01',
      fullName: 'สมเกียรติ สุขสมบูรณ์ (Mock)',
      nickname: 'เกียรติ',
      nationalId: '1-5099-XXXXX-XX-X',
      phone: 'XXX-XXX-6543',
      email: 's***@school.ac.th',
      school: 'โรงเรียนแม่โจ้วิทยาคม',
      grade: 'ม.5',
      shirtSize: 'XL',
      province: 'เชียงใหม่',
      status: 'PASSED' as ApplicationStatus,
      attendanceConfirmed: false,
      hasSlip: false,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * POST /api/applications/:id/withdraw — the applicant cancels their own application. Needs the
 * applicant's full 13-digit national ID (4 digits are not enough: anyone who knows the phone
 * number can look the application up). The caller keeps it in component state only and never in
 * localStorage / sessionStorage (AGENTS.md §9.2). The server soft-deletes the row, which frees the
 * seat and lets the same person register again. 400 for a malformed ID, 403 INVALID_VERIFY_CODE
 * for a wrong one, 429 RATE_LIMITED after 5 wrong answers in 15 minutes (the application is locked
 * for 15 minutes, Retry-After), 409 when the application cannot be cancelled online (CONFIRMED, a
 * slip already sent or approved, or already REJECTED / REFUND_PENDING / REFUNDED: staff handle
 * the refund), 404 if it is already gone.
 */
export async function withdrawApplication(
  id: string,
  nationalId: string,
  reason?: string,
): Promise<ApiResult<{ message: string; id: string }>> {
  const data = await fetchJson<{ message: string; id: string }>(`/applications/${encodeURIComponent(id)}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ nationalId, reason: reason || 'ผู้สมัครขอยกเลิกด้วยตนเอง' }),
  });
  return { data, source: 'LIVE GO API' };
}

/**
 * POST /applications/:id/confirm — body { confirmed, verifyCode }.
 * `verifyCode` is the last 4 digits of the applicant's national ID (AGENTS.md §13.5): the server
 * answers 403 INVALID_VERIFY_CODE when it does not match, so knowing an application ID alone is
 * not enough to act on someone else's application.
 */
export function confirmAttendance(id: string, confirmed: boolean, verifyCode: string): Promise<ApiResult<Application>> {
  return withFallback(
    () =>
      fetchJson<Application>(`/applications/${encodeURIComponent(id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmed, verifyCode }),
      }),
    () => ({
      id,
      fullName: 'สมเกียรติ สุขสมบูรณ์ (Mock)',
      nickname: 'เกียรติ',
      nationalId: '1-5099-XXXXX-XX-X',
      phone: 'XXX-XXX-6543',
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
 * Uploads a payment slip image (multipart/form-data: 'verifyCode' + 'slip'). The server checks the
 * magic bytes, caps the image at 4096×4096 px (400 INVALID_IMAGE_DIMENSIONS) and requires
 * `verifyCode`, the last 4 digits of the applicant's national ID (403 INVALID_VERIFY_CODE).
 */
export function uploadPaymentSlip(
  id: string,
  file: File,
  verifyCode: string,
  onProgress?: (percent: number) => void,
): Promise<ApiResult<SlipUploadResult>> {
  const formData = new FormData();
  formData.append('verifyCode', verifyCode);
  formData.append('slip', file);

  return withFallback(
    () => xhrUploadSlip(`${API_BASE}/applications/${encodeURIComponent(id)}/slip`, formData, onProgress),
    () => ({
      id,
      status: 'PASSED',
      hasSlip: true,
      slipStatus: 'PENDING' as SlipStatus,
      message: 'อัปโหลดสลิปสำเร็จ รอดำเนินการตรวจสอบโดยเจ้าหน้าที่ (Mock Mode)',
    }),
  );
}

/** The fields an applicant may edit themselves from /status. Identity fields are staff-only. */
export interface SelfProfilePayload {
  nickname: string;
  school: string;
  province: string;
  grade: string;
  shirtSize: ShirtSize;
}

/**
 * PATCH /applications/:id/profile — the applicant's own edit of nickname, school, province, grade
 * and shirt size. Needs the last 4 digits of the national ID (403 INVALID_VERIFY_CODE). 409 when
 * the application is REJECTED / REFUND_PENDING / REFUNDED, 400 for invalid values. Like every
 * mutation, a failure is thrown, never answered with mock data. The answer is the masked record.
 */
export async function updateOwnProfile(
  id: string,
  verifyCode: string,
  payload: SelfProfilePayload,
): Promise<ApiResult<Application>> {
  const data = await fetchJson<Application>(`/applications/${encodeURIComponent(id)}/profile`, {
    method: 'PATCH',
    body: JSON.stringify({ verifyCode, ...payload }),
  });
  return { data, source: 'LIVE GO API' };
}

/** Staff edit: any field may be sent; fields left out keep their stored value. */
export interface AdminProfilePayload {
  fullName?: string;
  nickname?: string;
  nationalId?: string;
  phone?: string;
  email?: string;
  school?: string;
  province?: string;
  grade?: string;
  shirtSize?: ShirtSize;
  motivation?: string;
  reason?: string;
}

/**
 * PATCH /admin/applications/:id/profile — full validation server-side (Mod-11 national ID, phone,
 * email, shirt size, lengths). 409 DUPLICATE_APPLICATION when the national ID, phone or email
 * belongs to another live applicant. Every change is written to audit_logs with old -> new values.
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
    () => ({ token: 'mock-jwt-token', role: 'superadmin' }),
  );
}

/* ── Admin settings (GET/PATCH /api/admin/settings) ─────────────────────── */

/** Staff view of the camp settings. `campFee` is a decimal string from the Go backend (e.g. "1000"). */
export interface AdminSettings {
  id: number;
  campName: string;
  registrationOpenAt: string;
  registrationCloseAt: string;
  announcementAt?: string;
  paymentOpenAt?: string;
  paymentDeadline?: string;
  maxCapacity: number;
  campFee: string | number;
  isManualClosed: boolean;
  isCertificateReleased?: boolean;
  currentCount?: number;
}

/** Partial update, mirroring the Go `UpdateSettingsRequest`. Omitted fields are left unchanged. */
export interface UpdateAdminSettingsPayload {
  maxCapacity?: number;
  campFee?: number;
  isManualClosed?: boolean;
  registrationOpenAt?: string;
  registrationCloseAt?: string;
}

/** Offline-dev stand-in only, used when the server cannot be reached under `astro dev`. */
const MOCK_ADMIN_SETTINGS: AdminSettings = {
  id: 1,
  campName: 'ComCamp #25 (Mock)',
  registrationOpenAt: DEFAULT_TARGET_DATE,
  // TODO(content): วันปิดรับสมัครยังไม่ประกาศ ใช้วันเปิดเป็นค่าชั่วคราวใน mock เท่านั้น
  registrationCloseAt: DEFAULT_TARGET_DATE,
  maxCapacity: 30,
  campFee: 1000,
  isManualClosed: false,
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
        nationalId: '1509900112233',
        phone: '0819876543',
        email: 'somkiat@school.ac.th',
        school: 'โรงเรียนแม่โจ้วิทยาคม',
        grade: 'ม.5',
        shirtSize: 'XL',
        motivation: 'อยากเรียนรู้การต่อวงจรเซนเซอร์และบอร์ด ESP8266 ทำ AI Dashboard',
        province: 'เชียงใหม่',
        status: 'PASSED' as ApplicationStatus,
        attendanceConfirmed: true,
        hasSlip: true,
        slipStatus: 'PENDING' as SlipStatus,
        slipUrl: '/api/admin/applications/CC25-9A8B1C/slip',
        createdAt: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: 'CC25-4D5E6F',
        fullName: 'กัญญาภัทร สิริวัฒน์',
        nickname: 'ฟ้า',
        nationalId: '1509900223344',
        phone: '0891234567',
        email: 'kanya@school.ac.th',
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
        createdAt: new Date(Date.now() - 172800000).toISOString(),
      },
      {
        id: 'CC25-112233',
        fullName: 'ธีรเดช เจริญผล',
        nickname: 'บอย',
        nationalId: '1509900334455',
        phone: '0845556677',
        email: 'teeradej@school.ac.th',
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
 * phone number or national ID; only whether a search narrowed the list.
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

/** PATCH /admin/applications/:id — body { status: "...", reason: "..." } */
export async function updateApplicationStatus(
  token: string,
  id: string,
  status: ApplicationStatus,
  reason?: string,
): Promise<ApiResult<Application>> {
  const data = await fetchJson<Application>(`/admin/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify({ status, reason }),
  });
  return { data, source: 'LIVE GO API' };
}

/**
 * PATCH /admin/applications/:id/verify-slip
 * Verifies or rejects the payment slip of an applicant.
 * Body: { approved: boolean, note: string, paymentId?: string }
 *
 * paymentId is the `slipPaymentId` of the slip that was on screen. If the applicant has uploaded a
 * newer slip since, the server answers 409 SLIP_CHANGED and changes nothing.
 */
export async function verifyPaymentSlip(
  token: string,
  id: string,
  approved: boolean,
  note: string = '',
  paymentId?: string | null,
): Promise<ApiResult<VerifySlipResponse>> {
  const data = await fetchJson<VerifySlipResponse>(`/admin/applications/${encodeURIComponent(id)}/verify-slip`, {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify({
      approved,
      note: note || (approved ? 'ยอดเงินถูกต้องครบถ้วน' : 'สลิปไม่ถูกต้อง'),
      ...(paymentId ? { paymentId } : {}),
    }),
  });
  return { data, source: 'LIVE GO API' };
}

/**
 * GET /admin/applications/:id/slip — the slip image is only served to an authenticated admin
 * (AGENTS.md §13.3/§13.5), so it cannot be an <img src>. Returns an object URL for the image;
 * the caller must URL.revokeObjectURL it when done.
 */
export async function fetchAdminSlip(token: string, id: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}/slip`, {
      headers: authHeader(token),
      signal: controller.signal,
    });
    if (!res.ok) throw await toApiError(res);
    return URL.createObjectURL(await res.blob());
  } finally {
    clearTimeout(timeoutId);
  }
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
