import fs from 'fs';

const filePath = 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\styles\\global.css';
let content = fs.readFileSync(filePath, 'utf8');

const kineticCss = `
/* Kinetic Web Intro Loader Curtain */
.rm-kinetic-loader {
  transition: transform 650ms cubic-bezier(0.22, 1, 0.36, 1), opacity 400ms ease;
  will-change: transform;
}

.rm-kinetic-loader.revealed {
  transform: translateY(-100%);
  pointer-events: none;
}
`;

if (!content.includes('rm-kinetic-loader')) {
  content += kineticCss;
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Appended kinetic loader styles to global.css');
} else {
  console.log('Already contains kinetic loader styles');
}
