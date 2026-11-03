import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_USER_DATA = 'C:\\Users\\Acer\\AppData\\Local\\Temp\\chrome_cdp_lighthouse_runner';
const OUT_DIR = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\1b3f92ae-2c07-497d-84f0-0082bd05ea9e\\lighthouse_results';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLighthouseAudit() {
  console.log('=== Starting Lighthouse Diagnostic & Performance Audit ===');
  if (!fs.existsSync(TEMP_USER_DATA)) fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

  const chrome = spawn(CHROME_PATH, [
    '--remote-debugging-port=9223',
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

  try {
    let ver = null;
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      try {
        const verRes = await fetch('http://127.0.0.1:9223/json/version');
        ver = await verRes.json();
        if (ver) break;
      } catch (e) {
        // Retry
      }
    }
    if (!ver) throw new Error('Could not connect to Chrome on port 9223');
    console.log('Connected to Headless Chrome:', ver.Browser);

    // New target to localhost:4321/home
    const targetRes = await fetch('http://127.0.0.1:9223/json/new?http://localhost:4321/home', { method: 'PUT' });
    const target = await targetRes.json();

    ws = new WebSocket(target.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
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
    await sendCommand('Network.enable');

    // Emulate Mobile Device (Moto G4 / Pixel 5 standard Lighthouse viewport)
    console.log('\n--- Test 1: Mobile (375x812) Fresh Session Filmstrip ---');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
    });

    // Clear session storage to simulate fresh first visit
    await sendCommand('Page.navigate', { url: 'http://localhost:4321/home' });

    // Filmstrip capture at 300ms, 600ms, 1000ms, 1500ms, 2200ms
    const intervals = [300, 600, 1000, 1500, 2200];
    let elapsed = 0;
    for (const targetTime of intervals) {
      await sleep(targetTime - elapsed);
      elapsed = targetTime;
      const shot = await sendCommand('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, `filmstrip_${targetTime}ms.png`), Buffer.from(shot.data, 'base64'));
      
      const frameStatus = await sendCommand('Runtime.evaluate', {
        expression: `({
          h1Visible: (() => {
            const el = document.querySelector('h1');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.top < window.innerHeight && r.bottom > 0 && r.height > 0;
          })(),
          hasBlockingCurtain: (() => {
            const curtains = Array.from(document.querySelectorAll('.fixed.inset-0.z-50'));
            return curtains.length > 0;
          })(),
          toastVisible: !!document.querySelector('aside[role="status"]'),
          blueprintVisible: !!document.querySelector('svg')
        })`,
        returnByValue: true,
      });
      console.log(`  Frame ${targetTime}ms: H1 Visible=${frameStatus.result.value.h1Visible}, Blocking Curtain=${frameStatus.result.value.hasBlockingCurtain}, Serial HUD=${frameStatus.result.value.toastVisible}`);
    }

    // Performance Metrics Evaluation
    console.log('\n--- Test 2: Web Vitals & Paint Timings ---');
    const perfMetrics = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const p = performance.getEntriesByType('paint');
        const fcp = p.find(e => e.name === 'first-contentful-paint')?.startTime || 0;
        const fp = p.find(e => e.name === 'first-paint')?.startTime || 0;
        const nav = performance.getEntriesByType('navigation')[0] || {};
        
        return {
          fp: Math.round(fp),
          fcp: Math.round(fcp),
          domInteractive: Math.round(nav.domInteractive || 0),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
          loadEvent: Math.round(nav.loadEventEnd || 0)
        };
      })()`,
      returnByValue: true,
    });
    console.log('  Timings (ms):', perfMetrics.result.value);

    // Test 3: Axe-Core Accessibility Check
    console.log('\n--- Test 3: Accessibility & HTML Best Practices ---');
    const a11yCheck = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const issues = [];
        // Heading hierarchy
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
          tag: h.tagName,
          level: parseInt(h.tagName[1]),
          text: h.innerText.slice(0, 30)
        }));
        
        let prevLevel = 0;
        headings.forEach(h => {
          if (h.level > prevLevel + 1 && prevLevel !== 0) {
            issues.push({ type: 'skipped-heading', heading: h, prevLevel });
          }
          prevLevel = h.level;
        });

        // Buttons missing accessible name
        const buttons = Array.from(document.querySelectorAll('button'));
        const unnamedButtons = buttons.filter(b => {
          const name = b.getAttribute('aria-label') || b.innerText.trim();
          return !name;
        }).map(b => b.outerHTML.slice(0, 60));

        // Links missing accessible name
        const links = Array.from(document.querySelectorAll('a'));
        const unnamedLinks = links.filter(a => {
          const name = a.getAttribute('aria-label') || a.innerText.trim();
          return !name;
        }).map(a => a.outerHTML.slice(0, 60));

        // Viewport meta
        const vpMeta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
        const hasZoomLock = vpMeta.includes('user-scalable=no') || vpMeta.includes('maximum-scale=1');

        return {
          headingCount: headings.length,
          skippedHeadings: issues,
          unnamedButtons,
          unnamedLinks,
          viewportMeta: vpMeta,
          hasZoomLock
        };
      })()`,
      returnByValue: true,
    });
    console.log('  A11y & Best Practices:', a11yCheck.result.value);

    // Test 4: CLS (Cumulative Layout Shift)
    console.log('\n--- Test 4: Layout Shift Verification ---');
    const clsCheck = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        let clsValue = 0;
        const entries = performance.getEntriesByType('layout-shift') || [];
        entries.forEach(entry => {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        });
        return { cls: clsValue };
      })()`,
      returnByValue: true,
    });
    console.log('  CLS Score:', clsCheck.result.value.cls);

    const report = {
      timestamp: new Date().toISOString(),
      perfMetrics: perfMetrics.result.value,
      a11y: a11yCheck.result.value,
      cls: clsCheck.result.value.cls,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'lighthouse-summary.json'), JSON.stringify(report, null, 2));
    console.log('\n=== Lighthouse Audit Complete. Saved to lighthouse-summary.json ===');
  } catch (err) {
    console.error('Audit error:', err);
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
}

runLighthouseAudit();
