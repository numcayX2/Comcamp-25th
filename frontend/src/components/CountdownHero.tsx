import React, { useState, useEffect } from 'react';
import { fetchPublicSettings, type PublicSettings } from '../lib/api';
import { ThemeToggle } from './ThemeToggle';
import { SplitFlapPair } from './SplitFlapDigit';
import { FuturisticGradient } from './FuturisticGradient';
import { MainLandingPage } from './MainLandingPage';

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
}

const DEFAULT_TARGET_EPOCH = new Date("2026-11-16T00:00:00+07:00").getTime();

function computeTimeLeft(targetEpoch: number, currentMs: number): TimeLeft {
  const difference = targetEpoch - currentMs;
  const totalSeconds = Math.max(0, Math.floor(difference / 1000));
  if (totalSeconds <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, totalSeconds: 0 };
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { days, hours, minutes, seconds, totalSeconds };
}

function getInitialTimeLeft(): TimeLeft {
  return computeTimeLeft(DEFAULT_TARGET_EPOCH, Date.now());
}

export const CountdownHero: React.FC = () => {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [offsetMs, setOffsetMs] = useState<number>(0);
  // Synchronous initialization prevents 00 00 00 00 flash on reload
  const [timeLeft, setTimeLeft] = useState<TimeLeft>(() => getInitialTimeLeft());

  // Initial API Fetch & Server Time Sync
  useEffect(() => {
    fetchPublicSettings().then(({ settings: initialSettings, offsetMs: initialOffset }) => {
      setSettings(initialSettings);
      setOffsetMs(initialOffset);
    });
  }, []);

  // Phase-Locked Exact 1.000s Real-Time Scheduler (Zero Drift, Zero Jitter)
  useEffect(() => {
    let timeoutId: number | undefined;
    let isCancelled = false;

    const targetEpoch = settings?.registrationOpenAt
      ? new Date(settings.registrationOpenAt).getTime()
      : DEFAULT_TARGET_EPOCH;

    const tick = () => {
      if (isCancelled) return;

      const currentMs = Date.now() + offsetMs;
      const difference = targetEpoch - currentMs;
      const nextTimeLeft = computeTimeLeft(targetEpoch, currentMs);

      setTimeLeft((prev) =>
        prev.totalSeconds !== nextTimeLeft.totalSeconds ? nextTimeLeft : prev
      );

      if (difference > 0) {
        const delayMs = (difference % 1000) + 4;
        timeoutId = window.setTimeout(tick, delayMs);
      }
    };

    tick();

    return () => {
      isCancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [settings, offsetMs]);

  // When countdown expires, seamlessly transition to Main Landing Page
  if (timeLeft.totalSeconds <= 0) {
    return <MainLandingPage />;
  }

  return (
    <div className="relative w-full h-dvh max-w-full max-h-dvh overflow-x-clip overflow-y-hidden flex flex-col justify-between bg-[var(--bg-canvas)] text-[var(--color-ink)] transition-colors duration-500 select-none">
      
      {/* 1. MINIMAL TOP NAVBAR */}
      <header className="w-full h-14 px-6 sm:px-12 flex items-center justify-between z-20 border-b border-[var(--color-border)]/40 bg-[var(--bg-canvas)]/60 backdrop-blur-md">
        {/* Left: Minimal Brand Identity */}
        <div className="flex items-center gap-3">
          <span className="font-sans font-medium text-sm sm:text-base tracking-wide text-[var(--color-ink)]">
            ComCamp 25
          </span>
          <span className="hidden sm:inline-block w-px h-3.5 bg-[var(--color-border)]" />
          <span className="hidden sm:inline text-xs font-sans text-[var(--color-ink-muted)] font-light">
            วิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้
          </span>
        </div>

        {/* Right: Preview Link to Main Landing Page + Minimal Theme Toggle */}
        <div className="flex items-center gap-3">
          <a
            href="/home"
            title="ดูหน้าหลัก ComCamp 25 (Phase 1)"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-sans font-light text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--bg-surface)] border border-transparent hover:border-[var(--color-border)] transition-all cursor-pointer"
          >
            <span>ดูหน้าหลัก (Preview)</span>
            <span className="text-[10px] font-mono">→</span>
          </a>
          <span className="w-px h-3.5 bg-[var(--color-border)]/60" />
          <ThemeToggle />
        </div>
      </header>

      {/* 2. CENTERPIECE STAGE (Clean Logo Placeholder + 4 Standalone 3D Split-Flap Square Blocks) */}
      <main className="flex-1 w-full max-w-5xl mx-auto flex flex-col items-center justify-center px-4 sm:px-6 relative z-10">
        
        {/* CLEAN COMCAMP LOGO SLOT (Directly above clock) */}
        <div id="comcamp-logo-slot" className="mb-8 sm:mb-12 text-center flex flex-col items-center justify-center">
          <h1 className="font-sans font-light text-3xl sm:text-4xl md:text-5xl tracking-wide text-[var(--color-ink)] select-none">
            ComCamp <span className="font-normal text-[var(--color-tech)]">25</span>
          </h1>
          <p className="text-xs sm:text-sm font-sans font-light text-[var(--color-ink-muted)] tracking-wider mt-1.5 opacity-80">
            25th Computer Science Camp · Maejo University
          </p>
        </div>

        {/* 4 STANDALONE SCULPTURAL 3D SPLIT-FLAP SQUARE BLOCKS (Zero Box-in-Box) */}
        <section
          aria-label="เวลานับถอยหลังเปิดรับสมัคร ComCamp 25"
          className="grid grid-cols-2 sm:grid-cols-4 gap-5 sm:gap-6 md:gap-8 items-start justify-items-center"
        >
          <SplitFlapPair value={timeLeft.days} label="วัน" />
          <SplitFlapPair value={timeLeft.hours} label="ชั่วโมง" />
          <SplitFlapPair value={timeLeft.minutes} label="นาที" />
          <SplitFlapPair value={timeLeft.seconds} label="วินาที" />
        </section>

      </main>

      {/* 3. FLUID CURVY MESH GRADIENT */}
      <FuturisticGradient />

      {/* 4. BALANCED BOTTOM SPACER */}
      <div className="w-full h-8 sm:h-12 pointer-events-none z-10" />

    </div>
  );
};
