import React, { useEffect, useRef, useState } from 'react';

/**
 * Total flip duration: 320ms (160ms falling 0deg -> -90deg + 160ms landing +90deg -> 0deg).
 * Leaves 680ms of rock-steady display inside every exact 1,000ms real-time tick.
 * Kept in sync with --flap-half-duration: 160ms in src/styles/global.css.
 */
const SPLIT_FLAP_DURATION_MS = 320;

interface SplitFlapDigitProps {
  digit: string;
}

export const SplitFlapDigit: React.FC<SplitFlapDigitProps> = ({ digit }) => {
  const [currentValue, setCurrentValue] = useState<string>(digit);
  const [previousValue, setPreviousValue] = useState<string>(digit);
  const [isFlipping, setIsFlipping] = useState<boolean>(false);
  const [flipId, setFlipId] = useState<number>(0);
  const prevDigitRef = useRef<string>(digit);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (digit === prevDigitRef.current) return;

    const outgoing = prevDigitRef.current;
    prevDigitRef.current = digit;

    setPreviousValue(outgoing);
    setCurrentValue(digit);
    setIsFlipping(true);
    setFlipId((id) => id + 1);

    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setIsFlipping(false);
      setPreviousValue(digit);
      timerRef.current = undefined;
    }, SPLIT_FLAP_DURATION_MS);

    return () => {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [digit]);

  // While flipping, the static bottom card still carries the old bottom
  // glyph; once the landing flap reaches 0deg it hands over to the new one.
  const bottomValue = isFlipping ? previousValue : currentValue;

  return (
    <div
      className="flap-module w-28 h-28 sm:w-36 sm:h-36 md:w-44 md:h-44"
      aria-hidden="true"
    >
      <div className="flap-housing">
        {/* LAYER 1 - static top half: TOP 50% of the new 2-digit number, revealed as the old flap falls */}
        <div className="flap-half flap-half-top flap-static">
          <div className="flap-glyph flap-glyph-top">{currentValue}</div>
          <div className="flap-surface flap-surface-top" />
        </div>

        {/* LAYER 2 - static bottom half: BOTTOM 50% of the old 2-digit number until the landing flap covers it */}
        <div className="flap-half flap-half-bottom flap-static">
          <div className="flap-glyph flap-glyph-bottom">{bottomValue}</div>
          <div className="flap-surface flap-surface-bottom" />
          {isFlipping && (
            <div key={`cast-${flipId}`} className="flap-cast-shadow" />
          )}
        </div>

        {/* LAYERS 3 & 4 - mechanical half-flaps, remounted on every tick */}
        {isFlipping && (
          <React.Fragment key={flipId}>
            {/* LAYER 3 - old top half falls 0deg -> -90deg (gravity acceleration) */}
            <div className="flap-half flap-half-top flap-animated flap-falling-top">
              <div className="flap-glyph flap-glyph-top">{previousValue}</div>
              <div className="flap-surface flap-surface-top" />
              <div className="flap-shade flap-shade-top" />
            </div>

            {/* LAYER 4 - new bottom half lands +90deg -> 0deg (crisp mechanical snap) */}
            <div className="flap-half flap-half-bottom flap-animated flap-landing-bottom">
              <div className="flap-glyph flap-glyph-bottom">{currentValue}</div>
              <div className="flap-surface flap-surface-bottom" />
              <div className="flap-shade flap-shade-bottom" />
            </div>
          </React.Fragment>
        )}

        {/* Crisp 1px mechanical hinge seam */}
        <div className="flap-seam" />

        {/* Recessed housing bezel, painted above the flap layers */}
        <div className="flap-bezel" />
      </div>

      {/* Metallic hinge pins sit outside the clipped window */}
      <div className="flap-hinge flap-hinge-left" />
      <div className="flap-hinge flap-hinge-right" />
    </div>
  );
};

// Standalone sculptural 3D square Split-Flap block for a 2-digit countdown unit (ZERO box-in-box)
export const SplitFlapPair: React.FC<{ value: number; label: string }> = ({ value, label }) => {
  const formatted = Math.max(0, value).toString().padStart(2, '0');

  return (
    <div
      className="flex flex-col items-center justify-center"
      role="group"
      aria-label={`${formatted} ${label}`}
    >
      <SplitFlapDigit digit={formatted} />

      <span
        className="mt-4 sm:mt-5 text-xs sm:text-sm font-sans font-normal tracking-wider text-[var(--color-ink-muted)] text-center select-none"
        aria-hidden="true"
      >
        {label}
      </span>
    </div>
  );
};
