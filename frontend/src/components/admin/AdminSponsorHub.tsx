import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import type { SponsorInquiry } from '../../lib/api';
import { AdminSponsorsPanel } from '../AdminSponsorsPanel';
import { BTN_DARK, BTN_DARK_TEXT, FOCUS, INK_2, RULE, WARNING } from '../admin-ui';
import { AdminSponsorDonations, type DonationPrefill } from './AdminSponsorDonations';
import { AdminSponsorInquiries } from './AdminSponsorInquiries';
import { AdminSponsorNotify } from './AdminSponsorNotify';
import { EXPAND, FADE, FADE_EXIT, PILL_SPRING, isFinePointer } from './ui/motion';

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
  /** Whether this view is currently visible (guards `layoutId` while mounted inside a hidden view). */
  visible?: boolean;
}

/**
 * The /admin "ผู้สนับสนุน" view: a pill tablist over inquiries, donations (+ printable faculty form),
 * home-page logos and notify emails. Every panel stays mounted (hidden) so unsaved edits survive a
 * tab switch.
 */
export function AdminSponsorHub({ token, canEdit, onAuthError, onUnhandledCount, visible = true }: Props) {
  const [tab, setTab] = useState<SponsorTab>('inquiries');
  const [unhandled, setUnhandled] = useState<number | null>(null);
  const [prefill, setPrefill] = useState<DonationPrefill | null>(null);
  const tabEls = useRef(new Map<SponsorTab, HTMLButtonElement>());
  const [hovered, setHovered] = useState<SponsorTab | null>(null);
  const groupId = useId();

  useEffect(() => {
    if (!visible) setHovered(null);
  }, [visible]);

  const onCount = useCallback(
    (n: number | null) => {
      setUnhandled(n);
      onUnhandledCount(n);
    },
    [onUnhandledCount],
  );

  const onCreateDonation = useCallback((inq: SponsorInquiry) => {
    const isMoney = inq.kind === 'money';
    setPrefill((prev) => ({
      nonce: (prev?.nonce ?? 0) + 1,
      values: {
        donorName: inq.name,
        phone: inq.phone,
        kind: inq.kind,
        goodsDescription: inq.kind === 'goods' ? inq.details : '',
        note: inq.kind === 'goods' ? '' : inq.details,
        taxId: isMoney ? inq.taxId : '',
        addressLine: isMoney ? inq.addressLine : '',
        subdistrict: isMoney ? inq.subdistrict : '',
        district: isMoney ? inq.district : '',
        province: isMoney ? inq.province : '',
        postcode: isMoney ? inq.postcode : '',
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
      <LayoutGroup id={groupId}>
        <motion.div
          layoutScroll
          role="tablist"
          aria-label="ส่วนของผู้สนับสนุน"
          onPointerLeave={() => setHovered(null)}
          onPointerCancel={() => setHovered(null)}
          className="relative flex max-w-full gap-1 self-start overflow-x-auto rounded-full border p-1 [scrollbar-width:thin]"
          style={{ borderColor: RULE }}
        >
          {TABS.map((t) => {
            const active = tab === t.key;
            const badge = t.key === 'inquiries' && unhandled ? unhandled : 0;
            return (
              <button
                key={t.key}
                ref={(el) => {
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
                onPointerEnter={(e) => {
                  if (isFinePointer(e)) setHovered(t.key);
                }}
                className={`relative inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 py-2 text-sm transition-colors duration-200 motion-reduce:transition-none ${FOCUS}`}
                style={{
                  color: active ? BTN_DARK_TEXT : INK_2,
                  fontWeight: active ? 600 : 500,
                }}
              >
                <AnimatePresence initial={false}>
                  {visible && hovered === t.key && !active && (
                    <motion.span
                      aria-hidden="true"
                      layoutId={`${groupId}-hover`}
                      style={{ borderRadius: 9999 }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1, transition: FADE }}
                      exit={{ opacity: 0, transition: FADE_EXIT }}
                      transition={{ layout: PILL_SPRING }}
                      className="pointer-events-none absolute -inset-px rounded-full bg-[var(--color-btn-ghost-hover)]"
                    />
                  )}
                </AnimatePresence>
                {active &&
                  (visible ? (
                    <motion.span
                      aria-hidden="true"
                      layoutId={`${groupId}-pill`}
                      transition={PILL_SPRING}
                      className="pointer-events-none absolute -inset-px rounded-full"
                      style={{ backgroundColor: BTN_DARK, borderRadius: 9999 }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -inset-px rounded-full"
                      style={{ backgroundColor: BTN_DARK }}
                    />
                  ))}
                <span className="relative inline-flex items-center gap-2">
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
                </span>
              </button>
            );
          })}
        </motion.div>
      </LayoutGroup>

      <TabPanel id="inquiries" active={tab === 'inquiries'}>
        <AdminSponsorInquiries
          token={token}
          canEdit={canEdit}
          onAuthError={onAuthError}
          onUnhandledCount={onCount}
          onCreateDonation={onCreateDonation}
        />
      </TabPanel>
      <TabPanel id="donations" active={tab === 'donations'}>
        <AdminSponsorDonations token={token} canEdit={canEdit} onAuthError={onAuthError} prefill={prefill} />
      </TabPanel>
      <TabPanel id="logos" active={tab === 'logos'}>
        <AdminSponsorsPanel token={token} canEdit={canEdit} onAuthError={onAuthError} />
      </TabPanel>
      <TabPanel id="notify" active={tab === 'notify'}>
        <AdminSponsorNotify token={token} canEdit={canEdit} onAuthError={onAuthError} />
      </TabPanel>
    </div>
  );
}

/** A tabpanel that stays mounted while hidden (keeps unsaved edits) and fades up when shown. */
function TabPanel({ id, active, children }: { id: SponsorTab; active: boolean; children: ReactNode }) {
  return (
    <motion.div
      id={`sponsor-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`sponsor-tab-${id}`}
      hidden={!active}
      initial={false}
      animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
      transition={active ? EXPAND : { duration: 0 }}
    >
      {children}
    </motion.div>
  );
}
