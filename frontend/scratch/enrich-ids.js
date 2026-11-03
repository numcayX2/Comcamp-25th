import fs from 'fs';

const filePath = 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\MainLandingPage.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add id="btn-wifi-toggle"
content = content.replace(
  'onClick={() => setWifiLedToggled((prev) => !prev)}\n                      className="w-full py-3 px-4 min-h-[48px]',
  'id="btn-wifi-toggle"\n                      aria-label="Toggle ESP8266 Wi-Fi LED"\n                      onClick={() => setWifiLedToggled((prev) => !prev)}\n                      className="w-full py-3 px-4 min-h-[48px]'
);

// 2. Add id={`spec-row-${row.id}`}
content = content.replace(
  'key={row.id}\n                        onMouseEnter={() => setSpecHoveredRow(row.id)}',
  'key={row.id}\n                        id={`spec-row-${row.id}`}\n                        onMouseEnter={() => setSpecHoveredRow(row.id)}'
);

// 3. Add id={`compat-pin-${idx}`}
content = content.replace(
  'key={pin.pin}\n                    type="button"\n                    onClick={() => setSelectedAnalogPin(idx)}',
  'key={pin.pin}\n                    id={`compat-pin-${idx}`}\n                    aria-label={`Select analog channel ${pin.pin} for ${pin.level}`}\n                    type="button"\n                    onClick={() => setSelectedAnalogPin(idx)}'
);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully enriched MainLandingPage with test/accessibility IDs!');
