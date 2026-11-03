import fs from 'fs';
import readline from 'readline';

const TRANSCRIPT_PATH = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\d1d6e90d-4d8d-4790-8d3f-262378615871\\.system_generated\\logs\\transcript_full.jsonl';

async function extractLastUserInput() {
  const fileStream = fs.createReadStream(TRANSCRIPT_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const userInputs = [];
  let lineCount = 0;
  for await (const line of rl) {
    lineCount++;
    try {
      const data = JSON.parse(line);
      if (data.type === 'USER_INPUT') {
        userInputs.push({ lineNum: lineCount, step_index: data.step_index, content: data.content });
      }
    } catch (e) {}
  }
  console.log('Total user inputs:', userInputs.length);

  const lastUser = userInputs[userInputs.length - 1];
  console.log(`Last USER_INPUT at line ${lastUser.lineNum}, step_index ${lastUser.step_index}, length: ${lastUser.content.length}`);

  fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\last_user_message_raw.txt', lastUser.content);
  console.log('Saved to scratch/last_user_message_raw.txt');

  const codeBlockRegex = /```([a-zA-Z0-9_\-\.]*)\r?\n([\s\S]*?)```/g;
  let match;
  let blocks = [];
  while ((match = codeBlockRegex.exec(lastUser.content)) !== null) {
    blocks.push({
      lang: match[1],
      code: match[2],
      index: match.index
    });
  }

  console.log(`Found ${blocks.length} code blocks in last user message.`);
  blocks.forEach((b, idx) => {
    const preview = b.code.slice(0, 100).replace(/\r?\n/g, ' ');
    console.log(`Block ${idx + 1}: lang=${b.lang}, length=${b.code.length}, preview: ${preview}`);
  });

  if (blocks.length >= 3) {
    fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_global.css', blocks[0].code);
    fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_Rev25Stage3D.tsx', blocks[1].code);
    fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_MainLandingPage.tsx', blocks[2].code);
    console.log('Saved lh100_global.css, lh100_Rev25Stage3D.tsx, lh100_MainLandingPage.tsx');
  }
}

extractLastUserInput().catch(console.error);
