import fs from 'fs';

const src = 'e:\\Code_projects\\Comcamp-site\\frontend\\scratch\\lh100_Rev25Stage3D.tsx';
const dest = 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\Rev25Stage3D.tsx';

const content = fs.readFileSync(src, 'utf8');
fs.writeFileSync(dest, content, 'utf8');
console.log(`Fixed: Successfully updated ${dest} (${content.length} bytes)`);

// Delete accidental file if created
if (fs.existsSync('e:\\Code_projects\\Comcamp-site\\frontend\\src\\componentsRev25Stage3D.tsx')) {
  fs.unlinkSync('e:\\Code_projects\\Comcamp-site\\frontend\\src\\componentsRev25Stage3D.tsx');
  console.log('Cleaned up accidental componentsRev25Stage3D.tsx');
}
