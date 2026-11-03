import fs from 'fs';

const raw = fs.readFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\line261_raw.txt', 'utf8');

// Find all code blocks and their filenames/headers
const lines = raw.split('\n');
console.log('Total lines in raw text:', lines.length);

// Search for markdown code fences and mentions of the 3 target files
lines.forEach((line, idx) => {
  if (line.includes('global.css') || line.includes('Rev25Stage3D.tsx') || line.includes('MainLandingPage.tsx') || line.startsWith('```')) {
    if (idx < 500 || idx > lines.length - 200 || line.includes('```')) {
      // print interesting lines
      // console.log(`Line ${idx + 1}: ${line.slice(0, 80)}`);
    }
  }
});

// Let's find code block boundaries
const codeBlockRegex = /```([a-zA-Z0-9_\-\.]*)\r?\n([\s\S]*?)```/g;
let match;
let count = 0;
while ((match = codeBlockRegex.exec(raw)) !== null) {
  count++;
  const lang = match[1];
  const code = match[2];
  const firstFewLines = code.split('\n').slice(0, 5).join(' ');
  console.log(`Code block ${count}: lang=${lang}, length=${code.length}, preview: ${firstFewLines.slice(0, 100)}`);
}
