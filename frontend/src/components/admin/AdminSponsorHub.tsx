import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { SponsorInquiry } from '../../lib/api';
import { AdminSponsorsPanel } from '../AdminSponsorsPanel';
import { BTN_DARK, BTN_DARK_TEXT, FOCUS, INK_2, RULE, WARNING } from '../admin-ui';
import { AdminSponsorDonations, type DonationPrefill } from './AdminSponsorDonations';
import { AdminSponsorInquiries } from './AdminSponsorInquiries';
import { AdminSponsorNotify } from './AdminSponsorNotify';
import { useSlidingMarker } from './useSlidingMarker';

type SponsorTab = 'inquiries' | 'donations' | 'logos' | 'notify';
const TABS: { key: SponsorTab; label: string }[] = [
  { key: 'inquiries', label: 'ผู้สนใจสนับสนุน' },
  { key: 'donations', label: 'รายการบริจาค' },
  { key: 'logos', label: 'โลโก้บนเว็บ' },
  { key: 'notify', label: 'อีเมลแจ้งเตือน' },
];

interface Props {
  token: string;
  canEdit: boolean;
  /** Returns true when the error was an expired session, in which case the parent has logged out. */
  onAuthError: (err: unknown) => boolean;
  /** Inquiries not yet contacted (null while unknown), for the side-menu badge. */
  onUnhandledCount: (n: number | null) => void;
}

/**
 * The /admin "ผู้สนับสนุน" view: a pill tablist over inquiries, donations (+ printable faculty form),
 * home-page logos and notify emails. Every panel stays mounted (hidden) so unsaved edits survive a
 * tab switch.
 */
export function AdminSponsorHub({ token, canEdit, onAuthError, onUnhandledCount }: Props) {
  const [tab, setTab] = useState<SponsorTab>('inquiries');
  const [unhandled, setUnhandled] = useState<number | null>(null);
  const [prefill, setPrefill] = useState<DonationPrefill | null>(null);
  const tabEls = useRef(new Map<SponsorTab, HTMLButtonElement>());
  const m = useSlidingMarker(tab, `${unhandled ?? ''}`);

  const onCount = useCallback(
    (n: number | null) => {
      setUnhandled(n);
      onUnhandledCount(n);
    },
    [onUnhandledCount],
  );

  const onCreateDonation = useCallback((inq: SponsorInquiry) => {
    setPrefill((prev) => ({
      nonce: (prev?.nonce ?? 0) + 1,
      values: {
        donorName: inq.name,
        phone: inq.phone,
        kind: inq.kind,
        goodsDescription: inq.kind === 'goods' ? inq.details : '',
        note: inq.kind === 'goods' ? '' : inq.details,
      },
    }));
    setTab('donations');
  }, []);

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.findIndex((t) => t.key === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = TABS[next].key;
    setTab(key);
    tabEls.current.get(key)?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        ref={m.listRef}
        role="tablist"
        aria-label="ส่วนของผู้สนับสนุน"
        onPointerLeave={m.onListPointerLeave}
        className="relative flex max-w-full gap-1 self-start overflow-x-auto rounded-full border p-1 [scrollbar-width:thin]"
        style={{ borderColor: RULE }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-0 rounded-full bg-[var(--color-btn-ghost-hover)]"
          style={m.trackerStyle}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-0 rounded-full"
          style={{ ...m.wellStyle, backgroundColor: BTN_DARK }}
        />
        {TABS.map((t) => {
          const active = tab === t.key;
          const badge = t.key === 'inquiries' && unhandled ? unhandled : 0;
          return (
            <button
              key={t.key}
              ref={(el) => {
                m.itemRef(t.key)(el);
                if (el) tabEls.current.set(t.key, el);
                else tabEls.current.delete(t.key);
              }}
              id={`sponsor-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`sponsor-panel-${t.key}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(t.key)}
              onKeyDown={onTabKeyDown}
              onPointerEnter={m.onItemPointerEnter(t.key)}
              className={`relative z-10 inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-sm transition-colors duration-200 motion-reduce:transition-none ${FOCUS}`}
              style={{
                backgroundColor: active && !m.positioned ? BTN_DARK : 'transparent',
                color: active ? BTN_DARK_TEXT : INK_2,
                fontWeight: active ? 600 : 500,
              }}
            >
              <span>{t.label}</span>
              {badge > 0 && (
                <span
                  className="inline-flex min-w-6 items-center justify-center rounded-full px-1.5 font-mono text-xs leading-5 tabular-nums"
                  style={{ backgroundColor: WARNING, color: 'var(--color-on-warning)' }}
                >
                  <span className="sr-only">ยังไม่ได้ติดต่อ </span>
                  {badge}
                  <span className="sr-only"> รายการ</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div id="sponsor-panel-inquiries" role="tabpanel" aria-labelledby="sponsor-tab-inquiries" hidden={tab !== 'inquiries'}>
        <AdminSponsorInquiries
          token={token}
          canEdit={canEdit}
          onAuthError={onAuthError}
          onUnhandledCount={onCount}
          onCreateDonation={onCreateDonation}
        />
      </div>
      <div id="sponsor-panel-donations" role="tabpanel" aria-labelledby="sponsor-tab-donations" hidden={tab !== 'donations'}>
        <AdminSponsorDonations token={token} canEdit={canEdit} onAuthError={onAuthError} prefill={prefill} />
      </div>
      <div id="sponsor-panel-logos" role="tabpanel" aria-labelledby="sponsor-tab-logos" hidden={tab !== 'logos'}>
        <AdminSponsorsPanel token={token} canEdit={canEdit} onAuthError={onAuthError} />
      </div>
      <div id="sponsor-panel-notify" role="tabpanel" aria-labelledby="sponsor-tab-notify" hidden={tab !== 'notify'}>
        <AdminSponsorNotify token={token} canEdit={canEdit} onAuthError={onAuthError} />
      </div>
    </div>
  );
}
