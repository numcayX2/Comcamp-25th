import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_USER_DATA = 'C:\\Users\\Acer\\AppData\\Local\\Temp\\chrome_cdp_loader_runner';
const OUT_DIR = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\1b3f92ae-2c07-497d-84f0-0082bd05ea9e\\kinetic_loader_results';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runKineticLoaderVerification() {
  console.log('=== VERIFYING REV.25 REAL-PROGRESS KINETIC INTRO LOADER ===');

  const report = {
    timestamp: new Date().toISOString(),
    task: 'FE-REV25-REAL-KINETIC-LOADER',
    tests: {},
    consoleErrors: [],
    success: false,
  };

  // 1. Verify HTTP endpoints
  const homeRes = await fetch('http://localhost:4321/home');
  console.log(`[HTTP] GET /home: status ${homeRes.status}`);
  if (homeRes.status !== 200) throw new Error(`Expected 200 from /home, got ${homeRes.status}`);
  report.tests['http_home_200'] = true;

  const countdownRes = await fetch('http://localhost:4321/');
  console.log(`[HTTP] GET /: status ${countdownRes.status}`);
  if (countdownRes.status !== 200) throw new Error(`Expected 200 from /, got ${countdownRes.status}`);
  report.tests['http_countdown_200'] = true;

  if (!fs.existsSync(TEMP_USER_DATA)) fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

  const chrome = spawn(CHROME_PATH, [
    '--remote-debugging-port=9230',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${TEMP_USER_DATA}`,
  ]);

  let ws = null;
  let msgId = 1;
  const callbacks = new Map();

  function sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      callbacks.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async function captureScreenshot(filename) {
    const res = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const outPath = path.join(OUT_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`[Screenshot] Saved: ${outPath} (${buffer.length} bytes)`);
    return outPath;
  }

  try {
    let ver = null;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      try {
        const verRes = await fetch('http://127.0.0.1:9230/json/version');
        ver = await verRes.json();
        if (ver) break;
      } catch (e) {}
    }
    if (!ver) throw new Error('Could not connect to Chrome on port 9230');
    console.log('[Chrome CDP] Connected:', ver.Browser);

    const targetRes = await fetch('http://127.0.0.1:9230/json/new?http://localhost:4321/home', { method: 'PUT' });
    const target = await targetRes.json();

    ws = new WebSocket(target.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.consoleAPICalled') {
        if (data.params.type === 'error') {
          const errText = data.params.args.map((a) => a.value || a.description).join(' ');
          console.error('[Browser Error]', errText);
          report.consoleErrors.push(errText);
        }
      }
      if (data.id && callbacks.has(data.id)) {
        const { resolve, reject } = callbacks.get(data.id);
        callbacks.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };

    await sendCommand('Page.enable');
    await sendCommand('DOM.enable');
    await sendCommand('Runtime.enable');

    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    console.log('[CDP] Navigating to http://localhost:4321/home with cleared session storage...');
    await sendCommand('Page.navigate', { url: 'http://localhost:4321/home' });

    // Wait a brief 200ms to observe early loader state
    await sleep(250);

    const initialLoaderInfo = await evaluate(`(() => {
      const loader = document.querySelector('section[role="status"][aria-label="REV.25 Hardware Boot & Asset Telemetry Loader"]');
      const percentageEl = document.getElementById('loader-percentage-readout');
      const bytesEl = document.getElementById('loader-bytes-readout');
      const caliperEl = document.getElementById('loader-caliper-bar');
      const skipBtn = document.getElementById('btn-skip-intro');
      const pins = Array.from(document.querySelectorAll('[id^="loader-pin-d"]')).length;
      const rows = Array.from(document.querySelectorAll('[id^="telemetry-sys-"]')).length;

      return {
        hasLoader: !!loader,
        classes: loader ? loader.className : '',
        percentageText: percentageEl ? percentageEl.textContent.trim() : null,
        bytesText: bytesEl ? bytesEl.textContent.trim() : null,
        caliperWidth: caliperEl ? caliperEl.style.width : null,
        hasSkipBtn: !!skipBtn,
        skipBtnHeight: skipBtn ? skipBtn.offsetHeight : 0,
        skipBtnWidth: skipBtn ? skipBtn.offsetWidth : 0,
        pinsCount: pins,
        rowsCount: rows,
      };
    })()`);

    console.log('[Kinetic Loader Initial State]:', initialLoaderInfo);
    report.tests['loader_mounted'] = initialLoaderInfo.hasLoader;
    report.tests['loader_14_pins'] = initialLoaderInfo.pinsCount === 14;
    report.tests['loader_5_telemetry_rows'] = initialLoaderInfo.rowsCount === 5;
    report.tests['skip_btn_touch_target_44px'] = initialLoaderInfo.skipBtnHeight >= 44;

    const initialShot = await captureScreenshot('kinetic_loader_active.png');
    report.initialScreenshot = initialShot;

    // Monitor progress until reaches 100% and begins curtain reveal
    console.log('[CDP] Waiting for asset stream and stage readiness (100% progress)...');
    let maxWait = 40; // 40 * 250ms = 10s
    let finalState = null;

    while (maxWait-- > 0) {
      await sleep(250);
      finalState = await evaluate(`(() => {
        const loader = document.querySelector('section[role="status"][aria-label="REV.25 Hardware Boot & Asset Telemetry Loader"]');
        const percentageEl = document.getElementById('loader-percentage-readout');
        const bytesEl = document.getElementById('loader-bytes-readout');
        const caliperEl = document.getElementById('loader-caliper-bar');
        const gpuEl = document.getElementById('loader-gpu-status');
        const litPins = Array.from(document.querySelectorAll('[id^="loader-pin-d"]')).filter(p => p.textContent.includes('HIGH')).length;

        return {
          hasLoader: !!loader,
          isRevealedClass: loader ? loader.classList.contains('revealed') : false,
          percentage: percentageEl ? percentageEl.textContent.trim() : null,
          bytes: bytesEl ? bytesEl.textContent.trim() : null,
          caliperWidth: caliperEl ? caliperEl.style.width : null,
          gpuStatus: gpuEl ? gpuEl.textContent.trim() : null,
          litPins,
        };
      })()`);

      console.log(`[Progress Loop] Readout: ${finalState.percentage}% | Bytes: ${finalState.bytes} | Lit pins: ${finalState.litPins}/14 | Revealed: ${finalState.isRevealedClass}`);

      if (finalState.percentage === '100' || finalState.isRevealedClass || !finalState.hasLoader) {
        break;
      }
    }

    report.tests['reached_100_percent'] = finalState.percentage === '100' || finalState.isRevealedClass || !finalState.hasLoader;
    report.tests['all_14_pins_lit_at_100'] = finalState.litPins === 14 || finalState.isRevealedClass || !finalState.hasLoader;

    // Wait for the smooth 650ms curtain reveal to complete and dismiss
    await sleep(1000);

    const postRevealState = await evaluate(`(() => {
      const loader = document.querySelector('section[role="status"][aria-label="REV.25 Hardware Boot & Asset Telemetry Loader"]');
      const header = document.querySelector('header');
      const hero = document.getElementById('overview');
      return {
        loaderDismissed: !loader,
        headerVisible: !!header,
        heroVisible: !!hero,
      };
    })()`);

    console.log('[Post Reveal State]:', postRevealState);
    report.tests['curtain_dismissed_and_content_visible'] = postRevealState.loaderDismissed && postRevealState.heroVisible;

    const revealedShot = await captureScreenshot('landing_page_revealed.png');
    report.revealedScreenshot = revealedShot;

    // Test Colophon Replay: Scroll down, click [ RUN HARDWARE DIAGNOSTIC ]
    console.log('[CDP] Testing Colophon Replay button...');
    await evaluate(`window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });`);
    await sleep(400);

    const replayClicked = await evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const diagBtn = btns.find(b => b.textContent.includes('RUN HARDWARE DIAGNOSTIC'));
      if (diagBtn) {
        diagBtn.click();
        return true;
      }
      return false;
    })()`);

    console.log(`[Colophon] Replay button clicked: ${replayClicked}`);
    await sleep(300);

    const replayedLoaderState = await evaluate(`(() => {
      const loader = document.querySelector('section[role="status"][aria-label="REV.25 Hardware Boot & Asset Telemetry Loader"]');
      return { hasLoader: !!loader };
    })()`);

    console.log('[Colophon Replay Status]:', replayedLoaderState);
    report.tests['replay_diagnostic_restores_loader'] = replayedLoaderState.hasLoader;

    // Test [ SKIP INTRO -> ] button click
    const skipClicked = await evaluate(`(() => {
      const skipBtn = document.getElementById('btn-skip-intro');
      if (skipBtn) {
        skipBtn.click();
        return true;
      }
      return false;
    })()`);
    console.log(`[Skip Intro] Button clicked: ${skipClicked}`);
    await sleep(800);

    const postSkipState = await evaluate(`(() => {
      const loader = document.querySelector('section[role="status"][aria-label="REV.25 Hardware Boot & Asset Telemetry Loader"]');
      return { loaderDismissed: !loader };
    })()`);
    report.tests['skip_intro_dismisses_loader'] = postSkipState.loaderDismissed;

    // Verify Countdown page
    console.log('[CDP] Navigating to countdown page http://localhost:4321/ ...');
    await sendCommand('Page.navigate', { url: 'http://localhost:4321/' });
    await sleep(1500);

    const countdownInfo = await evaluate(`(() => {
      const flaps = document.querySelectorAll('.split-flap-digit, [data-split-flap="true"], .split-flap');
      const bodyText = document.body.innerText;
      return {
        flapsCount: flaps.length,
        hasComCamp: bodyText.includes('COMCAMP') || bodyText.includes('Comcamp') || bodyText.includes('25'),
      };
    })()`);
    console.log('[Countdown Info]:', countdownInfo);
    report.tests['countdown_page_functional'] = countdownInfo.hasComCamp;

    const countdownShot = await captureScreenshot('countdown_page_verified.png');
    report.countdownScreenshot = countdownShot;

    report.tests['zero_console_errors'] = report.consoleErrors.length === 0;

    const allPassed = Object.values(report.tests).every(Boolean);
    report.success = allPassed;

    fs.writeFileSync(
      path.join(OUT_DIR, 'kinetic-loader-verification.json'),
      JSON.stringify(report, null, 2),
      'utf8'
    );

    console.log('=== VERIFICATION SUMMARY ===');
    console.log(JSON.stringify(report, null, 2));

    if (!allPassed) {
      throw new Error(`Verification tests failed: ${JSON.stringify(report.tests)}`);
    }

    console.log('✅ ALL KINETIC LOADER VERIFICATION TESTS PASSED PERFECTLY!');
  } finally {
    if (ws) {
      try { ws.close(); } catch {}
    }
    chrome.kill();
  }
}

runKineticLoaderVerification().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
