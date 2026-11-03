import React from 'react';

/**
 * FuturisticGradient:
 * Ultra-smooth, slow-moving liquid-silk fluid gradient.
 * - Multi-stop self-feathering radial gradients (6-7 stops) eliminating all banding.
 * - Organic, slowly drifting transitions with prime, staggered durations (20s, 22s, 25s, 29s, 33s)
 *   so the fluid motion feels endlessly alive, hypnotic, and natural.
 * - ZERO SVG filters, ZERO masks, ZERO horizontal seams or bounding-box clipping lines.
 * - GPU-composited transforms with will-change for buttery 60fps performance.
 */
export const FuturisticGradient: React.FC = () => {
  return (
    <div
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}
      className="w-full h-full select-none"
      aria-hidden="true"
    >
      {/* 
        Oversized Fluid Canvas:
        Positioned with negative insets so blur halos never touch screen borders
      */}
      <div className="absolute inset-[-15%] w-[130%] h-[130%] transition-opacity duration-700 opacity-80 dark:opacity-75">
        
        {/* 1. CENTRAL VIBRANT GREEN CORE (#00E575 / #03B800)
            Shifts and breathes softly under the countdown clock (20s cycle) */}
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[2%] w-[65vw] max-w-[950px] h-[55vh] max-h-[620px] pointer-events-none">
          <div
            className="w-full h-full rounded-[50%] blur-[95px] transform-gpu animate-fluid-center"
            style={{
              background: `radial-gradient(ellipse 55% 50% at 50% 65%,
                rgba(0, 229, 117, 0.76) 0%,
                rgba(3, 184, 0, 0.65) 18%,
                rgba(0, 200, 160, 0.48) 36%,
                rgba(0, 180, 216, 0.32) 54%,
                rgba(37, 99, 235, 0.16) 72%,
                rgba(37, 99, 235, 0.04) 88%,
                transparent 100%)`,
            }}
          />
        </div>

        {/* 2. LEFT SWEEPING WAVE: Royal Blue (#2563EB / #337AFF) & Aqua-Cyan (#00B4D8)
            Slowly sweeps, scales and rotates along the left quadrant (25s cycle) */}
        <div className="absolute -left-[10%] bottom-[0%] w-[68vw] max-w-[1050px] h-[65vh] max-h-[750px] pointer-events-none">
          <div
            className="w-full h-full rounded-[60%_40%_65%_35%/50%_60%_40%_50%] blur-[105px] transform-gpu animate-fluid-left"
            style={{
              background: `radial-gradient(ellipse 60% 55% at 42% 62%,
                rgba(37, 99, 235, 0.82) 0%,
                rgba(51, 122, 255, 0.68) 18%,
                rgba(0, 180, 216, 0.50) 36%,
                rgba(0, 210, 180, 0.30) 54%,
                rgba(0, 229, 117, 0.15) 72%,
                rgba(0, 229, 117, 0.03) 88%,
                transparent 100%)`,
            }}
          />
        </div>

        {/* 3. RIGHT SWEEPING WAVE: Aqua-Cyan (#00B4D8) & Vibrant Green (#03B800 / #00E575)
            Slowly sweeps, scales and rotates along the right quadrant (29s cycle) */}
        <div className="absolute -right-[10%] bottom-[0%] w-[68vw] max-w-[1050px] h-[65vh] max-h-[750px] pointer-events-none">
          <div
            className="w-full h-full rounded-[40%_60%_35%_65%/60%_50%_50%_40%] blur-[105px] transform-gpu animate-fluid-right"
            style={{
              background: `radial-gradient(ellipse 60% 55% at 58% 62%,
                rgba(0, 180, 216, 0.78) 0%,
                rgba(0, 215, 170, 0.64) 18%,
                rgba(0, 229, 117, 0.52) 36%,
                rgba(3, 184, 0, 0.35) 54%,
                rgba(37, 99, 235, 0.14) 72%,
                rgba(37, 99, 235, 0.03) 88%,
                transparent 100%)`,
            }}
          />
        </div>

        {/* 4. 5TH FLOATING ELECTRIC CYAN-GREEN ACCENT ORB
            Glides smoothly between the left blue and right green waves (22s cycle)
            Visibly blending and carrying colors across the center channel */}
        <div className="absolute left-[38%] bottom-[10%] w-[45vw] max-w-[700px] h-[40vh] max-h-[480px] pointer-events-none">
          <div
            className="w-full h-full rounded-[50%] blur-[110px] transform-gpu animate-fluid-orb"
            style={{
              background: `radial-gradient(circle at 50% 50%,
                rgba(0, 235, 185, 0.65) 0%,
                rgba(0, 200, 220, 0.48) 18%,
                rgba(0, 180, 216, 0.32) 36%,
                rgba(37, 99, 235, 0.18) 54%,
                rgba(0, 229, 117, 0.08) 72%,
                rgba(0, 229, 117, 0.02) 88%,
                transparent 100%)`,
            }}
          />
        </div>

        {/* 5. LOWER HORIZON AMBIENT RIBBON BLEND
            Gently undulates along the bottom horizon (33s cycle) */}
        <div className="absolute left-1/2 -translate-x-1/2 -bottom-[10%] w-[90vw] h-[45vh] pointer-events-none">
          <div
            className="w-full h-full rounded-[50%] blur-[120px] transform-gpu animate-fluid-horizon"
            style={{
              background: `radial-gradient(ellipse 70% 50% at 50% 60%,
                rgba(0, 180, 216, 0.50) 0%,
                rgba(51, 122, 255, 0.38) 18%,
                rgba(0, 200, 170, 0.28) 36%,
                rgba(0, 229, 117, 0.18) 54%,
                rgba(3, 184, 0, 0.09) 72%,
                rgba(3, 184, 0, 0.02) 88%,
                transparent 100%)`,
            }}
          />
        </div>

      </div>
    </div>
  );
};
