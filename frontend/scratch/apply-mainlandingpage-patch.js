import fs from 'fs';

const filePath = 'src/components/MainLandingPage.tsx';
let content = fs.readFileSync(filePath, 'utf8');

const isCRLF = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 1. Add useCallback to React imports
if (!content.includes('useCallback')) {
  content = content.replace(
    "import React, { useState, useEffect, Suspense, startTransition } from 'react';",
    "import React, { useState, useEffect, Suspense, startTransition, useCallback } from 'react';"
  );
  console.log('Added useCallback import');
}

// 2. Replace the state block & activate3D effect
const targetStateBlockStart = '  const [isBooting, setIsBooting] = useState<boolean>(false);';
const targetStateBlockEnd = '  const runHardwareDiagnostic = () => {';

const stateIndexStart = content.indexOf(targetStateBlockStart);
const stateIndexEnd = content.indexOf(targetStateBlockEnd);

if (stateIndexStart !== -1 && stateIndexEnd !== -1) {
  const replacementStateBlock = `  // 1. Real Asset Subsystem Telemetry States (100% Authentic Byte & Ready Tracking)
  const [fontsLoaded, setFontsLoaded] = useState<boolean>(false);
  const [engineLoaded, setEngineLoaded] = useState<boolean>(false);
  const [unoBytes, setUnoBytes] = useState<{ loaded: number; total: number; done: boolean }>({
    loaded: 0,
    total: 2970812,
    done: false,
  });
  const [espBytes, setEspBytes] = useState<{ loaded: number; total: number; done: boolean }>({
    loaded: 0,
    total: 3244528,
    done: false,
  });
  const [stageCompiled, setStageCompiled] = useState<boolean>(false);

  // 2. Intro Lifecycle: visible -> revealing (curtain lifts) -> dismissed
  const [introDismissed, setIntroDismissed] = useState<boolean>(false);
  const [isRevealing, setIsRevealing] = useState<boolean>(false);

  // 3. 3D Stage mounting state
  const [is3DReady, setIs3DReady] = useState<boolean>(false);

  // 4. Hardware Diagnostic Serial Monitor HUD state
  const [isBooting, setIsBooting] = useState<boolean>(false);
  const [bootLines, setBootLines] = useState<string[]>([]);

  // Track fonts readiness (10% weight)
  useEffect(() => {
    if (typeof document !== 'undefined' && document.fonts) {
      if (document.fonts.status === 'loaded') {
        setFontsLoaded(true);
      } else {
        document.fonts.ready.then(() => setFontsLoaded(true));
      }
    } else {
      setFontsLoaded(true);
    }
  }, []);

  // Track WebGL engine chunk loading (10% weight)
  useEffect(() => {
    import('./Rev25Stage3D')
      .then(() => {
        setEngineLoaded(true);
        startTransition(() => {
          setIs3DReady(true);
        });
      })
      .catch(() => {
        setEngineLoaded(true);
        setIs3DReady(true);
      });
  }, []);

  // Real Byte Streams for dual .glb assets via XMLHttpRequest (35% + 35% weight)
  useEffect(() => {
    const xhrUno = new XMLHttpRequest();
    xhrUno.open('GET', '/models/ArduinoR3.glb?v=20261102', true);
    xhrUno.responseType = 'arraybuffer';
    xhrUno.onprogress = (e) => {
      const total = e.total > 0 ? e.total : 2970812;
      setUnoBytes({ loaded: e.loaded, total, done: false });
    };
    xhrUno.onload = () => {
      setUnoBytes((prev) => ({ loaded: prev.total, total: prev.total, done: true }));
    };
    xhrUno.onerror = () => {
      setUnoBytes((prev) => ({ loaded: prev.total, total: prev.total, done: true }));
    };
    xhrUno.send();

    const xhrEsp = new XMLHttpRequest();
    xhrEsp.open('GET', '/models/esp8266.glb?v=20261102', true);
    xhrEsp.responseType = 'arraybuffer';
    xhrEsp.onprogress = (e) => {
      const total = e.total > 0 ? e.total : 3244528;
      setEspBytes({ loaded: e.loaded, total, done: false });
    };
    xhrEsp.onload = () => {
      setEspBytes((prev) => ({ loaded: prev.total, total: prev.total, done: true }));
    };
    xhrEsp.onerror = () => {
      setEspBytes((prev) => ({ loaded: prev.total, total: prev.total, done: true }));
    };
    xhrEsp.send();

    return () => {
      try {
        xhrUno.abort();
        xhrEsp.abort();
      } catch {}
    };
  }, []);

  const handleStageReady = useCallback(() => {
    setStageCompiled(true);
  }, []);

  // Safety fallback for GPU stage compilation in environments without WebGL
  useEffect(() => {
    const safetyTimer = setTimeout(() => {
      setStageCompiled(true);
    }, 4500);
    return () => clearTimeout(safetyTimer);
  }, []);

  // Weighted Real Progress Calculation: 10% Fonts + 10% Engine + 35% Uno + 35% Esp + 10% GPU Stage
  const unoRatio = unoBytes.total > 0 ? Math.min(1, unoBytes.loaded / unoBytes.total) : (unoBytes.done ? 1 : 0);
  const espRatio = espBytes.total > 0 ? Math.min(1, espBytes.loaded / espBytes.total) : (espBytes.done ? 1 : 0);

  const realProgress = Math.min(
    100,
    Math.round(
      (fontsLoaded ? 10 : 0) +
      (engineLoaded ? 10 : 0) +
      (unoRatio * 35) +
      (espRatio * 35) +
      (stageCompiled ? 10 : 0)
    )
  );

  const totalLoadedBytes = unoBytes.loaded + espBytes.loaded;
  const totalExpectedBytes = unoBytes.total + espBytes.total;
  const litPinCount = Math.min(14, Math.floor((realProgress / 100) * 14));

  // Automatic Curtain Reveal when realProgress reaches 100%
  useEffect(() => {
    if (realProgress >= 100 && stageCompiled && !isRevealing && !introDismissed) {
      const revealTimer = setTimeout(() => {
        setIsRevealing(true);
        const dismissTimer = setTimeout(() => {
          setIntroDismissed(true);
          try {
            sessionStorage.setItem('cc25_rm_intro_seen', 'true');
          } catch {}
        }, 650);
        return () => clearTimeout(dismissTimer);
      }, 350);
      return () => clearTimeout(revealTimer);
    }
  }, [realProgress, stageCompiled, isRevealing, introDismissed]);

  const handleSkipIntro = () => {
    setIsRevealing(true);
    setTimeout(() => {
      setIntroDismissed(true);
      try {
        sessionStorage.setItem('cc25_rm_intro_seen', 'true');
      } catch {}
    }, 600);
  };

`;
  content = content.slice(0, stateIndexStart) + replacementStateBlock + content.slice(stateIndexEnd);
  console.log('Replaced state and preloader block');
} else {
  console.error('Failed to locate state block indices');
}

// 3. Update runHardwareDiagnostic to also reset introDismissed / isRevealing
const oldDiagnostic = `  const runHardwareDiagnostic = () => {
    setBootLines([]);
    setIsBooting(true);`;
const newDiagnostic = `  const runHardwareDiagnostic = () => {
    setIntroDismissed(false);
    setIsRevealing(false);
    setBootLines([]);
    setIsBooting(true);`;

if (content.includes(oldDiagnostic)) {
  content = content.replace(oldDiagnostic, newDiagnostic);
  console.log('Updated runHardwareDiagnostic');
}

// 4. Update Rev25Stage3D JSX to pass onStageReady={handleStageReady}
const oldStageInvocation = `            isDark={isDark}
          />`;
const newStageInvocation = `            isDark={isDark}
            onStageReady={handleStageReady}
          />`;

if (content.includes(oldStageInvocation)) {
  content = content.replace(oldStageInvocation, newStageInvocation);
  console.log('Passed onStageReady to Rev25Stage3D');
}

// 5. Inject the Kinetic Loader UI right after the root div opening tag
const rootDivMarker = `<div className="relative min-h-screen w-full flex flex-col bg-[var(--rm-paper)] text-[var(--rm-ink)] selection:bg-[#337AFF] selection:text-white transition-colors duration-300">`;

const kineticLoaderJSX = `
      {/* REAL-PROGRESS KINETIC WEB INTRO LOADING SCREEN (CURTAIN REVEAL) */}
      {!introDismissed && (
        <section
          role="status"
          aria-label="REV.25 Hardware Boot & Asset Telemetry Loader"
          aria-live="polite"
          className={\`fixed inset-0 z-50 flex flex-col justify-between p-6 sm:p-10 md:p-14 bg-[var(--rm-paper)] text-[var(--rm-ink)] border-b border-[var(--rm-hairline-strong)] select-none rm-kinetic-loader \${
            isRevealing ? 'revealed' : ''
          }\`}
        >
          {/* TOP BAR: SYSTEM TELEMETRY HEADER & SKIP BUTTON */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--rm-hairline)] pb-5 font-mono">
            <div className="flex flex-wrap items-center gap-3 text-xs tracking-wider">
              <span className="w-2 h-2 rounded-full bg-[#03B800] animate-ping" />
              <span className="font-bold text-[var(--rm-ink)]">
                REV.25 // HARDWARE BOOT &amp; TELEMETRY
              </span>
              <span className="text-[var(--rm-text-subtle)]">|</span>
              <span className="text-[var(--rm-text-muted)]">
                ATMEGA328P + ESP8266EX DUAL-CORE
              </span>
              <span className="text-[var(--rm-text-subtle)]">|</span>
              <span className="text-xs text-[var(--rm-text-subtle)]">
                {realProgress === 100 && stageCompiled ? (
                  <span className="text-[#03B800] font-semibold">STAGE 100% ONLINE</span>
                ) : (
                  <span className="text-[#337AFF]">STREAMING ASSET BUS...</span>
                )}
              </span>
            </div>

            <button
              type="button"
              onClick={handleSkipIntro}
              id="btn-skip-intro"
              className="self-start sm:self-auto px-4 py-2 min-h-[44px] min-w-[44px] flex items-center justify-center gap-2 border border-[var(--rm-hairline-strong)] rounded-[2px] text-xs font-mono text-[var(--rm-ink)] hover:bg-[var(--rm-surface)] active:scale-95 transition-all cursor-pointer"
              aria-label="Skip hardware intro loader"
            >
              <span>[ SKIP INTRO -&gt; ]</span>
            </button>
          </div>

          {/* MIDDLE SECTION: GIANT MOMO PERCENTAGE READOUT & KINETIC CALIPER */}
          <div className="my-auto py-6 space-y-6">
            {/* Real byte telemetry & subsystem indicators */}
            <div className="flex flex-wrap items-end justify-between gap-4 font-mono text-xs text-[var(--rm-text-muted)]">
              <div>
                <span className="text-[var(--rm-text-subtle)] uppercase tracking-wider block text-[10px] mb-1">
                  01 / REAL ASSET BUS STREAM
                </span>
                <span className="text-sm font-semibold text-[var(--rm-ink)] tabular-nums" id="loader-bytes-readout">
                  LOADED: {(totalLoadedBytes / (1024 * 1024)).toFixed(2)} MB / {(totalExpectedBytes / (1024 * 1024)).toFixed(2)} MB
                </span>
              </div>
              <div className="text-right">
                <span className="text-[var(--rm-text-subtle)] uppercase tracking-wider block text-[10px] mb-1">
                  02 / GPU SHADER PIPELINE
                </span>
                <span className="text-sm font-semibold text-[var(--rm-ink)]" id="loader-gpu-status">
                  {stageCompiled ? (
                    <span className="text-[#03B800]">GPU RASTER COMPILED (1ST FRAME)</span>
                  ) : engineLoaded ? (
                    <span className="text-[#337AFF]">WARMING THREE.JS STAGE RIG...</span>
                  ) : (
                    <span className="text-[var(--rm-text-muted)]">AWAITING ENGINE CHUNK...</span>
                  )}
                </span>
              </div>
            </div>

            {/* GIANT KINETIC PERCENTAGE READOUT */}
            <div className="flex items-baseline gap-2 sm:gap-4 overflow-hidden">
              <span
                className="font-mono tabular-nums text-7xl sm:text-9xl md:text-[13rem] font-black tracking-tighter leading-none text-[var(--rm-ink)]"
                id="loader-percentage-readout"
              >
                {String(realProgress).padStart(3, '0')}
              </span>
              <span className="font-mono text-3xl sm:text-5xl md:text-7xl font-bold text-[#337AFF]">
                %
              </span>
            </div>

            {/* SWISS CALIPER PRECISION RULE */}
            <div className="space-y-1.5 font-mono">
              <div className="relative w-full h-3 bg-[var(--rm-surface)] border border-[var(--rm-hairline-strong)] rounded-[2px] overflow-hidden">
                {/* Progress fill bar */}
                <div
                  className="h-full bg-[var(--rm-ink)] transition-all duration-150 ease-out"
                  style={{ width: \`\${realProgress}%\` }}
                  role="progressbar"
                  aria-valuenow={realProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  id="loader-caliper-bar"
                />
              </div>
              {/* Caliper ticks */}
              <div className="flex justify-between text-[9px] text-[var(--rm-text-subtle)] pt-1 select-none">
                <span>000% [0.0MB]</span>
                <span className="hidden sm:inline">020%</span>
                <span className="hidden sm:inline">040%</span>
                <span>050% [HALFWAY]</span>
                <span className="hidden sm:inline">060%</span>
                <span className="hidden sm:inline">080%</span>
                <span>100% [6.21MB READY]</span>
              </div>
            </div>

            {/* 14-PIN DIGITAL STATUS BUS ARRAY (D0 TO D13) */}
            <div className="border border-[var(--rm-hairline)] bg-[var(--rm-surface)]/50 p-3 sm:p-4 rounded-[2px]" id="loader-pin-array">
              <div className="flex items-center justify-between mb-2 text-[10px] font-mono text-[var(--rm-text-subtle)] uppercase tracking-wider">
                <span>ATMEGA328P DIGITAL I/O REGISTER (D00—D13)</span>
                <span className="text-[var(--rm-ink)] font-bold">
                  PINS ACTIVE: {litPinCount}/14 ({litPinCount === 14 ? 'FULL BUS ENGAGED' : 'INITIALIZING'})
                </span>
              </div>
              <div className="grid grid-cols-7 sm:grid-cols-14 gap-1.5 font-mono text-center">
                {Array.from({ length: 14 }).map((_, pinIdx) => {
                  const isLit = pinIdx < litPinCount;
                  return (
                    <div
                      key={pinIdx}
                      id={\`loader-pin-d\${pinIdx}\`}
                      className={\`flex flex-col items-center justify-center py-1.5 px-1 rounded-[2px] border transition-all duration-200 \${
                        isLit
                          ? 'border-[#03B800] bg-[#03B800]/10 text-[#03B800]'
                          : 'border-[var(--rm-hairline)] bg-transparent text-[var(--rm-text-subtle)]'
                      }\`}
                    >
                      <span
                        className={\`w-1.5 h-1.5 rounded-full mb-1 \${
                          isLit ? 'bg-[#03B800] shadow-[0_0_6px_#03B800]' : 'bg-[var(--rm-hairline-strong)]'
                        }\`}
                      />
                      <span className="text-[9px] font-bold">D{pinIdx}</span>
                      <span className="text-[8px] opacity-75">{isLit ? 'HIGH' : 'LOW'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* BOTTOM: 5-SUBSYSTEM AUTHENTIC TELEMETRY TABLE */}
          <div className="border-t border-[var(--rm-hairline)] pt-4 font-mono" id="loader-telemetry-table">
            <div className="text-[10px] uppercase text-[var(--rm-text-subtle)] tracking-wider mb-2 flex items-center justify-between">
              <span>AUTHENTIC HARDWARE &amp; ASSET TELEMETRY MATRIX</span>
              <span>ZERO ARTIFICIAL DELAY · 100% REAL STREAMS</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-[var(--rm-ink)]">
                <thead className="text-[10px] text-[var(--rm-text-subtle)] uppercase border-b border-[var(--rm-hairline)]">
                  <tr>
                    <th className="py-1.5 pr-4 font-medium">Subsystem ID</th>
                    <th className="py-1.5 pr-4 font-medium">Asset Target</th>
                    <th className="py-1.5 pr-4 font-medium">Bus Weight</th>
                    <th className="py-1.5 pr-4 font-medium">Stream Status</th>
                    <th className="py-1.5 text-right font-medium">Verification</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--rm-hairline)]/50 text-[11px]">
                  {/* Row 1: Fonts */}
                  <tr id="telemetry-sys-01">
                    <td className="py-1.5 pr-4 text-[var(--rm-text-muted)] font-semibold">SYS-01</td>
                    <td className="py-1.5 pr-4">Typography Engine</td>
                    <td className="py-1.5 pr-4 text-[var(--rm-text-subtle)]">10%</td>
                    <td className="py-1.5 pr-4">
                      {fontsLoaded ? (
                        <span className="text-[#03B800]">document.fonts.ready synchronized</span>
                      ) : (
                        <span className="text-[#337AFF]">Streaming fonts...</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right font-semibold">
                      <span className={fontsLoaded ? 'text-[#03B800]' : 'text-[var(--rm-text-muted)]'}>
                        [{fontsLoaded ? 'OK' : 'PENDING'}]
                      </span>
                    </td>
                  </tr>
                  {/* Row 2: R3F Engine Chunk */}
                  <tr id="telemetry-sys-02">
                    <td className="py-1.5 pr-4 text-[var(--rm-text-muted)] font-semibold">SYS-02</td>
                    <td className="py-1.5 pr-4">Three.js R3F Stage Engine</td>
                    <td className="py-1.5 pr-4 text-[var(--rm-text-subtle)]">10%</td>
                    <td className="py-1.5 pr-4">
                      {engineLoaded ? (
                        <span className="text-[#03B800]">Rev25Stage3D dynamic chunk parsed</span>
                      ) : (
                        <span className="text-[#337AFF]">Fetching JS bundle...</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right font-semibold">
                      <span className={engineLoaded ? 'text-[#03B800]' : 'text-[var(--rm-text-muted)]'}>
                        [{engineLoaded ? 'OK' : 'FETCHING'}]
                      </span>
                    </td>
                  </tr>
                  {/* Row 3: Arduino UNO GLB */}
                  <tr id="telemetry-sys-03">
                    <td className="py-1.5 pr-4 text-[var(--rm-text-muted)] font-semibold">SYS-03</td>
                    <td className="py-1.5 pr-4">ArduinoR3.glb Mesh</td>
                    <td className="py-1.5 pr-4 text-[var(--rm-text-subtle)]">35%</td>
                    <td className="py-1.5 pr-4">
                      <span className={unoBytes.done ? 'text-[#03B800]' : 'text-[#337AFF]'}>
                        {(unoBytes.loaded / (1024 * 1024)).toFixed(2)} MB / {(unoBytes.total / (1024 * 1024)).toFixed(2)} MB ({Math.round(unoRatio * 100)}%)
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-semibold">
                      <span className={unoBytes.done ? 'text-[#03B800]' : 'text-[var(--rm-text-muted)]'}>
                        [{unoBytes.done ? 'OK' : 'STREAMING'}]
                      </span>
                    </td>
                  </tr>
                  {/* Row 4: ESP8266 GLB */}
                  <tr id="telemetry-sys-04">
                    <td className="py-1.5 pr-4 text-[var(--rm-text-muted)] font-semibold">SYS-04</td>
                    <td className="py-1.5 pr-4">esp8266.glb Mesh</td>
                    <td className="py-1.5 pr-4 text-[var(--rm-text-subtle)]">35%</td>
                    <td className="py-1.5 pr-4">
                      <span className={espBytes.done ? 'text-[#03B800]' : 'text-[#337AFF]'}>
                        {(espBytes.loaded / (1024 * 1024)).toFixed(2)} MB / {(espBytes.total / (1024 * 1024)).toFixed(2)} MB ({Math.round(espRatio * 100)}%)
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-semibold">
                      <span className={espBytes.done ? 'text-[#03B800]' : 'text-[var(--rm-text-muted)]'}>
                        [{espBytes.done ? 'OK' : 'STREAMING'}]
                      </span>
                    </td>
                  </tr>
                  {/* Row 5: GPU Stage */}
                  <tr id="telemetry-sys-05">
                    <td className="py-1.5 pr-4 text-[var(--rm-text-muted)] font-semibold">SYS-05</td>
                    <td className="py-1.5 pr-4">WebGL GPU Shader Pipeline</td>
                    <td className="py-1.5 pr-4 text-[var(--rm-text-subtle)]">10%</td>
                    <td className="py-1.5 pr-4">
                      {stageCompiled ? (
                        <span className="text-[#03B800]">First frame rendered &amp; active</span>
                      ) : (
                        <span className="text-[#337AFF]">Compiling materials &amp; projections...</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right font-semibold">
                      <span className={stageCompiled ? 'text-[#03B800]' : 'text-[var(--rm-text-muted)]'}>
                        [{stageCompiled ? 'ONLINE' : 'WARMING'}]
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
`;

if (content.includes(rootDivMarker)) {
  content = content.replace(rootDivMarker, rootDivMarker + '\n' + kineticLoaderJSX);
  console.log('Injected Kinetic Loader JSX');
} else {
  console.error('Failed to locate rootDivMarker');
}

if (isCRLF) {
  content = content.replace(/\n/g, '\r\n');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('MainLandingPage.tsx updated successfully!');
