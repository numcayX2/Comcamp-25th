import fs from 'fs';

const files = [
  { name: 'lh100_global.css', path: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_global.css' },
  { name: 'lh100_Rev25Stage3D.tsx', path: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_Rev25Stage3D.tsx' },
  { name: 'lh100_MainLandingPage.tsx', path: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_MainLandingPage.tsx' }
];

files.forEach(({ name, path }) => {
  const content = fs.readFileSync(path, 'utf8');
  console.log(`\n=== Checking ${name} (length: ${content.length}) ===`);
  const mdLinkMatches = content.match(/\[([^\]]+)\]\(([^)]+)\)/g);
  if (mdLinkMatches) {
    console.warn(`Found potential markdown links in ${name}:`, mdLinkMatches.slice(0, 10));
  } else {
    console.log('No markdown links found. Clean!');
  }
  const lines = content.split('\n');
  console.log(`Total lines: ${lines.length}`);
  console.log(`First line: ${lines[0]}`);
  console.log(`Last line: ${lines[lines.length - 1]}`);
});
