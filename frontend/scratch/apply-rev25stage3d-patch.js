import fs from 'fs';

const filePath = 'src/components/Rev25Stage3D.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// Normalize line endings to LF for consistent matching
const isCRLF = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 1. BlenderEsp concurrent loading
const oldBlenderEspRegex = /const BlenderEsp: React\.FC = \(\) => \{[\s\S]*?return \(\n\s*<Suspense fallback=\{<ProceduralEsp \/>\}>\n\s*<BlenderEspLoaded \/>\n\s*<\/Suspense>\n\s*\);\n\};/;
const newBlenderEsp = `// Real concurrent streaming: load ESP8266 simultaneously with Arduino UNO
const BlenderEsp: React.FC = () => {
  return (
    <Suspense fallback={<ProceduralEsp />}>
      <BlenderEspLoaded />
    </Suspense>
  );
};`;

if (oldBlenderEspRegex.test(content)) {
  content = content.replace(oldBlenderEspRegex, newBlenderEsp);
  console.log('Updated BlenderEsp');
} else {
  console.log('BlenderEsp not matched');
}

// 2. StageRigProps
content = content.replace(
  '  onHotspotsCalculated: (data: ScreenProjectionData) => void;',
  '  onHotspotsCalculated: (data: ScreenProjectionData) => void;\n  onStageReady?: () => void;'
);

// 3. StageRig destructuring
content = content.replace(
  '  onHotspotsCalculated,\n}) => {',
  '  onHotspotsCalculated,\n  onStageReady,\n}) => {\n  const stageReadyFiredRef = useRef(false);'
);

// 4. useFrame onStageReady
content = content.replace(
  '  useFrame((state, delta) => {\n    const time = state.clock.getElapsedTime();',
  '  useFrame((state, delta) => {\n    if (!stageReadyFiredRef.current) {\n      stageReadyFiredRef.current = true;\n      if (onStageReady) onStageReady();\n    }\n    const time = state.clock.getElapsedTime();'
);

// 5. Rev25Stage3DProps
content = content.replace(
  '  isDark: boolean;\n}',
  '  isDark: boolean;\n  onStageReady?: () => void;\n}'
);

// 6. Rev25Stage3D destructuring
content = content.replace(
  '  isDark,\n}) => {',
  '  isDark,\n  onStageReady,\n}) => {'
);

// 7. StageRig invocation
content = content.replace(
  '          onHotspotsCalculated={handleHotspots}\n        />',
  '          onHotspotsCalculated={handleHotspots}\n          onStageReady={onStageReady}\n        />'
);

if (isCRLF) {
  content = content.replace(/\n/g, '\r\n');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Rev25Stage3D.tsx updated successfully!');
