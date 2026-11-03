import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_USER_DATA = 'C:\\Users\\Acer\\AppData\\Local\\Temp\\chrome_cdp_audit_runner';
const OUT_DIR = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\1b3f92ae-2c07-497d-84f0-0082bd05ea9e\\audit_results';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAudit() {
  console.log('--- Starting Chrome CDP UX Audit ---');
  if (!fs.existsSync(TEMP_USER_DATA)) fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

  const chrome = spawn(CHROME_PATH, [
    '--remote-debugging-port=9222',
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
    // Wait for Chrome to initialize
    await sleep(2000);
    const verRes = await fetch('http://127.0.0.1:9222/json/version');
    const ver = await verRes.json();
    console.log('Connected to Chrome:', ver.Browser);

    // Create a new target for the site
    const targetRes = await fetch('http://127.0.0.1:9222/json/new?http://localhost:4321/home', { method: 'PUT' });
    const target = await targetRes.json();
    console.log('Target created:', target.id);

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

    // Wait for page load
    await sleep(2500);

    const auditResults = {
      viewports: {},
      contrastIssues: [],
      touchTargetIssues: [],
      overflowIssues: [],
      leaderLineStatus: {},
    };

    const viewports = [
      { name: 'desktop_1440', width: 1440, height: 900, isMobile: false },
      { name: 'desktop_1280', width: 1280, height: 800, isMobile: false },
      { name: 'mobile_375', width: 375, height: 812, isMobile: true },
    ];

    for (const vp of viewports) {
      console.log(`\nAuditing Viewport: ${vp.name} (${vp.width}x${vp.height})`);
      await sendCommand('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.isMobile,
      });

      await sleep(1000);

      for (const mode of ['light', 'dark']) {
        console.log(`  Mode: ${mode}`);
        // Set mode via JS
        await sendCommand('Runtime.evaluate', {
          expression: `
            if ('${mode}' === 'dark') {
              document.documentElement.classList.add('dark');
              document.documentElement.setAttribute('data-theme', 'dark');
            } else {
              document.documentElement.classList.remove('dark');
              document.documentElement.setAttribute('data-theme', 'light');
            }
          `,
        });

        await sleep(500);

        // Capture screenshot
        const shot = await sendCommand('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT_DIR, `${vp.name}_${mode}.png`), Buffer.from(shot.data, 'base64'));

        // Check 1: Horizontal scroll width vs client width
        const overflow = await sendCommand('Runtime.evaluate', {
          expression: `({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
          })`,
          returnByValue: true,
        });

        if (overflow.result.value.hasOverflow) {
          auditResults.overflowIssues.push({
            viewport: vp.name,
            mode,
            details: overflow.result.value,
          });
          console.warn(`    [FAIL] Horizontal overflow detected! scrollWidth=${overflow.result.value.scrollWidth}, clientWidth=${overflow.result.value.clientWidth}`);
        } else {
          console.log(`    [PASS] No horizontal overflow (${overflow.result.value.clientWidth}px)`);
        }

        // Check 2: Touch targets (buttons, links)
        const touchTargets = await sendCommand('Runtime.evaluate', {
          expression: `
            (() => {
              const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input, select'));
              const issues = [];
              elements.forEach(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
                  // Only report elements in viewport or within document
                  if (rect.height < 44 || rect.width < 44) {
                    issues.push({
                      tag: el.tagName,
                      text: el.innerText.trim().slice(0, 30),
                      id: el.id,
                      className: el.className.slice(0, 40),
                      width: Math.round(rect.width),
                      height: Math.round(rect.height)
                    });
                  }
                }
              });
              return issues;
            })()
          `,
          returnByValue: true,
        });

        if (vp.isMobile && touchTargets.result.value.length > 0) {
          console.log(`    [INFO] Small touch targets found on mobile: ${touchTargets.result.value.length}`);
          touchTargets.result.value.forEach((t) => {
            auditResults.touchTargetIssues.push({ viewport: vp.name, mode, ...t });
          });
        }

        // Check 3: Text Contrast in Light Mode
        if (mode === 'light') {
          const contrast = await sendCommand('Runtime.evaluate', {
            expression: `
              (() => {
                const issues = [];
                const all = document.querySelectorAll('*');
                all.forEach(el => {
                  if (el.children.length === 0 && el.innerText && el.innerText.trim().length > 0) {
                    const style = window.getComputedStyle(el);
                    const color = style.color;
                    // Check for raw bright green or cyan in computed color
                    // rgb(3, 184, 0) or rgb(0, 180, 216)
                    if (color.includes('3, 184, 0') || color.includes('0, 180, 216')) {
                      issues.push({
                        text: el.innerText.trim().slice(0, 40),
                        tag: el.tagName,
                        color,
                        className: el.className
                      });
                    }
                  }
                });
                return issues;
              })()
            `,
            returnByValue: true,
          });

          if (contrast.result.value.length > 0) {
            console.warn(`    [FAIL] Low-contrast text in Light Mode: ${contrast.result.value.length} instances`);
            contrast.result.value.forEach((c) => {
              auditResults.contrastIssues.push(c);
            });
          } else {
            console.log('    [PASS] No raw bright green/cyan text in Light Mode');
          }
        }
      }
    }

    // Check 4: SVG Leader Line runtime test
    console.log('\n--- Checking SVG Leader Lines in Section 03 & 05 ---');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Scroll to section 03
    await sendCommand('Runtime.evaluate', {
      expression: `
        document.getElementById('board-uno').scrollIntoView();
      `,
    });
    await sleep(1000);

    const unoLeaderInfo = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const path = document.querySelector('svg path[stroke="#337AFF"]');
          return {
            exists: !!path,
            d: path ? path.getAttribute('d') : null,
            activeSection: document.querySelector('header span.animate-pulse')?.parentElement?.innerText
          };
        })()
      `,
      returnByValue: true,
    });
    console.log('  Section 03 Leader Line Info:', unoLeaderInfo.result.value);

    // Click step 7
    await sendCommand('Runtime.evaluate', {
      expression: `
        const btn = document.getElementById('hotspot-uno-6');
        if (btn) btn.click();
      `,
    });
    await sleep(600);

    const unoStep7Info = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const path = document.querySelector('svg path[stroke="#337AFF"]');
          return {
            exists: !!path,
            d: path ? path.getAttribute('d') : null
          };
        })()
      `,
      returnByValue: true,
    });
    console.log('  Section 03 Step 7 Leader Line Info:', unoStep7Info.result.value);

    // Scroll to section 05
    await sendCommand('Runtime.evaluate', {
      expression: `
        document.getElementById('board-esp').scrollIntoView();
      `,
    });
    await sleep(1000);

    const espLeaderInfo = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const path = document.querySelector('svg path[stroke="#00B4D8"]');
          return {
            exists: !!path,
            d: path ? path.getAttribute('d') : null
          };
        })()
      `,
      returnByValue: true,
    });
    console.log('  Section 05 Leader Line Info:', espLeaderInfo.result.value);

    // Check 5: Live Section Indicator and 14 Pins across scroll
    console.log('\n--- Checking Scroll Choreography & 14 Pins ---');
    const scrollPoints = [0, 0.25, 0.5, 0.75, 1.0];
    for (const p of scrollPoints) {
      const pinResult = await sendCommand('Runtime.evaluate', {
        expression: `
          (() => {
            const docHeight = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, docHeight * ${p});
            return {
              scrollY: window.scrollY,
              progress: ${p}
            };
          })()
        `,
        returnByValue: true,
      });
      await sleep(400);

      const navState = await sendCommand('Runtime.evaluate', {
        expression: `
          (() => {
            const sectionText = document.querySelector('header span.animate-pulse')?.parentElement?.innerText || '';
            const litPins = Array.from(document.querySelectorAll('header div[title^="PIN D"]'))
              .filter(el => el.style.backgroundColor && el.style.backgroundColor !== 'transparent').length;
            return { sectionText, litPins };
          })()
        `,
        returnByValue: true,
      });
      console.log(`  Scroll ${(p * 100).toFixed(0)}%: Section="${navState.result.value.sectionText.trim()}", Lit Pins=${navState.result.value.litPins}/14`);
    }

    fs.writeFileSync(path.join(OUT_DIR, 'audit-summary.json'), JSON.stringify(auditResults, null, 2));
    console.log('\nAudit completed successfully. Summary saved to audit-summary.json');
  } catch (err) {
    console.error('Audit execution error:', err);
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
}

runAudit();
