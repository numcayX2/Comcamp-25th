import fs from 'fs';

const filePath = 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\MainLandingPage.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// We need to inject the real asset preloader & the Kinetic Loader component into MainLandingPage.tsx
// Let's inspect where state is declared and where the loader JSX is inserted.

// 1. In state declarations:
const oldStateBlock = `  const [isBooting, setIsBooting] = useState<boolean>(false);
  const [bootLines, setBootLines] = useState<string[]>([]);

  // Defer heavy WebGL stage until idle or first user interaction to eliminate TBT blocking
  const [is3DReady, setIs3DReady] = useState<boolean>(false);

  useEffect(() => {
    let activated = false;
    const activate3D = () => {
      if (activated) return;
      activated = true;
      startTransition(() => {
        setIs3DReady(true);
      });
    };

    const onUserInteract = () => activate3D();
    window.addEventListener('scroll', onUserInteract, { passive: true, once: true });
    window.addEventListener('pointermove', onUserInteract, { passive: true, once: true });
    window.addEventListener('touchstart', onUserInteract, { passive: true, once: true });

    // Fallback activation after initial paint & Lighthouse quiet window
    const timer = setTimeout(() => {
      if ('requestIdleCallback' in window) {
        (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(activate3D);
      } else {
        activate3D();
      }
    }, 1400);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', onUserInteract);
      window.removeEventListener('pointermove', onUserInteract);
      window.removeEventListener('touchstart', onUserInteract);
    };
  }, []);`;

const newStateBlock = `  // 1. Real Asset Subsystem Telemetry States (100% Authentic Byte & Ready Tracking)
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

  // 3D Stage mounting state (starts loading engine and mounts to compile GPU shaders during intro)
  const [is3DReady, setIs3DReady] = useState<boolean>(false);

  // Track fonts readiness
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

  // Track WebGL engine chunk loading
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

  // Real Byte Streams for dual .glb assets via XMLHttpRequest (populates browser HTTP cache & tracks bytes)
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
  };`;

if (!content.includes('oldStateBlock')) {
  // Let's do a more robust regex or line-based replacement
}

console.log('Script prepared.');
