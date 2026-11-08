/**
 * ComCamp #25 - API Client & Server Time Synchronization
 * Aligns client countdown with authentic server time to prevent clock tampering.
 */

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

/* ============================================================
   ComCamp #25 — Full-Stack API Client (Go backend end-to-end)
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

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  serverTime: new Date().toISOString(),
  registrationOpenAt: DEFAULT_TARGET_DATE,
  isOpen: false,
  currentCount: 0,
  maxCapacity: 30,
  campFee: 300,
  isCertificateReleased: false,
};

let cachedOffsetMs: number = 0;
let isSynced: boolean = false;

/**
 * Fetch public settings from backend API (/api/settings/public).
 * Smoothly falls back to realistic default specifications if backend is offline.
 */
export async function fetchPublicSettings(): Promise<{ settings: PublicSettings; offsetMs: number }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(`${API_BASE}/settings/public`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    const data: PublicSettings = await response.json();
    const serverEpoch = new Date(data.serverTime).getTime();
    const clientEpoch = Date.now();
    const offsetMs = serverEpoch - clientEpoch;

    cachedOffsetMs = offsetMs;
    isSynced = true;

    return { settings: data, offsetMs };
  } catch (error) {
    // Graceful offline fallback
    const clientEpoch = Date.now();
    const fallbackSettings: PublicSettings = {
      ...DEFAULT_PUBLIC_SETTINGS,
      serverTime: new Date().toISOString(),
    };
    cachedOffsetMs = 0;
    isSynced = true;

    return { settings: fallbackSettings, offsetMs: 0 };
  }
}

/**
 * Returns current timestamp corrected by verified server time offset.
 */
export function getSynchronizedServerDate(offsetMs: number = cachedOffsetMs): Date {
  return new Date(Date.now() + offsetMs);
}

// API_BASE and ApiResult defined above

export type ApplicationStatus = 'PENDING' | 'PASSED' | 'RESERVE' | 'CONFIRMED' | 'REJECTED';

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
}

/**
 * Applicant record matching Go Backend DTO schema.
 * Supports both camelCase and snake_case keys gracefully.
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
  slipUrl?: string | null;
  slip_url?: string | null;
  slipStatus?: string | null;
  slip_status?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export type Application = ApplicantRecord;

export interface SlipUploadResult {
  id: string;
  slipUrl: string;
  status: string;
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

export interface LoginResponse {
  token: string;
}

export interface LoginResult {
  token: string;
}

/**
 * Helper to retrieve slip URL regardless of camelCase or snake_case keying.
 */
export function getSlipUrl(app?: Partial<ApplicantRecord> | null): string | undefined {
  if (!app) return undefined;
  return (app.slipUrl || app.slip_url || undefined) as string | undefined;
}

/**
 * Resolves relative /uploads/slips/... paths against the backend origin (e.g. http://localhost:8000).
 * Strips any trailing '/api' from API_BASE to obtain the server host/origin.
 */
export function getSlipImageUrl(slipUrl?: string | null): string {
  if (!slipUrl) return '';
  if (
    slipUrl.startsWith('http://') ||
    slipUrl.startsWith('https://') ||
    slipUrl.startsWith('data:') ||
    slipUrl.startsWith('blob:')
  ) {
    return slipUrl;
  }
  const origin = API_BASE.replace(/\/api\/?$/, '');
  const cleanPath = slipUrl.startsWith('/') ? slipUrl : `/${slipUrl}`;
  return `${origin}${cleanPath}`;
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
    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      const errMsg = errData?.error || `HTTP ${res.status} ${res.statusText}`;
      throw new ApiError(res.status, errMsg);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function withFallback<T>(live: () => Promise<T>, mock: () => T): Promise<ApiResult<T>> {
  try {
    const data = await live();
    return { data, source: 'LIVE GO API' };
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    return { data: mock(), source: 'MOCK FALLBACK' };
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

/** POST /applications */
export function submitApplication(payload: ApplicationPayload): Promise<ApiResult<Application>> {
  return withFallback(
    () =>
      fetchJson<Application>('/applications', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    () => ({
      id: mockId(),
      ...payload,
      status: 'PENDING' as ApplicationStatus,
      attendanceConfirmed: false,
      slipUrl: null,
      createdAt: new Date().toISOString(),
    }),
  );
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
      nationalId: query || '1509900112233',
      phone: '0819876543',
      email: 'somkiat@school.ac.th',
      school: 'โรงเรียนแม่โจ้วิทยาคม',
      grade: 'ม.5',
      shirtSize: 'XL',
      motivation: 'อยากเรียนรู้การต่อวงจรเซนเซอร์และบอร์ด ESP8266 ทำ AI Dashboard',
      province: 'เชียงใหม่',
      status: 'PASSED' as ApplicationStatus,
      attendanceConfirmed: false,
      slipUrl: null,
      createdAt: new Date().toISOString(),
    }),
  );
}

/** POST /applications/:id/confirm — body { confirmed: boolean } */
export function confirmAttendance(id: string, confirmed: boolean): Promise<ApiResult<Application>> {
  return withFallback(
    () =>
      fetchJson<Application>(`/applications/${encodeURIComponent(id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmed }),
      }),
    () => ({
      id,
      fullName: 'สมเกียรติ สุขสมบูรณ์ (Mock)',
      nickname: 'เกียรติ',
      nationalId: '1509900112233',
      phone: '0819876543',
      email: 'somkiat@school.ac.th',
      school: 'โรงเรียนแม่โจ้วิทยาคม',
      grade: 'ม.5',
      shirtSize: 'XL',
      motivation: 'อยากเรียนรู้การต่อวงจรเซนเซอร์และบอร์ด ESP8266 ทำ AI Dashboard',
      province: 'เชียงใหม่',
      status: (confirmed ? 'CONFIRMED' : 'PASSED') as ApplicationStatus,
      attendanceConfirmed: confirmed,
      slipUrl: null,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * POST /applications/:id/slip
 * Uploads a payment slip image file (multipart/form-data with key 'slip').
 */
export function uploadPaymentSlip(
  id: string,
  file: File,
): Promise<ApiResult<SlipUploadResult>> {
  const formData = new FormData();
  formData.append('slip', file);

  return withFallback(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(`${API_BASE}/applications/${encodeURIComponent(id)}/slip`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          const errMsg = errData?.error || `HTTP ${res.status} ${res.statusText}`;
          throw new ApiError(res.status, errMsg);
        }
        return (await res.json()) as SlipUploadResult;
      } finally {
        clearTimeout(timeoutId);
      }
    },
    () => {
      const mockBlobUrl =
        typeof URL !== 'undefined' && URL.createObjectURL
          ? URL.createObjectURL(file)
          : '/uploads/slips/mock_slip.jpg';
      return {
        id,
        slipUrl: mockBlobUrl,
        status: 'PASSED',
        message: 'อัปโหลดสลิปสำเร็จ รอดำเนินการตรวจสอบโดยเจ้าหน้าที่ (Mock Mode)',
      };
    },
  );
}

/** POST /auth/login */
export function adminLogin(username: string, password: string): Promise<ApiResult<LoginResponse>> {
  return withFallback(
    () =>
      fetchJson<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    () => ({ token: 'mock-jwt-token' }),
  );
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
        slipUrl: '/uploads/slips/demo_slip_1.jpg',
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
        slipUrl: '/uploads/slips/demo_slip_2.jpg',
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
        status: 'PENDING' as ApplicationStatus,
        attendanceConfirmed: false,
        slipUrl: null,
        createdAt: new Date(Date.now() - 259200000).toISOString(),
      },
    ],
  );
}

/** PATCH /admin/applications/:id — body { status: "...", reason: "..." } */
export function updateApplicationStatus(
  token: string,
  id: string,
  status: ApplicationStatus,
  reason?: string,
): Promise<ApiResult<Application>> {
  return withFallback(
    () =>
      fetchJson<Application>(`/admin/applications/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: authHeader(token),
        body: JSON.stringify({ status, reason }),
      }),
    () => ({
      id,
      fullName: 'ตัวอย่าง ผู้สมัคร (Mock)',
      nickname: 'ตัวอย่าง',
      nationalId: '1509900000000',
      phone: '0800000000',
      email: 'mock@example.com',
      school: 'โรงเรียนตัวอย่าง',
      grade: 'ม.5',
      shirtSize: 'M',
      motivation: '',
      province: 'เชียงใหม่',
      status,
      attendanceConfirmed: status === 'CONFIRMED',
      slipUrl: null,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * PATCH /admin/applications/:id/verify-slip
 * Verifies or rejects the payment slip of an applicant.
 * Body: { approved: boolean, note: string }
 */
export function verifyPaymentSlip(
  token: string,
  id: string,
  approved: boolean,
  note: string = '',
): Promise<ApiResult<VerifySlipResponse>> {
  return withFallback(
    () =>
      fetchJson<VerifySlipResponse>(`/admin/applications/${encodeURIComponent(id)}/verify-slip`, {
        method: 'PATCH',
        headers: authHeader(token),
        body: JSON.stringify({
          approved,
          note: note || (approved ? 'ยอดเงินถูกต้องครบถ้วน' : 'สลิปไม่ถูกต้อง'),
        }),
      }),
    () => ({
      message: approved
        ? 'อนุมัติสลิปสำเร็จ (Mock Mode)'
        : 'ปฏิเสธสลิปสำเร็จ (Mock Mode)',
    }),
  );
}

/* ============================================================
   ComCamp #25 — Admin Camp Settings & Quota Management API
   ============================================================ */

export interface AdminSettings {
  id: number;
  campName: string;
  registrationOpenAt: string;
  registrationCloseAt: string;
  announcementAt?: string | null;
  paymentOpenAt?: string | null;
  paymentDeadline?: string | null;
  certificateReleaseAt?: string | null;
  maxCapacity: number;
  campFee: number;
  isManualClosed: boolean;
  updatedByAdminId?: number | null;
  updatedAt?: string;
}

export interface UpdateAdminSettingsPayload {
  campName?: string;
  registrationOpenAt?: string;
  registrationCloseAt?: string;
  announcementAt?: string;
  paymentOpenAt?: string;
  paymentDeadline?: string;
  certificateReleaseAt?: string;
  maxCapacity?: number;
  campFee?: number;
  isManualClosed?: boolean;
}

/** GET /admin/settings */
export function getAdminSettings(token: string): Promise<ApiResult<AdminSettings>> {
  return withFallback(
    () => fetchJson<AdminSettings>('/admin/settings', { headers: authHeader(token) }),
    () => ({
      id: 1,
      campName: 'ComCamp 25th',
      registrationOpenAt: DEFAULT_TARGET_DATE,
      registrationCloseAt: '2026-11-30T23:59:59+07:00',
      maxCapacity: 30,
      campFee: 300,
      isManualClosed: false,
    }),
  );
}

/** PATCH /admin/settings */
export function updateAdminSettings(
  token: string,
  payload: UpdateAdminSettingsPayload,
): Promise<ApiResult<AdminSettings>> {
  return withFallback(
    () =>
      fetchJson<AdminSettings>('/admin/settings', {
        method: 'PATCH',
        headers: authHeader(token),
        body: JSON.stringify(payload),
      }),
    () => ({
      id: 1,
      campName: payload.campName || 'ComCamp 25th',
      registrationOpenAt: payload.registrationOpenAt || DEFAULT_TARGET_DATE,
      registrationCloseAt: payload.registrationCloseAt || '2026-11-30T23:59:59+07:00',
      maxCapacity: payload.maxCapacity ?? 30,
      campFee: payload.campFee ?? 300,
      isManualClosed: payload.isManualClosed ?? false,
    }),
  );
}
