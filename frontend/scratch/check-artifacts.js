import fs from 'fs';

const files = [
  { name: 'global.css', path: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_global.css' },
  { name: 'Rev25Stage3D.tsx', path: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_Rev25Stage3D.tsx' },
  { name: 'MainLandingPage.tsx', path: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_MainLandingPage.tsx' },
];

files.forEach(({ name, path }) => {
  const content = fs.readFileSync(path, 'utf8');
  console.log(`\n=== Checking ${name} (length: ${content.length}) ===`);
  
  // Check for markdown links: [foo](bar)
  const mdLinkMatches = content.match(/\[([^\]]+)\]\(([^)]+)\)/g);
  if (mdLinkMatches) {
    console.warn(`Found potential markdown links in ${name}:`, mdLinkMatches.slice(0, 10));
  } else {
    console.log('No markdown links found. Clean!');
  }

  // Check for unclosed template literals or strings if obvious
  // Check for duplicate imports or undefined vars
  const lines = content.split('\n');
  console.log(`Total lines: ${lines.length}`);
  console.log(`First line: ${lines[0]}`);
  console.log(`Last line: ${lines[lines.length - 1]}`);
});
