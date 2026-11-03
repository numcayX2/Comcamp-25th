import fs from 'fs';

const targets = [
  {
    src: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_global.css',
    dest: 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\styles\\global.css'
  },
  {
    src: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_Rev25Stage3D.tsx',
    dest: 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\Rev25Stage3D.tsx'
  },
  {
    src: 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_MainLandingPage.tsx',
    dest: 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\MainLandingPage.tsx'
  }
];

targets.forEach(({ src, dest }) => {
  const content = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(dest, content, 'utf8');
  console.log(`Successfully updated ${dest} (${content.length} bytes)`);
});
