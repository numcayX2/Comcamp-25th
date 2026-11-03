import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_USER_DATA = 'C:\\Users\\Acer\\AppData\\Local\\Temp\\chrome_cdp_preview_runner';
const OUT_DIR = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\1b3f92ae-2c07-497d-84f0-0082bd05ea9e\\preview_results';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyPreview() {
  console.log('=== Verifying Astro Production Preview (Port 4321) ===');

  // 1. Test HTTP status for /home and /
  const homeRes = await fetch('http://localhost:4321/home');
  console.log(`GET /home: status ${homeRes.status} ${homeRes.statusText}`);
  if (homeRes.status !== 200) throw new Error(`Expected 200 from /home, got ${homeRes.status}`);

  const countdownRes = await fetch('http://localhost:4321/');
  console.log(`GET /: status ${countdownRes.status} ${countdownRes.statusText}`);
  if (countdownRes.status !== 200) throw new Error(`Expected 200 from /, got ${countdownRes.status}`);

  if (!fs.existsSync(TEMP_USER_DATA)) fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

  const chrome = spawn(CHROME_PATH, [
    '--remote-debugging-port=9228',
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
        const verRes = await fetch('http://127.0.0.1:9228/json/version');
        ver = await verRes.json();
        if (ver) break;
      } catch (e) {}
    }
    if (!ver) throw new Error('Could not connect to Chrome on port 9228');
    console.log('Connected to Headless Chrome:', ver.Browser);

    const targetRes = await fetch('http://127.0.0.1:9228/json/new?http://localhost:4321/home', { method: 'PUT' });
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

    // 1. Verify SVG Locked-Aspect Numerals ("25" and "CC25")
    const svgNumerals = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const heroSvg = document.querySelector('svg[viewBox="0 0 360 260"]');
        const footerSvg = document.querySelector('svg[viewBox="0 0 900 280"]');
        return {
          heroNumeralExists: !!heroSvg,
          heroAriaHidden: heroSvg?.getAttribute('aria-hidden'),
          footerNumeralExists: !!footerSvg,
          footerAriaHidden: footerSvg?.getAttribute('aria-hidden')
        };
      })()`,
      returnByValue: true,
    });
    console.log('1. SVG Numerals ("25" and "CC25"):', svgNumerals.result.value);
    results.svgNumerals = svgNumerals.result.value;

    // 2. Verify Touch Target sizes on Desktop and Mobile
    const touchTargets = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const issues = [];
        elements.forEach(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
            // Header hairline pins have pointer-events: none, so they are ignored
            if (style.pointerEvents !== 'none' && (rect.height < 44 || rect.width < 44)) {
              issues.push({
                tag: el.tagName,
                text: el.innerText.trim().slice(0, 30),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              });
            }
          }
        });
        return issues;
      })()`,
      returnByValue: true,
    });
    console.log(`2. Desktop Touch Target Violations (<44px): ${touchTargets.result.value.length}`);
    results.touchTargetsDesktop = touchTargets.result.value;

    // 3. Verify Light Mode Contrast
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
    console.log(`3. Light Mode Raw Bright Color Contrast Violations: ${contrastCheck.result.value.length}`);
    results.contrastViolations = contrastCheck.result.value.length;

    // 4. Test Scroll and Triggering 3D WebGL activation
    console.log('4. Triggering user interaction (scroll) to activate 3D Stage...');
    await sendCommand('Runtime.evaluate', {
      expression: `
        window.dispatchEvent(new Event('scroll'));
        window.scrollTo(0, 300);
      `,
    });
    await sleep(1000);

    const canvasCheck = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const canvas = document.querySelector('canvas');
        return {
          canvasExists: !!canvas,
          canvasWidth: canvas?.width,
          canvasHeight: canvas?.height
        };
      })()`,
      returnByValue: true,
    });
    console.log('   3D Canvas Status after interaction:', canvasCheck.result.value);
    results.canvasStatus = canvasCheck.result.value;

    // 5. Check Mobile (375x812)
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(600);

    const mobileTouchTargets = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const issues = [];
        elements.forEach(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
            if (style.pointerEvents !== 'none' && (rect.height < 44 || rect.width < 44)) {
              issues.push({
                tag: el.tagName,
                text: el.innerText.trim().slice(0, 30),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              });
            }
          }
        });
        return issues;
      })()`,
      returnByValue: true,
    });
    console.log(`5. Mobile Touch Target Violations (<44px): ${mobileTouchTargets.result.value.length}`);
    results.touchTargetsMobile = mobileTouchTargets.result.value;

    const mobileOverflow = await sendCommand('Runtime.evaluate', {
      expression: `({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      })`,
      returnByValue: true,
    });
    console.log('   Mobile Horizontal Overflow:', mobileOverflow.result.value);
    results.mobileOverflow = mobileOverflow.result.value;

    // 6. Check Console Errors during run
    console.log('\n6. Console Errors during production run:', consoleErrors);
    results.consoleErrors = consoleErrors;

    fs.writeFileSync(path.join(OUT_DIR, 'preview-verification.json'), JSON.stringify(results, null, 2));
    console.log('\n=== Production Preview Verification Completed Successfully! ===');
  } catch (err) {
    console.error('Verification error:', err);
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
}

verifyPreview();
