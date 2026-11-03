import fs from 'fs';

const filePath = 'e:\\Code_projects\\Comcamp-site\\frontend\\src\\components\\Rev25Stage3D.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add THREE.Cache.enabled = true
content = content.replace(
  "import * as THREE from 'three';",
  "import * as THREE from 'three';\n\n// Enable Three.js native memory cache for zero-redundancy model sharing\nTHREE.Cache.enabled = true;"
);

// 2. Remove artificial timer from BlenderEsp
const oldBlenderEsp = `const BlenderEsp: React.FC = () => {
  const [loadModel, setLoadModel] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoadModel(true);
    }, 350);
    return () => clearTimeout(timer);
  }, []);

  if (!loadModel) {
    return <ProceduralEsp />;
  }

  return (
    <Suspense fallback={<ProceduralEsp />}>
      <BlenderEspLoaded />
    </Suspense>
  );
};`;

const newBlenderEsp = `// Real concurrent streaming: load ESP8266 simultaneously with Arduino UNO
const BlenderEsp: React.FC = () => {
  return (
    <Suspense fallback={<ProceduralEsp />}>
      <BlenderEspLoaded />
    </Suspense>
  );
};`;

content = content.replace(oldBlenderEsp, newBlenderEsp);

// 3. Add onStageReady to StageRigProps
content = content.replace(
  '  viewportOffsetY: number;\n  onHotspotsCalculated: (data: ScreenProjectionData) => void;\n}',
  '  viewportOffsetY: number;\n  onHotspotsCalculated: (data: ScreenProjectionData) => void;\n  onStageReady?: () => void;\n}'
);

// 4. In StageRig destructuring, add onStageReady
content = content.replace(
  '  viewportOffsetY,\n  onHotspotsCalculated,\n}) => {',
  '  viewportOffsetY,\n  onHotspotsCalculated,\n  onStageReady,\n}) => {\n  const stageReadyFiredRef = useRef(false);'
);

// 5. In useFrame, trigger onStageReady on first frame
content = content.replace(
  '  useFrame((state, delta) => {\n    const time = state.clock.getElapsedTime();',
  '  useFrame((state, delta) => {\n    if (!stageReadyFiredRef.current) {\n      stageReadyFiredRef.current = true;\n      if (onStageReady) onStageReady();\n    }\n    const time = state.clock.getElapsedTime();'
);

// 6. In Rev25Stage3DProps, add onStageReady
content = content.replace(
  '  wifiLedToggled: boolean;\n  isDark: boolean;\n}',
  '  wifiLedToggled: boolean;\n  isDark: boolean;\n  onStageReady?: () => void;\n}'
);

// 7. In Rev25Stage3D destructuring, add onStageReady
content = content.replace(
  '  wifiLedToggled,\n  isDark,\n}) => {',
  '  wifiLedToggled,\n  isDark,\n  onStageReady,\n}) => {'
);

// 8. Pass onStageReady to StageRig
content = content.replace(
  '          viewportOffsetY={viewportOffsetY}\n          onHotspotsCalculated={handleHotspots}\n        />',
  '          viewportOffsetY={viewportOffsetY}\n          onHotspotsCalculated={handleHotspots}\n          onStageReady={onStageReady}\n        />'
);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully updated Rev25Stage3D.tsx with onStageReady & concurrent streaming!');
