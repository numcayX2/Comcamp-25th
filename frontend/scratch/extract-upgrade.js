import fs from 'fs';
import readline from 'readline';

const TRANSCRIPT_PATH = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\d1d6e90d-4d8d-4790-8d3f-262378615871\\.system_generated\\logs\\transcript_full.jsonl';

async function extract() {
  const fileStream = fs.createReadStream(TRANSCRIPT_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineCount = 0;
  for await (const line of rl) {
    lineCount++;
    if (lineCount === 261) {
      console.log('Found line 261!');
      const data = JSON.parse(line);
      console.log('step_index:', data.step_index);
      console.log('type:', data.type);
      console.log('source:', data.source);
      console.log('content length:', data.content ? data.content.length : 0);
      
      const content = data.content;
      fs.writeFileSync('e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\line261_raw.txt', content);
      console.log('Wrote raw content to scratch/line261_raw.txt');
      break;
    }
  }
}

extract().catch(console.error);
