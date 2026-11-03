import fs from 'fs';

const filePath = 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\MainLandingPage.tsx';
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(
  '<a href="#thesis" className="text-sm rm-text-blue font-mono font-medium hover:underline py-1">',
  '<a href="#thesis" className="text-sm rm-text-blue font-mono font-medium hover:underline py-2 min-h-[44px] inline-flex items-center">'
);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed #thesis link touch target to min-h-[44px]');
