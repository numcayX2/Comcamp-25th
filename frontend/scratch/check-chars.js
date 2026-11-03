import fs from 'fs';

const fileContent = fs.readFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_MainLandingPage.tsx', 'utf8');

const lines = fileContent.split('\n');
console.log('Line 903:', lines[902]);
console.log('Line 904:', lines[903]);
console.log('Line 1109:', lines[1108]);
console.log('Line 1110:', lines[1109]);

// Let's inspect character codes of line 903
for (let i = 0; i < lines[902].length; i++) {
  const ch = lines[902][i];
  const code = ch.charCodeAt(0);
  if (code > 127) {
    console.log(`Char ${i}: "${ch}" (U+${code.toString(16)})`);
  }
}
