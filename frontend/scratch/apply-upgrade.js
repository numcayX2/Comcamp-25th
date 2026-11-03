import fs from 'fs';

const targets = [
  {
    src: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_global.css',
    dest: 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\styles\\global.css'
  },
  {
    src: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_Rev25Stage3D.tsx',
    dest: 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\Rev25Stage3D.tsx'
  },
  {
    src: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\upgraded_MainLandingPage.tsx',
    dest: 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\MainLandingPage.tsx'
  }
];

targets.forEach(({ src, dest }) => {
  const content = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(dest, content, 'utf8');
  console.log(`Copied ${src} -> ${dest} (${content.length} bytes)`);
});
