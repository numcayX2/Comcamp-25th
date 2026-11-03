import React, { Suspense, useState, useRef, useEffect, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, Center } from '@react-three/drei';
import * as THREE from 'three';

const ESP8266_MODEL_PATH = '/models/esp8266.glb?v=20261102';
const ARDUINO_R3_MODEL_PATH = '/models/ArduinoR3.glb?v=20261102';

// Preload both models
try {
  useGLTF.preload(ESP8266_MODEL_PATH);
  useGLTF.preload(ARDUINO_R3_MODEL_PATH);
} catch (e) {
  // Graceful fallback
}

// Procedural Fallback for ESP8266
const ProceduralEsp8266Fallback: React.FC = () => {
  return (
    <group rotation={[0.42, 0.35, -0.05]}>
      {/* PCB Base */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[4.6, 0.12, 2.4]} />
        <meshStandardMaterial color="#111418" roughness={0.6} metalness={0.15} />
      </mesh>
      {/* ESP-12E RF Shield */}
      <mesh position={[0.5, 0.22, 0]}>
        <boxGeometry args={[1.8, 0.28, 1.6]} />
        <meshStandardMaterial color="#B0B5B9" metalness={0.88} roughness={0.25} />
      </mesh>
      {/* Gold Antenna */}
      <mesh position={[1.85, 0.08, 0]}>
        <boxGeometry args={[0.7, 0.02, 1.8]} />
        <meshStandardMaterial color="#D4991E" metalness={0.7} roughness={0.3} />
      </mesh>
    </group>
  );
};

// Procedural Fallback for Arduino UNO R3
const ProceduralArduinoFallback: React.FC = () => {
  return (
    <group rotation={[0.42, 0.35, -0.05]}>
      {/* Arduino Classic Teal/Blue PCB */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[4.8, 0.14, 3.4]} />
        <meshStandardMaterial color="#008184" roughness={0.5} metalness={0.12} />
      </mesh>
      {/* ATmega328P DIP-28 Chip */}
      <mesh position={[0.2, 0.2, 0.3]}>
        <boxGeometry args={[2.4, 0.22, 0.65]} />
        <meshStandardMaterial color="#1E2328" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* USB-B Metal Port */}
      <mesh position={[-2.1, 0.35, -0.8]}>
        <boxGeometry args={[0.8, 0.55, 0.75]} />
        <meshStandardMaterial color="#C8D0D6" metalness={0.9} roughness={0.2} />
      </mesh>
      {/* DC Barrel Jack */}
      <mesh position={[-2.1, 0.35, 1.0]}>
        <boxGeometry args={[0.9, 0.5, 0.8]} />
        <meshStandardMaterial color="#151719" metalness={0.2} roughness={0.6} />
      </mesh>
    </group>
  );
};

// Blender Model: ESP8266 NodeMCU
const BlenderEsp8266: React.FC = () => {
  const { scene } = useGLTF(ESP8266_MODEL_PATH);

  useEffect(() => {
    scene.traverse((obj) => {
      const name = obj.name.toLowerCase();
      if (name.includes('backdrop') || name.includes('plane') || name.includes('floor')) {
        obj.visible = false;
      }
    });
  }, [scene]);

  const normalizedScale = useMemo(() => {
    try {
      const box = new THREE.Box3().setFromObject(scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      return maxDim > 0 ? 4.4 / maxDim : 1;
    } catch {
      return 1;
    }
  }, [scene]);

  return (
    <group scale={normalizedScale}>
      <Center top={false} bottom={false}>
        <primitive object={scene} />
      </Center>
    </group>
  );
};

// Blender Model: Arduino UNO R3
const BlenderArduinoR3: React.FC = () => {
  const { scene } = useGLTF(ARDUINO_R3_MODEL_PATH);

  useEffect(() => {
    scene.traverse((obj) => {
      const name = obj.name.toLowerCase();
      if (name.includes('backdrop') || name.includes('plane') || name.includes('floor')) {
        obj.visible = false;
      }
    });
  }, [scene]);

  const normalizedScale = useMemo(() => {
    try {
      const box = new THREE.Box3().setFromObject(scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      // Normalize to ~4.3 world units for crisp isometric perspective
      return maxDim > 0 ? 4.3 / maxDim : 1;
    } catch {
      return 1;
    }
  }, [scene]);

  return (
    <group scale={normalizedScale}>
      <Center top={false} bottom={false}>
        <primitive object={scene} />
      </Center>
    </group>
  );
};

// Autonomous Showcase Motion Rig
const ShowcaseMotionRig: React.FC<{
  isDesktop: boolean;
  embedded?: boolean;
  board?: 'esp8266' | 'arduino-r3';
}> = ({ isDesktop, embedded = false, board = 'esp8266' }) => {
  const groupRef = useRef<THREE.Group>(null);
  const baseX = embedded ? 0 : (isDesktop ? 1.35 : 0);

  useFrame((state) => {
    if (!groupRef.current) return;
    const time = state.clock.getElapsedTime();

    // Serene, composed showcase motion at an iconic isometric hero angle
    groupRef.current.rotation.x = 0.44 + Math.sin(time * 0.4) * 0.03;
    groupRef.current.rotation.y = time * 0.08; // Calm continuous 360 rotation
    groupRef.current.rotation.z = -0.06 + Math.cos(time * 0.3) * 0.02;

    // Subtle vertical breathing float
    groupRef.current.position.y = 0.05 + Math.sin(time * 0.9) * 0.12;
    groupRef.current.position.x = baseX;
  });

  return (
    <group ref={groupRef} position={[baseX, 0.05, 0]}>
      {board === 'arduino-r3' ? (
        <Suspense fallback={<ProceduralArduinoFallback />}>
          <BlenderArduinoR3 />
        </Suspense>
      ) : (
        <Suspense fallback={<ProceduralEsp8266Fallback />}>
          <BlenderEsp8266 />
        </Suspense>
      )}
    </group>
  );
};

export interface HardwareBoardSceneProps {
  embedded?: boolean;
  className?: string;
  board?: 'esp8266' | 'arduino-r3';
}

export const Esp8266Scene: React.FC<HardwareBoardSceneProps> = ({
  embedded = false,
  className = '',
  board = 'esp8266',
}) => {
  const [hasWebGL, setHasWebGL] = useState<boolean>(true);
  const [isDark, setIsDark] = useState<boolean>(false);
  const [isDesktop, setIsDesktop] = useState<boolean>(true);

  useEffect(() => {
    try {
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
      if (!gl) setHasWebGL(false);
    } catch {
      setHasWebGL(false);
    }

    // Detect theme class on <html>
    const updateTheme = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    // Track viewport width for diptych right pane alignment
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= 1024);
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  if (!hasWebGL) {
    return null;
  }

  const containerClass = embedded
    ? `relative w-full h-full min-h-[300px] lg:min-h-[420px] pointer-events-none select-none overflow-hidden ${className}`
    : `fixed inset-0 w-full h-dvh z-0 pointer-events-none select-none overflow-x-clip overflow-y-hidden ${className}`;

  return (
    <div className={containerClass}>
      {/* Blueprint grid background overlay for engineering atmosphere */}
      <div className="absolute inset-0 bg-blueprint-grid opacity-25 z-1 pointer-events-none" />

      <Canvas
        frameloop="always"
        dpr={[1, 1.5]}
        camera={{ position: embedded ? [0, 1.8, 5.0] : [0, 2.2, 6.0], fov: 38 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      >
        {/* Responsive Lighting based on Light/Dark Theme */}
        {isDark ? (
          <>
            <ambientLight intensity={0.75} color="#A8C0E8" />
            <directionalLight position={[6, 9, 6]} intensity={2.0} color="#FFFFFF" />
            <pointLight position={[-4, 2, -2]} intensity={3.0} color="var(--color-tech)" />
            <pointLight position={[4, -2, 2]} intensity={1.8} color="var(--color-cta)" />
            <pointLight position={[0, 4, 3]} intensity={1.4} color="#80B0FF" />
          </>
        ) : (
          <>
            <ambientLight intensity={1.2} color="#FFFFFF" />
            <directionalLight position={[6, 8, 5]} intensity={2.4} color="#FFFFFF" />
            <pointLight position={[-4, 3, 2]} intensity={1.5} color="var(--color-tech)" />
            <pointLight position={[4, -1, 1]} intensity={0.9} color="var(--color-cta)" />
          </>
        )}

        <ShowcaseMotionRig isDesktop={isDesktop} embedded={embedded} board={board} />
      </Canvas>
    </div>
  );
};

export const HardwareBoardScene = Esp8266Scene;
