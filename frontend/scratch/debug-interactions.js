import { spawn } from 'child_process';
import fs from 'fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_USER_DATA = 'C:\\Users\\Acer\\AppData\\Local\\Temp\\chrome_cdp_debug_runner';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function debugInteractions() {
  const chrome = spawn(CHROME_PATH, [
    '--remote-debugging-port=9226',
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
        const verRes = await fetch('http://127.0.0.1:9226/json/version');
        ver = await verRes.json();
        if (ver) break;
      } catch (e) {}
    }

    const targetRes = await fetch('http://127.0.0.1:9226/json/new?http://localhost:4321/home', { method: 'PUT' });
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
    await sendCommand('Runtime.enable');
    await sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    await sleep(2000);

    // Scroll to Section 05
    await sendCommand('Runtime.evaluate', { expression: `document.getElementById('board-esp').scrollIntoView();` });
    await sleep(500);

    const espClickResult = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const hp7 = document.getElementById('hotspot-esp-6');
        if (!hp7) return { error: 'hotspot-esp-6 not found' };
        hp7.click();
        return { clicked: true, text: hp7.innerText };
      })()`,
      returnByValue: true
    });
    console.log('ESP click result:', espClickResult.result.value);

    await sleep(500);

    const espButtons = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('#board-esp button')).map(b => b.innerText);
        return { btns };
      })()`,
      returnByValue: true
    });
    console.log('ESP buttons after click:', espButtons.result.value);

    // Now test Section 08 compatibility pin click
    await sendCommand('Runtime.evaluate', { expression: `document.getElementById('compatibility').scrollIntoView();` });
    await sleep(500);

    const compatPins = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('#compatibility button'));
        const pinNames = btns.map(b => b.innerText.split('\\n')[0]);
        // Click pin 2 (A2)
        if (btns[2]) btns[2].click();
        return { pinCount: btns.length, pinNames };
      })()`,
      returnByValue: true
    });
    console.log('Compat pins:', compatPins.result.value);

    await sleep(500);

    const compatReadout = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const readout = document.querySelector('[role="status"] p')?.innerText || '';
        const vref = document.querySelector('[role="status"]')?.innerText || '';
        return { readout, vref };
      })()`,
      returnByValue: true
    });
    console.log('Compat readout after clicking A2:', compatReadout.result.value);

    // Test Section 06 specHoveredRow dual highlight
    await sendCommand('Runtime.evaluate', { expression: `document.getElementById('spec').scrollIntoView();` });
    await sleep(500);

    const specRowClick = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const rows = Array.from(document.querySelectorAll('#spec tbody tr'));
        if (rows[0]) rows[0].click();
        return { rowCount: rows.length, firstRow: rows[0]?.innerText.split('\\n')[0] };
      })()`,
      returnByValue: true
    });
    console.log('Spec row click:', specRowClick.result.value);

    await sleep(500);

    const specSvg = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const circles = Array.from(document.querySelectorAll('svg circle')).map(c => ({
          cx: c.getAttribute('cx'),
          cy: c.getAttribute('cy'),
          fill: c.getAttribute('fill')
        }));
        const dashed = Array.from(document.querySelectorAll('svg path[stroke-dasharray="3 3"]')).map(p => p.getAttribute('d'));
        return { circlesCount: circles.length, dashed };
      })()`,
      returnByValue: true
    });
    console.log('Spec SVG state:', specSvg.result.value);

  } catch (e) {
    console.error('Debug error:', e);
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
}

debugInteractions();
