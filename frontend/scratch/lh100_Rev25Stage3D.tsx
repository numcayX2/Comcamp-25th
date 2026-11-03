import React, { Suspense, useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree, useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';

const ARDUINO_R3_MODEL = '/models/ArduinoR3.glb?v=20261102';
const ESP8266_MODEL = '/models/esp8266.glb?v=20261102';

// 7 Hotspot local coordinates & dedicated camera inspection angles on centered normalized boards
export const UNO_HOTSPOTS_3D = [
  { id: 'usb', name: 'USB-B', pos: new THREE.Vector3(-1.36, 0.28, -1.05), rot: [0.62, 0.28, -0.06] },
  { id: 'mcu', name: 'ATMEGA328P', pos: new THREE.Vector3(0.22, 0.25, -0.30), rot: [0.72, -0.18, 0.04] },
  { id: 'digital', name: 'DIGITAL 0–13', pos: new THREE.Vector3(-0.43, 0.24, -1.55), rot: [0.58, -0.05, 0.02] },
  { id: 'pwm', name: '~PWM', pos: new THREE.Vector3(0.2, 0.24, -1.55), rot: [0.60, -0.22, 0.05] },
  { id: 'analog', name: 'ANALOG IN A0–A5', pos: new THREE.Vector3(0.4, 0.24, 1.35), rot: [0.48, -0.28, 0.08] },
  { id: 'power', name: 'POWER 5V/3.3V/GND', pos: new THREE.Vector3(-0.5, 0.24, 1.35), rot: [0.48, 0.16, -0.04] },
  { id: 'led-l', name: 'LED "L" (PIN D13)', pos: new THREE.Vector3(-0.75, 0.22, -1.0), rot: [0.78, 0.08, 0.0] },
];

export const ESP_HOTSPOTS_3D = [
  { id: 'rf-module', name: 'ESP-12E RF MODULE', pos: new THREE.Vector3(-0.65, 0.21, -0.54), rot: [0.68, 0.22, -0.05] },
  { id: 'antenna', name: 'PCB ANTENNA', pos: new THREE.Vector3(-0.94, 0.13, -0.22), rot: [0.76, 0.35, -0.08] },
  { id: 'usb-uart', name: 'MICRO-USB + UART', pos: new THREE.Vector3(0.66, 0.19, -0.54), rot: [0.56, -0.25, 0.06] },
  { id: 'gpio', name: 'GPIO D0–D8', pos: new THREE.Vector3(0.0, 0.15, -1.1), rot: [0.62, 0.12, -0.03] },
  { id: 'analog-a0', name: 'ANALOG PIN A0', pos: new THREE.Vector3(-0.5, 0.15, 0.8), rot: [0.52, 0.28, -0.06] },
  { id: 'keys', name: 'FLASH / RST KEYS', pos: new THREE.Vector3(0.55, 0.18, 0.4), rot: [0.58, -0.18, 0.04] },
  { id: 'led', name: 'ONBOARD LED', pos: new THREE.Vector3(-0.3, 0.22, 0.1), rot: [0.80, 0.10, -0.02] },
];

const SPEC_ROW_TO_HOTSPOT: Record<string, { uno: number; esp: number }> = {
  mcu: { uno: 1, esp: 0 },
  clock: { uno: 1, esp: 0 },
  voltage: { uno: 5, esp: 3 },
  gpio: { uno: 2, esp: 3 },
  analog: { uno: 4, esp: 4 },
  flash: { uno: 1, esp: 0 },
  conn: { uno: 0, esp: 1 },
  dims: { uno: 2, esp: 3 },
};

// Lightweight procedural boards rendered immediately before GLB meshes finish parsing
const ProceduralUno: React.FC = () => (
  <group>
    <mesh>
      <boxGeometry args={[3.6, 0.12, 2.7]} />
      <meshStandardMaterial color="#008184" roughness={0.42} metalness={0.18} />
    </mesh>
    <mesh position={[0.22, 0.15, -0.3]}>
      <boxGeometry args={[1.6, 0.18, 0.55]} />
      <meshStandardMaterial color="#1a1c22" roughness={0.55} />
    </mesh>
    <mesh position={[-1.36, 0.22, -1.05]}>
      <boxGeometry args={[0.7, 0.45, 0.65]} />
      <meshStandardMaterial color="#c0c4cc" metalness={0.92} roughness={0.22} />
    </mesh>
  </group>
);

const ProceduralEsp: React.FC = () => (
  <group>
    <mesh>
      <boxGeometry args={[2.57, 0.1, 1.35]} />
      <meshStandardMaterial color="#141820" roughness={0.48} metalness={0.24} />
    </mesh>
    <mesh position={[-0.65, 0.14, -0.54]}>
      <boxGeometry args={[1.0, 0.2, 0.9]} />
      <meshStandardMaterial color="#b2b8c2" metalness={0.88} roughness={0.2} />
    </mesh>
    <mesh position={[-0.94, 0.08, -0.22]}>
      <boxGeometry args={[0.4, 0.02, 1.0]} />
      <meshStandardMaterial color="#d4991e" metalness={0.75} roughness={0.28} />
    </mesh>
  </group>
);

// Zero-Drei Native GLTF Loader + Direct Box3 Centering for Arduino UNO R3
const BlenderUno: React.FC = () => {
  const gltf = useLoader(GLTFLoader, ARDUINO_R3_MODEL);

  const { centeredScene, scale } = useMemo(() => {
    const cloned = gltf.scene.clone(true);
    cloned.traverse((obj) => {
      const name = obj.name.toLowerCase();
      if (name.includes('backdrop') || name.includes('plane') || name.includes('floor')) {
        obj.visible = false;
      }
    });
    const box = new THREE.Box3().setFromObject(cloned);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    cloned.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    return {
      centeredScene: cloned,
      scale: maxDim > 0 ? 3.6 / maxDim : 1,
    };
  }, [gltf]);

  return (
    <group scale={scale}>
      <primitive object={centeredScene} />
    </group>
  );
};

// Zero-Drei Native GLTF Loader + Direct Box3 Centering for ESP8266 NodeMCU
const BlenderEspLoaded: React.FC = () => {
  const gltf = useLoader(GLTFLoader, ESP8266_MODEL);

  const { centeredScene, scale } = useMemo(() => {
    const cloned = gltf.scene.clone(true);
    cloned.traverse((obj) => {
      const name = obj.name.toLowerCase();
      if (name.includes('backdrop') || name.includes('plane') || name.includes('floor')) {
        obj.visible = false;
      }
    });
    const box = new THREE.Box3().setFromObject(cloned);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    cloned.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    return {
      centeredScene: cloned,
      scale: maxDim > 0 ? 2.57 / maxDim : 1,
    };
  }, [gltf]);

  return (
    <group scale={scale}>
      <primitive object={centeredScene} />
    </group>
  );
};

const BlenderEsp: React.FC = () => {
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
};

export interface ScreenProjectionData {
  unoHotspot: { x: number; y: number } | null;
  espHotspot: { x: number; y: number } | null;
  unoD13: { x: number; y: number } | null;
  espAntenna: { x: number; y: number } | null;
  unoCenter: { x: number; y: number } | null;
  espCenter: { x: number; y: number } | null;
  unoLeftEdge: { x: number; y: number } | null;
  unoRightEdge: { x: number; y: number } | null;
  espLeftEdge: { x: number; y: number } | null;
  espRightEdge: { x: number; y: number } | null;
}

interface StageRigProps {
  activeSection: string;
  scrollProgress: number;
  unoHotspotIndex: number;
  espHotspotIndex: number;
  specHoveredRow: string | null;
  primaryCtaHovered: boolean;
  secondaryCtaHovered: boolean;
  unoWiredLedToggled: boolean;
  wifiLedToggled: boolean;
  isDesktop: boolean;
  isDark: boolean;
  viewportOffsetY: number;
  onHotspotsCalculated: (data: ScreenProjectionData) => void;
}

const StageRig: React.FC<StageRigProps> = ({
  activeSection,
  scrollProgress,
  unoHotspotIndex,
  espHotspotIndex,
  specHoveredRow,
  primaryCtaHovered,
  secondaryCtaHovered,
  unoWiredLedToggled,
  wifiLedToggled,
  isDesktop,
  isDark,
  viewportOffsetY,
  onHotspotsCalculated,
}) => {
  const { camera, size, mouse } = useThree();
  const unoGroupRef = useRef<THREE.Group>(null);
  const espGroupRef = useRef<THREE.Group>(null);

  const unoLedOnRef = useRef<THREE.Mesh>(null);
  const unoLedLRef = useRef<THREE.Mesh>(null);
  const espLedRef = useRef<THREE.Mesh>(null);
  const beaconUnoRef = useRef<THREE.Group>(null);
  const beaconEspRef = useRef<THREE.Group>(null);

  const tempVec = useMemo(() => new THREE.Vector3(), []);
  const worldPos = useMemo(() => new THREE.Vector3(), []);
  const targetUnoPos = useMemo(() => new THREE.Vector3(), []);
  const targetUnoRot = useMemo(() => new THREE.Euler(), []);
  const targetEspPos = useMemo(() => new THREE.Vector3(), []);
  const targetEspRot = useMemo(() => new THREE.Euler(), []);
  const lastBroadcastRef = useRef<ScreenProjectionData | null>(null);

  useFrame((state, delta) => {
    const time = state.clock.getElapsedTime();
    const safeDelta = Math.min(delta, 0.1);
    const posLambda = 6.5;
    const rotLambda = 7.5;

    if (!unoGroupRef.current || !espGroupRef.current) return;

    let targetUnoScale = 1.0;
    let targetEspScale = 1.0;

    const worldYShift = THREE.MathUtils.clamp(viewportOffsetY * -3.6, -1.6, 1.6);

    switch (activeSection) {
      case 'hero': {
        targetUnoPos.set(isDesktop ? 2.25 : 0.55, isDesktop ? 0.25 : 0.78, isDesktop ? -0.35 : -0.8);
        targetUnoRot.set(0.22 + mouse.y * 0.07, -0.18 + mouse.x * 0.08, 0.04);
        targetUnoScale = isDesktop ? 1.32 : 0.92;

        targetEspPos.set(isDesktop ? 1.10 : 0.08, isDesktop ? -0.92 : -1.15, 0.75);
        targetEspRot.set(0.58 + mouse.y * 0.06, 0.42 + mouse.x * 0.06, -0.14);
        targetEspScale = isDesktop ? 1.15 : 0.84;
        break;
      }

      case 'thesis': {
        const subtleRoll = (scrollProgress - 0.15) * 0.25;
        targetUnoPos.set(isDesktop ? -0.15 : 0, 0.32 + worldYShift * 0.5, 0.2);
        targetUnoRot.set(Math.PI / 2 - 0.04, subtleRoll, 0);
        targetUnoScale = isDesktop ? 1.18 : 0.88;

        targetEspPos.set(isDesktop ? 0.15 : 0, -0.32 + worldYShift * 0.5, 0.2);
        targetEspRot.set(Math.PI / 2 + 0.04, -subtleRoll, 0);
        targetEspScale = isDesktop ? 1.18 : 0.88;
        break;
      }

      case 'board-uno': {
        const activeHp = UNO_HOTSPOTS_3D[unoHotspotIndex] || UNO_HOTSPOTS_3D[0];
        const macroZoom = unoHotspotIndex === 6 || unoHotspotIndex === 1 ? 1.56 : 1.46;
        targetUnoPos.set(
          isDesktop ? 1.82 - activeHp.pos.x * 0.14 : 0,
          (isDesktop ? 0.06 : 0.72) + worldYShift * 0.65,
          isDesktop ? 0.35 : 0
        );
        targetUnoRot.set(
          activeHp.rot[0] + mouse.y * 0.04,
          activeHp.rot[1] + mouse.x * 0.04,
          activeHp.rot[2]
        );
        targetUnoScale = isDesktop ? macroZoom : 1.04;

        targetEspPos.set(-7.5, -1, -3);
        targetEspRot.set(0.4, 0.4, 0);
        targetEspScale = 0.001;
        break;
      }

      case 'bridge': {
        targetUnoPos.set(isDesktop ? -2.25 : -1.25, 0.08 + worldYShift * 0.4, 0);
        targetUnoRot.set(0.42 + mouse.y * 0.04, 0.26, -0.04);
        targetUnoScale = isDesktop ? 1.12 : 0.82;

        targetEspPos.set(isDesktop ? 2.25 : 1.25, 0.08 + worldYShift * 0.4, 0);
        targetEspRot.set(0.42 + mouse.y * 0.04, -0.26, 0.04);
        targetEspScale = isDesktop ? 1.18 : 0.86;
        break;
      }

      case 'board-esp': {
        const activeEspHp = ESP_HOTSPOTS_3D[espHotspotIndex] || ESP_HOTSPOTS_3D[0];
        const espMacroZoom = espHotspotIndex === 6 || espHotspotIndex === 1 ? 1.62 : 1.52;
        targetEspPos.set(
          isDesktop ? -1.82 - activeEspHp.pos.x * 0.14 : 0,
          (isDesktop ? 0.06 : 0.72) + worldYShift * 0.65,
          isDesktop ? 0.4 : 0
        );
        targetEspRot.set(
          activeEspHp.rot[0] + mouse.y * 0.04,
          activeEspHp.rot[1] + mouse.x * 0.04,
          activeEspHp.rot[2]
        );
        targetEspScale = isDesktop ? espMacroZoom : 1.06;

        targetUnoPos.set(isDesktop ? 4.6 : 5.5, 0.2, -3.2);
        targetUnoRot.set(0.32, -0.35, 0);
        targetUnoScale = isDesktop ? 0.72 : 0.4;
        break;
      }

      case 'spec': {
        const isRowHovered = Boolean(specHoveredRow);
        const tiltX = isRowHovered ? 1.18 : 1.38;
        targetUnoPos.set(isDesktop ? -1.75 : -0.95, (isDesktop ? 0.62 : 0.75) + worldYShift * 0.55, 0);
        targetUnoRot.set(tiltX, 0, 0);
        targetUnoScale = isDesktop ? 1.08 : 0.76;

        targetEspPos.set(isDesktop ? 1.75 : 0.95, (isDesktop ? 0.62 : 0.75) + worldYShift * 0.55, 0);
        targetEspRot.set(tiltX, 0, 0);
        targetEspScale = isDesktop ? 1.08 : 0.76;
        break;
      }

      case 'path':
      case 'compatibility': {
        targetUnoPos.set(isDesktop ? -4.4 : -3.6, 0.1, -2.2);
        targetUnoRot.set(0.28, 0.38, 0);
        targetUnoScale = 0.68;

        targetEspPos.set(isDesktop ? 4.4 : 3.6, 0.1, -2.2);
        targetEspRot.set(0.28, -0.38, 0);
        targetEspScale = 0.68;
        break;
      }

      case 'power-on': {
        targetUnoPos.set(isDesktop ? -1.35 : -0.85, 0.82, 0.1);
        targetUnoRot.set(0.22 + mouse.y * 0.05, 0.12 + mouse.x * 0.05, -0.02);
        targetUnoScale = isDesktop ? 1.14 : 0.82;

        targetEspPos.set(isDesktop ? 1.35 : 0.85, 0.82, 0.1);
        targetEspRot.set(0.22 + mouse.y * 0.05, -0.12 + mouse.x * 0.05, 0.02);
        targetEspScale = isDesktop ? 1.08 : 0.78;
        break;
      }

      case 'colophon':
      default: {
        targetUnoPos.set(0, 5.2, -2);
        targetUnoScale = 0.001;
        targetEspPos.set(0, 5.2, -2);
        targetEspScale = 0.001;
        break;
      }
    }

    if (activeSection === 'hero' || activeSection === 'power-on') {
      targetUnoPos.y += Math.sin(time * 1.1) * 0.022;
      targetEspPos.y += Math.sin(time * 1.1 + 1.4) * 0.022;
    }

    unoGroupRef.current.position.x = THREE.MathUtils.damp(unoGroupRef.current.position.x, targetUnoPos.x, posLambda, safeDelta);
    unoGroupRef.current.position.y = THREE.MathUtils.damp(unoGroupRef.current.position.y, targetUnoPos.y, posLambda, safeDelta);
    unoGroupRef.current.position.z = THREE.MathUtils.damp(unoGroupRef.current.position.z, targetUnoPos.z, posLambda, safeDelta);
    unoGroupRef.current.rotation.x = THREE.MathUtils.damp(unoGroupRef.current.rotation.x, targetUnoRot.x, rotLambda, safeDelta);
    unoGroupRef.current.rotation.y = THREE.MathUtils.damp(unoGroupRef.current.rotation.y, targetUnoRot.y, rotLambda, safeDelta);
    unoGroupRef.current.rotation.z = THREE.MathUtils.damp(unoGroupRef.current.rotation.z, targetUnoRot.z, rotLambda, safeDelta);
    const nextUnoScale = THREE.MathUtils.damp(unoGroupRef.current.scale.x, targetUnoScale, posLambda, safeDelta);
    unoGroupRef.current.scale.setScalar(nextUnoScale);

    espGroupRef.current.position.x = THREE.MathUtils.damp(espGroupRef.current.position.x, targetEspPos.x, posLambda, safeDelta);
    espGroupRef.current.position.y = THREE.MathUtils.damp(espGroupRef.current.position.y, targetEspPos.y, posLambda, safeDelta);
    espGroupRef.current.position.z = THREE.MathUtils.damp(espGroupRef.current.position.z, targetEspPos.z, posLambda, safeDelta);
    espGroupRef.current.rotation.x = THREE.MathUtils.damp(espGroupRef.current.rotation.x, targetEspRot.x, rotLambda, safeDelta);
    espGroupRef.current.rotation.y = THREE.MathUtils.damp(espGroupRef.current.rotation.y, targetEspRot.y, rotLambda, safeDelta);
    espGroupRef.current.rotation.z = THREE.MathUtils.damp(espGroupRef.current.rotation.z, targetEspRot.z, rotLambda, safeDelta);
    const nextEspScale = THREE.MathUtils.damp(espGroupRef.current.scale.x, targetEspScale, posLambda, safeDelta);
    espGroupRef.current.scale.setScalar(nextEspScale);

    if (unoLedOnRef.current) {
      const mat = unoLedOnRef.current.material as THREE.MeshBasicMaterial;
      mat.color.set(primaryCtaHovered ? '#00E575' : '#03B800');
    }

    if (unoLedLRef.current) {
      const mat = unoLedLRef.current.material as THREE.MeshBasicMaterial;
      const isAutoBlink = (activeSection === 'board-uno' && unoHotspotIndex === 6) || primaryCtaHovered || activeSection === 'bridge';
      const isLit = unoWiredLedToggled || (isAutoBlink && Math.floor(time * 2.2) % 2 === 0);
      mat.color.set(isLit ? '#337AFF' : '#0A1628');
    }

    if (espLedRef.current) {
      const mat = espLedRef.current.material as THREE.MeshBasicMaterial;
      const isAutoBlink = (activeSection === 'board-esp' && espHotspotIndex === 6) || secondaryCtaHovered || activeSection === 'bridge';
      const isLit = wifiLedToggled || (isAutoBlink && Math.floor(time * 2.2) % 2 === 0);
      mat.color.set(isLit ? '#00B4D8' : '#061A24');
    }

    const mappedSpec = specHoveredRow ? SPEC_ROW_TO_HOTSPOT[specHoveredRow] : null;
    const effectiveUnoIdx = activeSection === 'spec' && mappedSpec ? mappedSpec.uno : unoHotspotIndex;
    const effectiveEspIdx = activeSection === 'spec' && mappedSpec ? mappedSpec.esp : espHotspotIndex;

    if (beaconUnoRef.current) {
      const unoHp = UNO_HOTSPOTS_3D[effectiveUnoIdx] || UNO_HOTSPOTS_3D[0];
      beaconUnoRef.current.position.copy(unoHp.pos);
      beaconUnoRef.current.position.y += 0.12 + Math.sin(time * 4.5) * 0.025;
      beaconUnoRef.current.visible =
        activeSection === 'board-uno' || (activeSection === 'spec' && Boolean(mappedSpec));
    }

    if (beaconEspRef.current) {
      const espHp = ESP_HOTSPOTS_3D[effectiveEspIdx] || ESP_HOTSPOTS_3D[0];
      beaconEspRef.current.position.copy(espHp.pos);
      beaconEspRef.current.position.y += 0.12 + Math.sin(time * 4.5) * 0.025;
      beaconEspRef.current.visible =
        activeSection === 'board-esp' || (activeSection === 'spec' && Boolean(mappedSpec));
    }

    const projectToScreen = (vec3: THREE.Vector3) => {
      tempVec.copy(vec3).project(camera);
      return {
        x: Math.round((tempVec.x * 0.5 + 0.5) * size.width),
        y: Math.round((-tempVec.y * 0.5 + 0.5) * size.height),
      };
    };

    let unoHotspotScreen: { x: number; y: number } | null = null;
    if (unoGroupRef.current && (activeSection === 'board-uno' || (activeSection === 'spec' && mappedSpec))) {
      const activeHp = UNO_HOTSPOTS_3D[effectiveUnoIdx] || UNO_HOTSPOTS_3D[0];
      unoGroupRef.current.localToWorld(worldPos.copy(activeHp.pos));
      unoHotspotScreen = projectToScreen(worldPos);
    }

    let espHotspotScreen: { x: number; y: number } | null = null;
    if (espGroupRef.current && (activeSection === 'board-esp' || (activeSection === 'spec' && mappedSpec))) {
      const activeHp = ESP_HOTSPOTS_3D[effectiveEspIdx] || ESP_HOTSPOTS_3D[0];
      espGroupRef.current.localToWorld(worldPos.copy(activeHp.pos));
      espHotspotScreen = projectToScreen(worldPos);
    }

    let unoD13Screen: { x: number; y: number } | null = null;
    let espAntennaScreen: { x: number; y: number } | null = null;
    if (unoGroupRef.current && activeSection === 'bridge') {
      unoGroupRef.current.localToWorld(worldPos.copy(UNO_HOTSPOTS_3D[6].pos));
      unoD13Screen = projectToScreen(worldPos);
    }
    if (espGroupRef.current && activeSection === 'bridge') {
      espGroupRef.current.localToWorld(worldPos.copy(ESP_HOTSPOTS_3D[1].pos));
      espAntennaScreen = projectToScreen(worldPos);
    }

    let unoCenterScreen: { x: number; y: number } | null = null;
    let espCenterScreen: { x: number; y: number } | null = null;
    let unoLeftEdge: { x: number; y: number } | null = null;
    let unoRightEdge: { x: number; y: number } | null = null;
    let espLeftEdge: { x: number; y: number } | null = null;
    let espRightEdge: { x: number; y: number } | null = null;

    if (unoGroupRef.current && (activeSection === 'hero' || activeSection === 'spec')) {
      unoGroupRef.current.getWorldPosition(worldPos);
      unoCenterScreen = projectToScreen(worldPos);
      unoGroupRef.current.localToWorld(worldPos.set(-1.8, 0, 0));
      unoLeftEdge = projectToScreen(worldPos);
      unoGroupRef.current.localToWorld(worldPos.set(1.8, 0, 0));
      unoRightEdge = projectToScreen(worldPos);
    }

    if (espGroupRef.current && (activeSection === 'hero' || activeSection === 'spec')) {
      espGroupRef.current.getWorldPosition(worldPos);
      espCenterScreen = projectToScreen(worldPos);
      espGroupRef.current.localToWorld(worldPos.set(-1.285, 0, 0));
      espLeftEdge = projectToScreen(worldPos);
      espGroupRef.current.localToWorld(worldPos.set(1.285, 0, 0));
      espRightEdge = projectToScreen(worldPos);
    }

    const nextData: ScreenProjectionData = {
      unoHotspot: unoHotspotScreen,
      espHotspot: espHotspotScreen,
      unoD13: unoD13Screen,
      espAntenna: espAntennaScreen,
      unoCenter: unoCenterScreen,
      espCenter: espCenterScreen,
      unoLeftEdge,
      unoRightEdge,
      espLeftEdge,
      espRightEdge,
    };

    const prev = lastBroadcastRef.current;
    const hasPointChanged = (
      a: { x: number; y: number } | null,
      b: { x: number; y: number } | null
    ) => {
      if (a === null && b === null) return false;
      if (a === null || b === null) return true;
      return Math.abs(a.x - b.x) >= 1 || Math.abs(a.y - b.y) >= 1;
    };

    if (
      !prev ||
      hasPointChanged(prev.unoHotspot, nextData.unoHotspot) ||
      hasPointChanged(prev.espHotspot, nextData.espHotspot) ||
      hasPointChanged(prev.unoD13, nextData.unoD13) ||
      hasPointChanged(prev.espAntenna, nextData.espAntenna) ||
      hasPointChanged(prev.unoCenter, nextData.unoCenter) ||
      hasPointChanged(prev.unoLeftEdge, nextData.unoLeftEdge) ||
      hasPointChanged(prev.espLeftEdge, nextData.espLeftEdge)
    ) {
      lastBroadcastRef.current = nextData;
      onHotspotsCalculated(nextData);
    }
  });

  return (
    <>
      <ambientLight intensity={isDark ? 0.68 : 1.2} color={isDark ? '#D8E2F2' : '#FFFFFC'} />
      <directionalLight
        position={[5, 11, 7]}
        intensity={isDark ? 1.65 : 1.85}
        color={isDark ? '#F1F5F9' : '#FFFFFF'}
      />
      <directionalLight
        position={[-6, -4, 5]}
        intensity={isDark ? 0.75 : 0.65}
        color={isDark ? '#60A5FA' : '#FFFBEB'}
      />
      <pointLight
        position={[-4.5, 2.5, -2.5]}
        intensity={isDark ? 1.4 : 0.35}
        color="#337AFF"
        distance={12}
      />
      <pointLight
        position={[4.5, 2.5, -2.5]}
        intensity={isDark ? 1.6 : 0.35}
        color="#00B4D8"
        distance={12}
      />
      <pointLight position={[0, 4.5, 3.5]} intensity={isDark ? 0.65 : 0.45} color="#FFFFFF" />

      {/* ARDUINO UNO R3 3D GROUP */}
      <group ref={unoGroupRef} position={[2.25, 0.25, -0.35]}>
        <Suspense fallback={<ProceduralUno />}>
          <BlenderUno />
        </Suspense>

        <mesh ref={unoLedOnRef} position={[-1.1, 0.22, -0.2]}>
          <sphereGeometry args={[0.045, 12, 12]} />
          <meshBasicMaterial color="#03B800" />
        </mesh>

        <mesh ref={unoLedLRef} position={[-0.75, 0.22, -1.0]}>
          <boxGeometry args={[0.075, 0.045, 0.075]} />
          <meshBasicMaterial color="#0A1628" />
        </mesh>

        <group ref={beaconUnoRef}>
          <mesh>
            <sphereGeometry args={[0.065, 16, 16]} />
            <meshBasicMaterial color="#337AFF" />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.1, 0.135, 24]} />
            <meshBasicMaterial color="#337AFF" side={THREE.DoubleSide} transparent opacity={0.75} />
          </mesh>
        </group>
      </group>

      {/* ESP8266 NODEMCU 3D GROUP */}
      <group ref={espGroupRef} position={[1.1, -0.92, 0.75]}>
        <Suspense fallback={<ProceduralEsp />}>
          <BlenderEsp />
        </Suspense>

        <mesh ref={espLedRef} position={[-0.3, 0.22, 0.1]}>
          <boxGeometry args={[0.07, 0.04, 0.07]} />
          <meshBasicMaterial color="#061A24" />
        </mesh>

        <group ref={beaconEspRef}>
          <mesh>
            <sphereGeometry args={[0.06, 16, 16]} />
            <meshBasicMaterial color="#00B4D8" />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.095, 0.13, 24]} />
            <meshBasicMaterial color="#00B4D8" side={THREE.DoubleSide} transparent opacity={0.75} />
          </mesh>
        </group>
      </group>
    </>
  );
};

export interface Rev25Stage3DProps {
  activeSection: string;
  scrollProgress: number;
  unoHotspotIndex: number;
  espHotspotIndex: number;
  specHoveredRow: string | null;
  primaryCtaHovered: boolean;
  secondaryCtaHovered: boolean;
  unoWiredLedToggled?: boolean;
  wifiLedToggled: boolean;
  isDark: boolean;
}

export const Rev25Stage3D: React.FC<Rev25Stage3DProps> = ({
  activeSection,
  scrollProgress,
  unoHotspotIndex,
  espHotspotIndex,
  specHoveredRow,
  primaryCtaHovered,
  secondaryCtaHovered,
  unoWiredLedToggled = false,
  wifiLedToggled,
  isDark,
}) => {
  const [mounted, setMounted] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [viewportOffsetY, setViewportOffsetY] = useState(0);
  const [screenCoords, setScreenCoords] = useState<ScreenProjectionData>({
    unoHotspot: null,
    espHotspot: null,
    unoD13: null,
    espAntenna: null,
    unoCenter: null,
    espCenter: null,
    unoLeftEdge: null,
    unoRightEdge: null,
    espLeftEdge: null,
    espRightEdge: null,
  });

  const [domRowUno, setDomRowUno] = useState<{ right: number; top: number; height: number } | null>(null);
  const [domRowEsp, setDomRowEsp] = useState<{ left: number; top: number; height: number } | null>(null);

  useEffect(() => {
    setMounted(true);
    const checkDesktop = () => setIsDesktop(window.innerWidth >= 1024);
    checkDesktop();
    window.addEventListener('resize', checkDesktop);
    return () => window.removeEventListener('resize', checkDesktop);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const updateAnchors = () => {
      const vh = window.innerHeight || 1;
      const viewportIdMap: Record<string, string> = {
        thesis: 'viewport-thesis',
        'board-uno': 'viewport-uno',
        bridge: 'viewport-bridge',
        'board-esp': 'viewport-esp',
        spec: 'viewport-spec',
      };
      const targetViewportId = viewportIdMap[activeSection];
      if (targetViewportId) {
        const vpEl = document.getElementById(targetViewportId);
        if (vpEl) {
          const vpRect = vpEl.getBoundingClientRect();
          const vpCenterY = vpRect.top + vpRect.height / 2;
          const normalizedOffset = (vpCenterY - vh * 0.5) / vh;
          setViewportOffsetY(normalizedOffset);
        }
      } else {
        setViewportOffsetY(0);
      }

      if (activeSection === 'board-uno') {
        const el = document.getElementById(`hotspot-uno-${unoHotspotIndex}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          setDomRowUno({ right: rect.right, top: rect.top, height: rect.height });
        }
      } else {
        setDomRowUno(null);
      }

      if (activeSection === 'board-esp') {
        const el = document.getElementById(`hotspot-esp-${espHotspotIndex}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          setDomRowEsp({ left: rect.left, top: rect.top, height: rect.height });
        }
      } else {
        setDomRowEsp(null);
      }
    };

    updateAnchors();
    window.addEventListener('scroll', updateAnchors, { passive: true });
    window.addEventListener('resize', updateAnchors);
    return () => {
      window.removeEventListener('scroll', updateAnchors);
      window.removeEventListener('resize', updateAnchors);
    };
  }, [mounted, activeSection, unoHotspotIndex, espHotspotIndex]);

  const handleHotspots = useCallback((data: ScreenProjectionData) => {
    setScreenCoords(data);
  }, []);

  if (!mounted) {
    return <div className="fixed inset-0 pointer-events-none z-10" aria-hidden="true" />;
  }

  let unoLeaderPath = '';
  let unoElbowPoint: { x: number; y: number } | null = null;
  if (domRowUno && screenCoords.unoHotspot && isDesktop && activeSection === 'board-uno') {
    const startX = Math.round(domRowUno.right + 10);
    const startY = Math.round(domRowUno.top + domRowUno.height / 2);
    const targetX = Math.round(screenCoords.unoHotspot.x);
    const targetY = Math.round(screenCoords.unoHotspot.y);
    const midX = Math.round(startX + (targetX - startX) * 0.42);
    unoLeaderPath = `M ${startX} ${startY} H ${midX} V ${targetY} H ${targetX}`;
    unoElbowPoint = { x: midX, y: targetY };
  }

  let espLeaderPath = '';
  let espElbowPoint: { x: number; y: number } | null = null;
  if (domRowEsp && screenCoords.espHotspot && isDesktop && activeSection === 'board-esp') {
    const startX = Math.round(domRowEsp.left - 10);
    const startY = Math.round(domRowEsp.top + domRowEsp.height / 2);
    const targetX = Math.round(screenCoords.espHotspot.x);
    const targetY = Math.round(screenCoords.espHotspot.y);
    const midX = Math.round(startX - (startX - targetX) * 0.42);
    espLeaderPath = `M ${startX} ${startY} H ${midX} V ${targetY} H ${targetX}`;
    espElbowPoint = { x: midX, y: targetY };
  }

  let bridgeWirePath = '';
  let bridgeAirPath = '';
  let bridgeEmitterOrigin: { x: number; y: number } | null = null;
  if (activeSection === 'bridge' && screenCoords.unoD13 && screenCoords.espAntenna && isDesktop) {
    const x1 = Math.round(screenCoords.unoD13.x);
    const y1 = Math.round(screenCoords.unoD13.y);
    const x2 = Math.round(screenCoords.espAntenna.x);
    const y2 = Math.round(screenCoords.espAntenna.y);
    const midX = Math.round((x1 + x2) / 2);
    const midY = Math.round((y1 + y2) / 2);

    bridgeWirePath = `M ${x1} ${y1} H ${midX - 64} V ${midY} H ${midX - 28}`;
    bridgeEmitterOrigin = { x: midX - 24, y: midY };
    bridgeAirPath = `M ${midX + 44} ${midY} H ${midX + 84} V ${y2} H ${x2}`;
  }

  return (
    <div className="fixed inset-0 pointer-events-none z-10 overflow-hidden" aria-hidden="true">
      <Canvas
        className="w-full h-full"
        camera={{ position: [0, 0, 7.5], fov: 35 }}
        dpr={isDesktop ? [1, 1.75] : [1, 1.25]}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
        }}
      >
        <StageRig
          activeSection={activeSection}
          scrollProgress={scrollProgress}
          unoHotspotIndex={unoHotspotIndex}
          espHotspotIndex={espHotspotIndex}
          specHoveredRow={specHoveredRow}
          primaryCtaHovered={primaryCtaHovered}
          secondaryCtaHovered={secondaryCtaHovered}
          unoWiredLedToggled={unoWiredLedToggled}
          wifiLedToggled={wifiLedToggled}
          isDesktop={isDesktop}
          isDark={isDark}
          viewportOffsetY={viewportOffsetY}
          onHotspotsCalculated={handleHotspots}
        />
      </Canvas>

      <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" aria-hidden="true">
        {activeSection === 'hero' &&
          screenCoords.unoCenter &&
          screenCoords.unoLeftEdge &&
          screenCoords.unoRightEdge &&
          isDesktop && (
            <g className="transition-opacity duration-300" opacity="0.9">
              {(() => {
                const lx = Math.round(screenCoords.unoLeftEdge.x);
                const rx = Math.round(screenCoords.unoRightEdge.x);
                const cy = Math.round(screenCoords.unoCenter.y - 134);
                const mx = Math.round((lx + rx) / 2);
                return (
                  <>
                    <line x1={lx} y1={cy} x2={rx} y2={cy} stroke="var(--rm-hairline-strong)" strokeWidth="1" />
                    <line x1={lx} y1={cy - 6} x2={lx} y2={cy + 6} stroke="#337AFF" strokeWidth="1.5" />
                    <line x1={rx} y1={cy - 6} x2={rx} y2={cy + 6} stroke="#337AFF" strokeWidth="1.5" />
                    <rect
                      x={mx - 64}
                      y={cy - 9}
                      width="128"
                      height="18"
                      fill="var(--rm-paper)"
                      stroke="var(--rm-hairline)"
                      strokeWidth="1"
                    />
                    <text
                      x={mx}
                      y={cy + 4}
                      textAnchor="middle"
                      className="font-mono text-[10px] fill-[var(--rm-ink)] tracking-wider"
                    >
                      68.6 mm · SCALE 1:1
                    </text>
                  </>
                );
              })()}
            </g>
          )}

        {activeSection === 'board-uno' && unoLeaderPath && screenCoords.unoHotspot && (
          <g className="transition-opacity duration-200">
            <path
              d={unoLeaderPath}
              fill="none"
              stroke="#337AFF"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
            {unoElbowPoint && (
              <>
                <rect
                  x={unoElbowPoint.x - 2.5}
                  y={unoElbowPoint.y - 2.5}
                  width="5"
                  height="5"
                  fill="var(--rm-paper)"
                  stroke="#337AFF"
                  strokeWidth="1.5"
                />
                <text
                  x={unoElbowPoint.x + 6}
                  y={unoElbowPoint.y - 6}
                  className="font-mono text-[9px] fill-[#337AFF] tracking-wider"
                >
                  NODE_0{unoHotspotIndex + 1} [{Math.round(screenCoords.unoHotspot.x)},{Math.round(screenCoords.unoHotspot.y)}]
                </text>
              </>
            )}
            <circle cx={screenCoords.unoHotspot.x} cy={screenCoords.unoHotspot.y} r="4" fill="#337AFF" />
            <circle
              cx={screenCoords.unoHotspot.x}
              cy={screenCoords.unoHotspot.y}
              r="9"
              fill="none"
              stroke="#337AFF"
              strokeWidth="1"
              opacity="0.55"
            />
          </g>
        )}

        {activeSection === 'bridge' && bridgeWirePath && bridgeAirPath && bridgeEmitterOrigin && screenCoords.unoD13 && screenCoords.espAntenna && isDesktop && (
          <g className="transition-opacity duration-300">
            <path d={bridgeWirePath} fill="none" stroke="#337AFF" strokeWidth="2" />
            <circle cx={screenCoords.unoD13.x} cy={screenCoords.unoD13.y} r="4.5" fill="#337AFF" />
            <text
              x={screenCoords.unoD13.x}
              y={screenCoords.unoD13.y - 12}
              textAnchor="middle"
              className="font-mono text-[10px] fill-[#337AFF]"
            >
              PIN D13 (TX)
            </text>

            <g transform={`translate(${bridgeEmitterOrigin.x}, ${bridgeEmitterOrigin.y})`}>
              <circle cx="0" cy="0" r="3.5" fill="#337AFF" />
              <path d="M 14 -22 A 28 28 0 0 1 14 22" fill="none" stroke="#00B4D8" strokeWidth="1.5" opacity="0.45" />
              <path d="M 28 -36 A 46 46 0 0 1 28 36" fill="none" stroke="#00B4D8" strokeWidth="1.5" opacity="0.7" />
              <path d="M 44 -50 A 64 64 0 0 1 44 50" fill="none" stroke="#00B4D8" strokeWidth="2" opacity="0.95" />
              <text x="26" y="-58" textAnchor="middle" className="font-mono text-[10px] fill-[#00B4D8]">
                2.4 GHz RF PACKET
              </text>
            </g>

            <path
              d={bridgeAirPath}
              fill="none"
              stroke="#00B4D8"
              strokeWidth="1.5"
              strokeDasharray="5 3"
            />
            <circle cx={screenCoords.espAntenna.x} cy={screenCoords.espAntenna.y} r="4.5" fill="#00B4D8" />
            <text
              x={screenCoords.espAntenna.x}
              y={screenCoords.espAntenna.y - 12}
              textAnchor="middle"
              className="font-mono text-[10px] fill-[#00B4D8]"
            >
              PCB ANTENNA (RX)
            </text>
          </g>
        )}

        {activeSection === 'board-esp' && espLeaderPath && screenCoords.espHotspot && (
          <g className="transition-opacity duration-200">
            <path
              d={espLeaderPath}
              fill="none"
              stroke="#00B4D8"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
            {espElbowPoint && (
              <>
                <rect
                  x={espElbowPoint.x - 2.5}
                  y={espElbowPoint.y - 2.5}
                  width="5"
                  height="5"
                  fill="var(--rm-paper)"
                  stroke="#00B4D8"
                  strokeWidth="1.5"
                />
                <text
                  x={espElbowPoint.x - 6}
                  y={espElbowPoint.y - 6}
                  textAnchor="end"
                  className="font-mono text-[9px] fill-[#00B4D8] tracking-wider"
                >
                  RF_0{espHotspotIndex + 1} [{Math.round(screenCoords.espHotspot.x)},{Math.round(screenCoords.espHotspot.y)}]
                </text>
              </>
            )}
            <circle cx={screenCoords.espHotspot.x} cy={screenCoords.espHotspot.y} r="4" fill="#00B4D8" />
            <circle
              cx={screenCoords.espHotspot.x}
              cy={screenCoords.espHotspot.y}
              r="9"
              fill="none"
              stroke="#00B4D8"
              strokeWidth="1"
              opacity="0.55"
            />
          </g>
        )}

        {activeSection === 'spec' && isDesktop && (
          <g className="transition-opacity duration-200">
            {screenCoords.unoCenter && screenCoords.unoLeftEdge && screenCoords.unoRightEdge && (
              <g>
                <line
                  x1={screenCoords.unoLeftEdge.x}
                  y1={screenCoords.unoCenter.y - 95}
                  x2={screenCoords.unoRightEdge.x}
                  y2={screenCoords.unoCenter.y - 95}
                  stroke="#337AFF"
                  strokeWidth="1"
                />
                <line
                  x1={screenCoords.unoLeftEdge.x}
                  y1={screenCoords.unoCenter.y - 101}
                  x2={screenCoords.unoLeftEdge.x}
                  y2={screenCoords.unoCenter.y - 89}
                  stroke="#337AFF"
                  strokeWidth="1.5"
                />
                <line
                  x1={screenCoords.unoRightEdge.x}
                  y1={screenCoords.unoCenter.y - 101}
                  x2={screenCoords.unoRightEdge.x}
                  y2={screenCoords.unoCenter.y - 89}
                  stroke="#337AFF"
                  strokeWidth="1.5"
                />
                <text
                  x={screenCoords.unoCenter.x}
                  y={screenCoords.unoCenter.y - 103}
                  textAnchor="middle"
                  className="font-mono text-[10px] fill-[#337AFF]"
                >
                  UNO R3 · 68.6 mm (1.00x)
                </text>
              </g>
            )}

            {screenCoords.espCenter && screenCoords.espLeftEdge && screenCoords.espRightEdge && (
              <g>
                <line
                  x1={screenCoords.espLeftEdge.x}
                  y1={screenCoords.espCenter.y - 95}
                  x2={screenCoords.espRightEdge.x}
                  y2={screenCoords.espCenter.y - 95}
                  stroke="#00B4D8"
                  strokeWidth="1"
                />
                <line
                  x1={screenCoords.espLeftEdge.x}
                  y1={screenCoords.espCenter.y - 101}
                  x2={screenCoords.espLeftEdge.x}
                  y2={screenCoords.espCenter.y - 89}
                  stroke="#00B4D8"
                  strokeWidth="1.5"
                />
                <line
                  x1={screenCoords.espRightEdge.x}
                  y1={screenCoords.espCenter.y - 101}
                  x2={screenCoords.espRightEdge.x}
                  y2={screenCoords.espCenter.y - 89}
                  stroke="#00B4D8"
                  strokeWidth="1.5"
                />
                <text
                  x={screenCoords.espCenter.x}
                  y={screenCoords.espCenter.y - 103}
                  textAnchor="middle"
                  className="font-mono text-[10px] fill-[#00B4D8]"
                >
                  ESP8266 · 49.0 mm (0.71x)
                </text>
              </g>
            )}

            {specHoveredRow && screenCoords.unoHotspot && screenCoords.espHotspot && (
              <g>
                <circle cx={screenCoords.unoHotspot.x} cy={screenCoords.unoHotspot.y} r="5" fill="#337AFF" />
                <circle
                  cx={screenCoords.unoHotspot.x}
                  cy={screenCoords.unoHotspot.y}
                  r="11"
                  fill="none"
                  stroke="#337AFF"
                  strokeWidth="1.2"
                />
                <circle cx={screenCoords.espHotspot.x} cy={screenCoords.espHotspot.y} r="5" fill="#00B4D8" />
                <circle
                  cx={screenCoords.espHotspot.x}
                  cy={screenCoords.espHotspot.y}
                  r="11"
                  fill="none"
                  stroke="#00B4D8"
                  strokeWidth="1.2"
                />
                <path
                  d={`M ${screenCoords.unoHotspot.x} ${screenCoords.unoHotspot.y} V ${Math.min(screenCoords.unoHotspot.y, screenCoords.espHotspot.y) - 28} H ${screenCoords.espHotspot.x} V ${screenCoords.espHotspot.y}`}
                  fill="none"
                  stroke="var(--rm-hairline-strong)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
              </g>
            )}
          </g>
        )}
      </svg>
    </div>
  );
};

