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
  campFee?: number;
  isCertificateReleased?: boolean;
}

export const DEFAULT_TARGET_DATE = "2026-11-16T00:00:00+07:00";

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  serverTime: new Date().toISOString(),
  registrationOpenAt: DEFAULT_TARGET_DATE,
  isOpen: false,
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

    const response = await fetch('/api/settings/public', {
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

/* ============================================================
   ComCamp #25 — Full-Stack Skeleton API (Go backend end-to-end)
   Base URL: PUBLIC_API_URL or http://localhost:8000/api
   ============================================================ */

export const API_BASE: string =
  import.meta.env.PUBLIC_API_URL || 'http://localhost:8000/api';

/** Where the response came from. Always rendered in UI for backend debugging. */
export type ApiSource = 'LIVE GO API' | 'MOCK FALLBACK';

export interface ApiResult<T> {
  data: T;
  source: ApiSource;
}

export type ApplicationStatus = 'PENDING' | 'PASSED' | 'RESERVE' | 'CONFIRMED' | 'REJECTED';

export interface ApplicationPayload {
  fullName: string;
  nickname: string;
  nationalId: string;
  phone: string;
  email: string;
  school: string;
  grade: string;
  shirtSize: string;
  motivation: string;
}

export interface Application {
  id: string;
  fullName: string;
  nickname: string;
  nationalId: string;
  phone: string;
  email: string;
  school: string;
  grade: string;
  shirtSize: string;
  motivation: string;
  status: ApplicationStatus;
  attendanceConfirmed: boolean;
  createdAt: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  time: string;
}

export interface LoginResponse {
  token: string;
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
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
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text || res.statusText}`);
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
  } catch {
    return { data: mock(), source: 'MOCK FALLBACK' };
  }
}

function mockId(): string {
  return `CC25-MOCK-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
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
      id: 'CC25-MOCK-000001',
      fullName: 'ตัวอย่าง ผู้สมัคร (Mock)',
      nickname: 'ตัวอย่าง',
      nationalId: query || '0000000000000',
      phone: '0800000000',
      email: 'mock@example.com',
      school: 'โรงเรียนตัวอย่าง',
      grade: 'ม.5',
      shirtSize: 'M',
      motivation: 'อยากร่วมค่าย (mock response)',
      status: 'PENDING' as ApplicationStatus,
      attendanceConfirmed: false,
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
      fullName: 'ตัวอย่าง ผู้สมัคร (Mock)',
      nickname: 'ตัวอย่าง',
      nationalId: '0000000000000',
      phone: '0800000000',
      email: 'mock@example.com',
      school: 'โรงเรียนตัวอย่าง',
      grade: 'ม.5',
      shirtSize: 'M',
      motivation: '',
      status: (confirmed ? 'CONFIRMED' : 'PASSED') as ApplicationStatus,
      attendanceConfirmed: confirmed,
      createdAt: new Date().toISOString(),
    }),
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
export function listApplications(token: string): Promise<ApiResult<Application[]>> {
  return withFallback(
    () => fetchJson<Application[]>('/admin/applications', { headers: authHeader(token) }),
    () => [
      {
        id: 'CC25-MOCK-000001',
        fullName: 'ตัวอย่าง ผู้สมัคร 1',
        nickname: 'หนึ่ง',
        nationalId: '1111111111111',
        phone: '0811111111',
        email: 'one@example.com',
        school: 'โรงเรียนตัวอย่าง',
        grade: 'ม.4',
        shirtSize: 'M',
        motivation: 'อยากเรียนคอมพิวเตอร์',
        status: 'PENDING' as ApplicationStatus,
        attendanceConfirmed: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'CC25-MOCK-000002',
        fullName: 'ตัวอย่าง ผู้สมัคร 2',
        nickname: 'สอง',
        nationalId: '2222222222222',
        phone: '0822222222',
        email: 'two@example.com',
        school: 'โรงเรียนตัวอย่าง',
        grade: 'ม.6',
        shirtSize: 'L',
        motivation: 'อยากร่วมกิจกรรมค่าย',
        status: 'PASSED' as ApplicationStatus,
        attendanceConfirmed: false,
        createdAt: new Date().toISOString(),
      },
    ],
  );
}

/** PATCH /admin/applications/:id — body { status: "..." } */
export function updateApplicationStatus(
  token: string,
  id: string,
  status: ApplicationStatus,
): Promise<ApiResult<Application>> {
  return withFallback(
    () =>
      fetchJson<Application>(`/admin/applications/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: authHeader(token),
        body: JSON.stringify({ status }),
      }),
    () => ({
      id,
      fullName: 'ตัวอย่าง ผู้สมัคร (Mock)',
      nickname: 'ตัวอย่าง',
      nationalId: '0000000000000',
      phone: '0800000000',
      email: 'mock@example.com',
      school: 'โรงเรียนตัวอย่าง',
      grade: 'ม.5',
      shirtSize: 'M',
      motivation: '',
      status,
      attendanceConfirmed: status === 'CONFIRMED',
      createdAt: new Date().toISOString(),
    }),
  );
}
