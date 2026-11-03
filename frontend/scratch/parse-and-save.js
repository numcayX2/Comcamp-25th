import fs from 'fs';

const raw = fs.readFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\line261_raw.txt', 'utf8');

const codeBlockRegex = /```([a-zA-Z0-9_\-\.]*)\r?\n([\s\S]*?)```/g;
let match;
let blocks = [];
while ((match = codeBlockRegex.exec(raw)) !== null) {
  blocks.push({
    lang: match[1],
    code: match[2],
    index: match.index
  });
}

console.log(`Found ${blocks.length} blocks.`);

// Inspect context before block 1
console.log('--- Context before Block 1 ---');
console.log(raw.slice(Math.max(0, blocks[0].index - 300), blocks[0].index));

// Inspect context before block 2
console.log('--- Context before Block 2 ---');
console.log(raw.slice(Math.max(0, blocks[1].index - 300), blocks[1].index));

// Inspect context before block 3
console.log('--- Context before Block 3 ---');
console.log(raw.slice(Math.max(0, blocks[2].index - 300), blocks[2].index));

// Save them to scratch files first
fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_global.css', blocks[0].code);
fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_Rev25Stage3D.tsx', blocks[1].code);
fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_MainLandingPage.tsx', blocks[2].code);

console.log('Saved 3 upgraded files to scratch directory.');
