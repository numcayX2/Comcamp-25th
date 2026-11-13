/**
 * Coordinates initial page-load fetches of GET /settings/public across Astro scripts, plain
 * public scripts (public/theme/main.js), and React islands via one shared window slot.
 */

export interface PublicSettingsPayload {
  serverTime: string;
  registrationOpenAt: string;
  isOpen: boolean;
  currentCount?: number;
  maxCapacity?: number;
  campFee?: number | null;
  isCertificateReleased?: boolean;
}

interface SharedSettingsSlot {
  url: string;
  settledAt: number;
  promise: Promise<PublicSettingsPayload>;
}

interface SharedSettingsWindow extends Window {
  __CC25_PUBLIC_SETTINGS_SLOT__?: SharedSettingsSlot;
  __CC25_SWAP_LISTENER_BOUND__?: boolean;
}

/**
 * Reuses an in-flight request or a response settled within the same page-load burst (~1.5 s) so
 * SiteNav, hero, and React gates never fire duplicate network calls. Explicit re-checks (midnight
 * wakeup, retry button, post-admin save) pass forceFresh: true to bypass the slot.
 */
const INITIAL_BURST_MS = 1500;

export function clearSharedPublicSettingsCache(): void {
  if (typeof window === 'undefined') return;
  delete (window as SharedSettingsWindow).__CC25_PUBLIC_SETTINGS_SLOT__;
}

function bindClientRouterReset(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const win = window as SharedSettingsWindow;
  if (win.__CC25_SWAP_LISTENER_BOUND__) return;
  win.__CC25_SWAP_LISTENER_BOUND__ = true;
  document.addEventListener('astro:after-swap', clearSharedPublicSettingsCache);
}

export function fetchSharedPublicSettings(
  baseUrl: string,
  options: { forceFresh?: boolean; timeoutMs?: number } = {},
): Promise<PublicSettingsPayload> {
  bindClientRouterReset();

  const url = `${baseUrl.replace(/\/$/, '')}/settings/public`;
  const forceFresh = Boolean(options.forceFresh);
  const timeoutMs = options.timeoutMs ?? 4000;
  const win = typeof window !== 'undefined' ? (window as SharedSettingsWindow) : undefined;
  const existing = win?.__CC25_PUBLIC_SETTINGS_SLOT__;

  if (!forceFresh && existing && existing.url === url) {
    if (existing.settledAt === 0 || Date.now() - existing.settledAt < INITIAL_BURST_MS) {
      return existing.promise;
    }
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined;

  const slot: SharedSettingsSlot = {
    url,
    settledAt: 0,
    promise: Promise.resolve({} as PublicSettingsPayload),
  };

  const request = fetch(url, {
    signal: controller ? controller.signal : undefined,
    headers: { Accept: 'application/json' },
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`settings ${res.status}`);
      const data = (await res.json()) as PublicSettingsPayload;
      slot.settledAt = Date.now();
      return data;
    })
    .catch((err) => {
      if (win && win.__CC25_PUBLIC_SETTINGS_SLOT__ === slot) {
        delete win.__CC25_PUBLIC_SETTINGS_SLOT__;
      }
      throw err;
    })
    .finally(() => {
      if (timer !== undefined) window.clearTimeout(timer);
    });

  slot.promise = request;
  if (win) win.__CC25_PUBLIC_SETTINGS_SLOT__ = slot;
  return request;
}
