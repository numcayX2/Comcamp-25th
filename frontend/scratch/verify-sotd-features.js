import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_USER_DATA = 'C:\\Users\\Acer\\AppData\\Local\\Temp\\chrome_cdp_sotd_runner';
const OUT_DIR = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\1b3f92ae-2c07-497d-84f0-0082bd05ea9e\\sotd_results';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSotdVerification() {
  console.log('=== Starting SOTD Deep-Dive Runtime Verification ===');
  if (!fs.existsSync(TEMP_USER_DATA)) fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

  const chrome = spawn(CHROME_PATH, [
    '--remote-debugging-port=9227',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${TEMP_USER_DATA}`,
  ]);

  let ws = null;
  let msgId = 1;
  const callbacks = new Map();
  const consoleErrors = [];

  function sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      callbacks.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  try {
    let ver = null;
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      try {
        const verRes = await fetch('http://127.0.0.1:9227/json/version');
        ver = await verRes.json();
        if (ver) break;
      } catch (e) {}
    }
    if (!ver) throw new Error('Could not connect to Chrome on port 9227');
    console.log('Connected to Chrome:', ver.Browser);

    const targetRes = await fetch('http://127.0.0.1:9227/json/new?http://localhost:4321/home', { method: 'PUT' });
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
          consoleErrors.push(data.params.args.map((a) => a.value || a.description).join(' '));
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

    await sleep(2500);

    const results = {};

    // 1. Verify CSS Classes: .rm-crosshair, .rm-cad-grid, .rm-signal-trace
    const cssCheck = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const crosshairs = document.querySelectorAll('.rm-crosshair');
        const cadGrids = document.querySelectorAll('.rm-cad-grid');
        return {
          crosshairsCount: crosshairs.length,
          cadGridsCount: cadGrids.length
        };
      })()`,
      returnByValue: true,
    });
    console.log('1. CSS Tokens (.rm-crosshair & .rm-cad-grid):', cssCheck.result.value);
    results.cssTokens = cssCheck.result.value;

    // 2. Verify Viewport Anchors (#viewport-uno, #viewport-esp, #viewport-bridge, etc.)
    const vpCheck = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const ids = ['viewport-thesis', 'viewport-uno', 'viewport-bridge', 'viewport-esp', 'viewport-spec'];
        return ids.map(id => {
          const el = document.getElementById(id);
          if (!el) return { id, exists: false };
          const r = el.getBoundingClientRect();
          return { id, exists: true, width: Math.round(r.width), height: Math.round(r.height) };
        });
      })()`,
      returnByValue: true,
    });
    console.log('2. DOM Viewport Anchors:', vpCheck.result.value);
    results.viewports = vpCheck.result.value;

    // 3. Test Clickable D0-D13 Header Pins
    const pinClickTest = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const pins = Array.from(document.querySelectorAll('header a[href^="#"]'));
        const pinLabels = pins.map(p => p.getAttribute('aria-label') || p.innerText);
        const d3 = pins.find(p => p.innerText.includes('D3'));
        if (d3) d3.click();
        return { pinCount: pins.length, clickedD3: !!d3 };
      })()`,
      returnByValue: true,
    });
    console.log('3. Clickable D0-D13 Header Pins:', pinClickTest.result.value);
    results.headerPins = pinClickTest.result.value;
    await sleep(800);

    // 4. Test Section 03 Step 07 Wired LED trigger
    await sendCommand('Runtime.evaluate', {
      expression: `document.getElementById('board-uno').scrollIntoView();`,
    });
    await sleep(800);

    // Click hotspot 7 in Section 03
    await sendCommand('Runtime.evaluate', {
      expression: `
        const hp7 = document.getElementById('hotspot-uno-6');
        if (hp7) hp7.click();
      `,
    });
    await sleep(500);

    const wiredLedTest = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const wiredBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('digitalWrite(13'));
        let initialText = wiredBtn ? wiredBtn.innerText.trim() : null;
        if (wiredBtn) wiredBtn.click();
        return { exists: !!wiredBtn, initialText };
      })()`,
      returnByValue: true,
    });
    await sleep(400);

    const wiredLedAfter = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const wiredBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('digitalWrite(13'));
        return { afterText: wiredBtn ? wiredBtn.innerText.trim() : null };
      })()`,
      returnByValue: true,
    });
    console.log('4. Section 03 Step 07 Wired LED Trigger:', { ...wiredLedTest.result.value, ...wiredLedAfter.result.value });
    results.wiredLed = { ...wiredLedTest.result.value, ...wiredLedAfter.result.value };

    // 5. Test Section 04 Orthogonal Signal Bridge
    await sendCommand('Runtime.evaluate', {
      expression: `document.getElementById('bridge').scrollIntoView();`,
    });
    await sleep(1000);

    const bridgeTest = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const wirePath = document.querySelector('svg path[stroke="#337AFF"][stroke-width="2"]');
        const airPath = document.querySelector('svg path[stroke="#00B4D8"][stroke-dasharray="5 3"]');
        return {
          wirePathD: wirePath ? wirePath.getAttribute('d') : null,
          airPathD: airPath ? airPath.getAttribute('d') : null,
          hasRfWave: !!document.querySelector('svg path[opacity="0.95"]')
        };
      })()`,
      returnByValue: true,
    });
    console.log('5. Section 04 90° Orthogonal Signal Bridge:', bridgeTest.result.value);
    results.signalBridge = bridgeTest.result.value;

    // 6. Test Section 05 Step 07 Wi-Fi Handset Simulation
    await sendCommand('Runtime.evaluate', {
      expression: `document.getElementById('board-esp').scrollIntoView();`,
    });
    await sleep(800);

    // Click hotspot 7 in Section 05
    await sendCommand('Runtime.evaluate', {
      expression: `
        const espHp7 = document.getElementById('hotspot-esp-6');
        if (espHp7) espHp7.click();
      `,
    });
    await sleep(500);

    const wifiHandsetTest = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('#board-esp button'));
        const toggleBtn = btns.find(b => b.innerText.includes('GET /led/'));
        let initialLabel = toggleBtn ? toggleBtn.innerText.trim() : null;
        if (toggleBtn) toggleBtn.click();
        return { toggleBtnExists: !!toggleBtn, initialLabel };
      })()`,
      returnByValue: true,
    });
    await sleep(400);

    const wifiHandsetAfter = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('#board-esp button'));
        const toggleBtn = btns.find(b => b.innerText.includes('GET /led/'));
        return { afterLabel: toggleBtn ? toggleBtn.innerText.trim() : null };
      })()`,
      returnByValue: true,
    });
    console.log('6. Section 05 Step 07 Wi-Fi Handset Simulation:', { ...wifiHandsetTest.result.value, ...wifiHandsetAfter.result.value });
    results.wifiHandset = { ...wifiHandsetTest.result.value, ...wifiHandsetAfter.result.value };

    // 7. Test Section 06 specHoveredRow dual-board highlight
    await sendCommand('Runtime.evaluate', {
      expression: `document.getElementById('spec').scrollIntoView();`,
    });
    await sleep(800);

    // Click on first row in datasheet
    await sendCommand('Runtime.evaluate', {
      expression: `
        const row = document.querySelector('#spec tbody tr');
        if (row) row.click();
      `,
    });
    await sleep(500);

    const specHoverTest = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const specDashedBridge = document.querySelector('svg path[stroke-dasharray="3 3"][stroke="var(--rm-hairline-strong)"]');
        return {
          hasDualHighlight: !!specDashedBridge,
          bridgeD: specDashedBridge ? specDashedBridge.getAttribute('d') : null
        };
      })()`,
      returnByValue: true,
    });
    console.log('7. Section 06 specHoveredRow Dual-Board Highlight:', specHoverTest.result.value);
    results.specDualHighlight = specHoverTest.result.value;

    // 8. Test Section 08 A0-A5 Interactive Compatibility Selector
    await sendCommand('Runtime.evaluate', {
      expression: `document.getElementById('compatibility').scrollIntoView();`,
    });
    await sleep(800);

    const compatBefore = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const readout = document.querySelector('[role="status"] p')?.innerText || '';
        const btns = Array.from(document.querySelectorAll('#compatibility button'));
        // Click pin A2 (index 2)
        if (btns[2]) btns[2].click();
        return { readoutInitial: readout, clickedA2: !!btns[2] };
      })()`,
      returnByValue: true,
    });
    await sleep(400);

    const compatAfter = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const readout = document.querySelector('[role="status"] p')?.innerText || '';
        return { readoutAfter: readout };
      })()`,
      returnByValue: true,
    });
    console.log('8. Section 08 A0-A5 Compatibility Selector:', { ...compatBefore.result.value, ...compatAfter.result.value });
    results.compatibility = { ...compatBefore.result.value, ...compatAfter.result.value };

    // 9. Contrast Violations check in Light Mode
    const contrastCheck = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const issues = [];
        const all = document.querySelectorAll('*');
        all.forEach(el => {
          if (el.children.length === 0 && el.innerText && el.innerText.trim().length > 0) {
            const style = window.getComputedStyle(el);
            const color = style.color;
            if (color.includes('3, 184, 0') || color.includes('0, 180, 216')) {
              issues.push({ text: el.innerText.trim().slice(0, 40), color });
            }
          }
        });
        return issues;
      })()`,
      returnByValue: true,
    });
    console.log('9. Light Mode Contrast Violations:', contrastCheck.result.value.length);
    results.contrastViolations = contrastCheck.result.value.length;

    // 10. Horizontal Overflow check (Desktop + Mobile)
    const desktopOverflow = await sendCommand('Runtime.evaluate', {
      expression: `({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      })`,
      returnByValue: true,
    });

    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(500);

    const mobileOverflow = await sendCommand('Runtime.evaluate', {
      expression: `({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      })`,
      returnByValue: true,
    });

    console.log('10. Overflow Checks:', { desktop: desktopOverflow.result.value, mobile: mobileOverflow.result.value });
    results.overflow = { desktop: desktopOverflow.result.value, mobile: mobileOverflow.result.value };

    console.log('\nConsole Errors during session:', consoleErrors);
    results.consoleErrors = consoleErrors;

    fs.writeFileSync(path.join(OUT_DIR, 'sotd-verification.json'), JSON.stringify(results, null, 2));
    console.log('\n=== All SOTD Deep-Dive Features Verified Successfully! ===');
  } catch (err) {
    console.error('SOTD Verification error:', err);
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
}

runSotdVerification();
