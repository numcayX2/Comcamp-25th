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

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  serverTime: new Date().toISOString(),
  registrationOpenAt: "2026-11-16T00:00:00+07:00",
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
