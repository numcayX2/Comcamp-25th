/**
 * hero-3d.js — ComCamp #25 hero stage
 * Renders BOTH real .glb boards in one transparent WebGL canvas (#heroStageCanvas).
 * Decodes Draco-compressed .glb meshes using self-hosted decoders at /draco/gltf/.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ==========================================================================
   1. MODEL CONFIG — tune position / rotation / size here
   --------------------------------------------------------------------------
   position  : scene units. +x right, +y up, +z toward camera
   rotation  : radians (Euler XYZ). Start with the values from the reference
               and nudge ±0.1 until the boards match the mock-up
   targetSize: longest side of the model after normalisation (scene units)
   shadowOffset: where the soft contact shadow sits (x,y,z) and its stretch
   float     : idle bobbing — amp (units), speed (rad/s), phase (offset)

   TIP: in dev (npm run dev) these are live — open the console and type e.g.
        HERO_3D.config.arduino.rotation.x = 0.8
   ========================================================================== */
export const HERO_3D_CONFIG = {
  esp8266: {
    url: '/models/esp8266.glb',
    targetSize: 1.85,
    position: { x: -2.05, y: -0.12, z: 0.35 },
    rotation: { x: 0.55, y: -0.45, z: -0.62 }, // Steeper downward slope forming left wing of V-shape
    shadowOffset: { x: -2.05, y: -1.22, z: 0.25, scaleX: 1.35, scaleZ: 0.65 },
    float: { amp: 0.07, speed: 1.15, phase: 1.8 },
  },
  arduino: {
    url: '/models/ArduinoR3.glb',
    targetSize: 3.15,
    position: { x: 1.0, y: 0.16, z: 0.0 },
    rotation: { x: 0.62, y: 0.52, z: 0.56 }, // Steeper upward slope forming right wing of V-shape
    shadowOffset: { x: 1.0, y: -1.12, z: -0.10, scaleX: 2.2, scaleZ: 0.95 },
    float: { amp: 0.09, speed: 0.85, phase: 0 },
  },
};

/* Scene-level settings (camera, interaction, theme-aware shadow colour) */
const SCENE = {
  camera: { fov: 32, position: [0, 1.2, 8.2], lookAt: [0, -0.1, 0] },
  referenceAspect: 1.1, // stage aspect-ratio in CSS; narrower stages scale the rig down
  parallax: { maxTiltX: 0.12, maxTiltY: 0.2, rate: 4 },
  drag: { enabled: true, speed: 0.008, maxTiltX: 0.8, springBack: true, rate: 8 },
  shadow: {
    light: { color: 0x1a1030, opacity: 0.38 },
    dark: { color: 0xa855f7, opacity: 0.55 },
  },
};

/* ==========================================================================
   2. HELPERS
   ========================================================================== */

/**
 * Centre a loaded glTF at (0,0,0) and scale its longest side to `targetSize`,
 * so any export unit (mm, cm, m) renders at the right proportion.
 * Returns a Group; apply position/rotation to a parent pivot, not to this.
 */
export function normalizeGlbModel(gltf, targetSize) {
  const holder = new THREE.Group();
  const model = gltf.scene;
  holder.add(model);
  holder.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  model.position.sub(center); // centre geometry at origin
  holder.userData.maxDim = maxDim;
  holder.userData.size = size.clone(); // model-space extents, used by fitRig()
  holder.scale.setScalar(targetSize / maxDim); // uniform scale
  return holder;
}

/** Soft white radial gradient — tinted per theme via material.color */
function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const isDark = () => {
  const r = document.documentElement;
  return r.classList.contains('dark') || r.getAttribute('data-theme') === 'dark';
};

/* ==========================================================================
   3. INIT
   ========================================================================== */
const stage = document.getElementById('heroStage');
const canvas = document.getElementById('heroStageCanvas');
if (stage && canvas) init(stage, canvas);

function init(stage, canvas) {
  const section = stage.closest('.hero') || stage;
  const setState = (s) => (stage.dataset.state = s);

  /* ---- Renderer (transparent, sRGB) ---- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    console.warn('[hero-3d] WebGL unavailable, showing fallback.', err);
    setState('fallback');
    return;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the PCB blue true to colour

  /* ---- Scene / camera / rig ----
     rig (fit scale) → tilt (parallax + drag rotation) → board pivots
     rig → shadows (not rotated, so the ellipses stay flat on the "floor") */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(SCENE.camera.fov, 1, 0.1, 50);
  camera.position.set(...SCENE.camera.position);
  camera.lookAt(...SCENE.camera.lookAt);

  const rig = new THREE.Group();
  const tilt = new THREE.Group();
  rig.add(tilt);
  scene.add(rig);

  /* ---- Lighting: studio setup ---- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9ccff, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xc4b5fd, 2.2); // soft lavender rim
  rim.position.set(-4, 2.5, -3);
  scene.add(rim);

  /* ---- Items (one per board) ---- */
  const shadowTex = makeShadowTexture();
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const items = new Map();

  for (const [key, cfg] of Object.entries(HERO_3D_CONFIG)) {
    const pivot = new THREE.Group();
    tilt.add(pivot);

    const shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      })
    );
    shadow.renderOrder = -1;
    shadow.visible = false;
    rig.add(shadow);

    items.set(key, { cfg, pivot, shadow, holder: null, shadowBase: 0.4, ready: false });
  }

  /* ---- Theme (shadow tint follows light / dark) ---- */
  function applyTheme() {
    const t = isDark() ? SCENE.shadow.dark : SCENE.shadow.light;
    for (const it of items.values()) {
      it.shadow.material.color.setHex(t.color);
      it.shadowBase = t.opacity;
    }
  }
  applyTheme();
  new MutationObserver(() => {
    applyTheme();
    if (!raf) renderNow();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

  /* ==========================================================================
     4. INTERACTION STATE
     ========================================================================== */
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reduceMQ.matches;
  const pointer = { x: 0, y: 0 };
  const parallax = { x: 0, y: 0 };
  const drag = { active: false, lastX: 0, lastY: 0, tgtX: 0, tgtY: 0, x: 0, y: 0 };

  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    },
    { passive: true }
  );

  // Drag / touch-to-rotate inspection (horizontal swipe on touch; vertical still scrolls the page)
  canvas.addEventListener('pointerdown', (e) => {
    if (!SCENE.drag.enabled) return;
    drag.active = true;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    drag.tgtY += (e.clientX - drag.lastX) * SCENE.drag.speed;
    drag.tgtX = THREE.MathUtils.clamp(
      drag.tgtX + (e.clientY - drag.lastY) * SCENE.drag.speed,
      -SCENE.drag.maxTiltX,
      SCENE.drag.maxTiltX
    );
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (reduced) {
      drag.x = drag.tgtX;
      drag.y = drag.tgtY;
      renderNow();
    }
  });
  const endDrag = () => {
    drag.active = false;
    stage.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  // Keyboard inspection: arrows rotate the rig for keyboard / screen-reader users.
  canvas.addEventListener('keydown', (e) => {
    if (!SCENE.drag.enabled) return;
    const step = 0.12;
    if (e.key === 'ArrowLeft') {
      drag.tgtY -= step;
    } else if (e.key === 'ArrowRight') {
      drag.tgtY += step;
    } else if (e.key === 'ArrowUp') {
      drag.tgtX = THREE.MathUtils.clamp(drag.tgtX - step, -SCENE.drag.maxTiltX, SCENE.drag.maxTiltX);
    } else if (e.key === 'ArrowDown') {
      drag.tgtX = THREE.MathUtils.clamp(drag.tgtX + step, -SCENE.drag.maxTiltX, SCENE.drag.maxTiltX);
    } else {
      return;
    }
    e.preventDefault();
    if (reduced) {
      drag.x = drag.tgtX;
      drag.y = drag.tgtY;
      renderNow();
    }
  });

  /* ==========================================================================
     5. LOAD BOTH .glb MODELS
     ========================================================================== */
  const loader = new GLTFLoader();
  const draco = new DRACOLoader().setDecoderPath('/draco/gltf/').preload();
  loader.setDRACOLoader(draco);
  let dracoDisposed = false;
  const disposeDraco = () => {
    if (dracoDisposed) return;
    dracoDisposed = true;
    draco.dispose();
  };
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const loadGlb = (url) => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));

  let ready = false;

  Promise.allSettled(
    [...items.entries()].map(async ([name, it]) => {
      const gltf = await loadGlb(it.cfg.url); // ← '/models/esp8266.glb' and '/models/ArduinoR3.glb'
      const holder = normalizeGlbModel(gltf, it.cfg.targetSize);
      holder.traverse((o) => {
        if (o.isMesh && o.material?.map) o.material.map.anisotropy = maxAniso;
      });
      it.pivot.add(holder);
      it.holder = holder;
      it.ready = true;
      it.shadow.visible = true;
      return name;
    })
  ).then((results) => {
    disposeDraco();
    results.forEach((r) => r.status === 'rejected' && console.warn('[hero-3d] model failed:', r.reason));
    if (!results.some((r) => r.status === 'fulfilled')) {
      setState('fallback');
      return;
    }
    ready = true;
    setState('ready');
    resize();
    renderNow();
    syncLoop();
  });

  /* ==========================================================================
     6. UPDATE + RENDER
     ========================================================================== */
  const clock = new THREE.Clock();
  let raf = 0;

  function update(dt, t) {
    const kp = 1 - Math.exp(-dt * SCENE.parallax.rate);
    parallax.x += ((reduced ? 0 : pointer.x) - parallax.x) * kp;
    parallax.y += ((reduced ? 0 : pointer.y) - parallax.y) * kp;

    if (!reduced) {
      if (!drag.active && SCENE.drag.springBack) {
        const ks = 1 - Math.exp(-dt * 2.5);
        drag.tgtX -= drag.tgtX * ks;
        drag.tgtY -= drag.tgtY * ks;
      }
      const kd = 1 - Math.exp(-dt * SCENE.drag.rate);
      drag.x += (drag.tgtX - drag.x) * kd;
      drag.y += (drag.tgtY - drag.y) * kd;
    }

    tilt.rotation.y = parallax.x * SCENE.parallax.maxTiltY + drag.y;
    tilt.rotation.x = parallax.y * SCENE.parallax.maxTiltX + drag.x;

    for (const it of items.values()) {
      if (!it.ready) continue;
      const c = it.cfg;
      const f = reduced ? 0 : Math.sin(t * c.float.speed + c.float.phase);
      const wob = reduced ? 0 : Math.sin(t * c.float.speed * 0.7 + c.float.phase + 1) * 0.025;

      // Config is read every frame, so edits in dev tools apply live
      it.holder.scale.setScalar(c.targetSize / it.holder.userData.maxDim);
      it.pivot.position.set(c.position.x, c.position.y + f * c.float.amp, c.position.z);
      it.pivot.rotation.set(c.rotation.x + wob, c.rotation.y, c.rotation.z + wob);

      // Shadow shrinks and fades as the board floats up
      const h = (f + 1) / 2;
      const s = c.shadowOffset;
      it.shadow.position.set(s.x, s.y, s.z);
      it.shadow.scale.set(s.scaleX * (1 - 0.12 * h), 1, s.scaleZ * (1 - 0.12 * h));
      it.shadow.material.opacity = it.shadowBase * (1 - 0.35 * h);
    }
  }

  function renderNow() {
    update(0.016, reduced ? 0 : clock.elapsedTime);
    renderer.render(scene, camera);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    update(dt, clock.elapsedTime);
    renderer.render(scene, camera);
  }

  /* ==========================================================================
     7. LIFECYCLE: visibility, reduced motion, resize, cleanup
     ========================================================================== */
  let inView = true;

  function syncLoop() {
    const shouldRun = ready && inView && !document.hidden && !reduced;
    if (shouldRun && !raf) {
      clock.getDelta(); // discard the paused gap
      raf = requestAnimationFrame(tick);
    } else if (!shouldRun && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  // Pause when the hero is scrolled out of view
  new IntersectionObserver(
    ([entry]) => {
      inView = entry.isIntersecting;
      syncLoop();
    },
    { threshold: 0.02 }
  ).observe(section);

  document.addEventListener('visibilitychange', syncLoop);

  reduceMQ.addEventListener('change', (e) => {
    reduced = e.matches;
    syncLoop();
    if (ready && !raf) renderNow();
  });

  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fitRig();
    if (ready && !raf) renderNow();
  }

  /* Auto-frame: scale + centre the rig so the projected outline of BOTH boards
     (rest pose) sits inside FIT.margin of the canvas. Nothing is ever hard-cropped
     by the canvas edge, at any stage aspect. Uses each board's oriented bounding
     box, which is tight for flat PCBs. */
  // margin: fraction of the half-frame the composition may use (headroom for float + parallax).
  // shadowReach: the soft ellipse is visually ~this fraction of its plane, so only that part counts.
  const FIT = { margin: 0.84, maxScale: 1.25, passes: 4, shadowReach: 0.62 };
  const _v = new THREE.Vector3();

  /** Projected NDC bounds of both boards (oriented boxes) + their floor shadows, in the current pose. */
  function measure(live) {
    rig.updateMatrixWorld(true);
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    const add = () => {
      _v.project(camera);
      b.minX = Math.min(b.minX, _v.x); b.maxX = Math.max(b.maxX, _v.x);
      b.minY = Math.min(b.minY, _v.y); b.maxY = Math.max(b.maxY, _v.y);
    };
    for (const it of live) {
      const { size } = it.holder.userData;
      for (let i = 0; i < 8; i++) {
        _v.set(i & 1 ? size.x / 2 : -size.x / 2, i & 2 ? size.y / 2 : -size.y / 2, i & 4 ? size.z / 2 : -size.z / 2);
        it.holder.localToWorld(_v);
        add();
      }
      const r = FIT.shadowReach / 2;
      for (let i = 0; i < 4; i++) {
        _v.set(i & 1 ? r : -r, 0, i & 2 ? r : -r);
        it.shadow.localToWorld(_v);
        add();
      }
    }
    return b;
  }

  function fitRig() {
    if (!ready) return;
    const live = [...items.values()].filter((it) => it.ready);
    if (!live.length) return;

    // project() reads camera.matrixWorldInverse, which is otherwise only refreshed by render()
    camera.updateMatrixWorld(true);

    // Measure the rest pose (no tilt, no float) so framing is stable frame to frame
    const saved = tilt.rotation.clone();
    tilt.rotation.set(0, 0, 0);
    for (const it of live) {
      const c = it.cfg;
      const s = c.shadowOffset;
      it.holder.scale.setScalar(c.targetSize / it.holder.userData.maxDim);
      it.pivot.position.set(c.position.x, c.position.y, c.position.z);
      it.pivot.rotation.set(c.rotation.x, c.rotation.y, c.rotation.z);
      it.shadow.position.set(s.x, s.y, s.z);
      it.shadow.scale.set(s.scaleX, 1, s.scaleZ);
    }
    rig.scale.setScalar(1);
    rig.position.set(0, 0, 0);

    const dist = camera.position.distanceTo(_v.set(...SCENE.camera.lookAt));
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
    const halfW = halfH * camera.aspect;
    const centre = () => {
      const b = measure(live);
      rig.position.x -= ((b.minX + b.maxX) / 2) * halfW;
      rig.position.y -= ((b.minY + b.maxY) / 2) * halfH;
    };

    // Alternate centre → scale, re-measuring each time, then finish on a centre pass.
    for (let pass = 0; pass < FIT.passes; pass++) {
      centre();
      const b = measure(live);
      const half = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2 || 1;
      const k = THREE.MathUtils.clamp(FIT.margin / half, 0.25, FIT.maxScale / rig.scale.x);
      rig.scale.multiplyScalar(k);
      rig.position.multiplyScalar(k); // scale about the camera axis, not the rig origin
    }
    centre();
    tilt.rotation.copy(saved);
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  window.addEventListener('pagehide', () => {
    if (raf) cancelAnimationFrame(raf);
    disposeDraco();
    shadowTex.dispose();
    shadowGeo.dispose();
    pmrem.dispose();
    renderer.dispose();
  });

  // Dev-only live tuning: HERO_3D.config.arduino.position.x = 1.2
  if (import.meta.env?.DEV) window.HERO_3D = { config: HERO_3D_CONFIG, scene: SCENE, rig, camera, items, fitRig, renderer };
}
