/**
 * Aceternity UI Liquid Glass optical engine (adapted for static Astro / DOM islands).
 *
 * Uses a Snell's-law squircle-dome displacement map (R = x bend, G = y bend, B = rim specular,
 * A = pill mask) paired with an RGB chromatic-aberration SVG filter applied via `backdrop-filter`.
 * Chromium refracts; Safari/Firefox get frosted glass (Firefox parses `backdrop-filter: url()` but
 * does not render SVG filters there); reduced-transparency, high-contrast and forced-colors get an
 * opaque surface.
 */

export type LiquidGlassMode = 'refract' | 'simple' | 'opaque';

export interface DisplacementOptions {
  width: number;
  height: number;
  /** Corner radius in px (clamped to half the shorter side; pass 999 for a full pill). */
  radius: number;
  /** Rim band that bends light, in px. */
  bevelDepth: number;
  /** Gradient gain before clamping to [-1, 1]. Default 1.35. */
  gain?: number;
  /** Rim specular light vector (upper-left by default). */
  light?: { x: number; y: number };
  /** Device pixel ratio (clamped to [1, 2]). */
  dpr?: number;
}

export interface LiquidGlassFilterOptions {
  id: string;
  mapUrl: string;
  width: number;
  height: number;
  /** Initial displacement strength in px. */
  scale: number;
  /** Max displacement strength used to pad the filter region so peak glide never clips. */
  maxScale?: number;
  /** Chromatic aberration spread in px (0 disables RGB split). */
  aberration: number;
  /** Max aberration used to pad the filter region. */
  maxAberration?: number;
  /** Extra Gaussian blur stdDeviation after refraction, in px (0 keeps overlaid text razor-sharp). */
  frost: number;
}

export interface LiquidGlassFilterNodes {
  id: string;
  svg: SVGSVGElement;
  image: SVGFEImageElement;
  dispR: SVGFEDisplacementMapElement | null;
  dispG: SVGFEDisplacementMapElement;
  dispB: SVGFEDisplacementMapElement | null;
  blur: SVGFEGaussianBlurElement | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export function supportsUrlBackdropFilter(): boolean {
  if (typeof CSS === 'undefined' || !CSS.supports) return false;
  return (
    CSS.supports('backdrop-filter', 'url(#x)') ||
    CSS.supports('-webkit-backdrop-filter', 'url(#x)')
  );
}

export function prefersOpaqueGlass(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return (
    window.matchMedia('(prefers-reduced-transparency: reduce)').matches ||
    window.matchMedia('(prefers-contrast: more)').matches ||
    window.matchMedia('(forced-colors: active)').matches
  );
}

/** Chromium-based engines expose `navigator.userAgentData` with a "Chromium" brand; Safari and Firefox do not. */
export function isChromium(): boolean {
  if (typeof navigator === 'undefined') return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return Array.isArray(brands) && brands.some((b) => /Chromium/.test(b.brand));
}

export function detectLiquidGlassMode(): LiquidGlassMode {
  if (prefersOpaqueGlass()) return 'opaque';
  if (!isChromium() || !supportsUrlBackdropFilter()) return 'simple';
  return 'refract';
}

/* ---------------------------------------------------------------------------
 * Snell's-law squircle-dome displacement map
 * R = horizontal bend, G = vertical bend, B = rim specular, A = shape mask.
 * Neutral grey (128) means zero displacement; interior plateau stays flat.
 * ------------------------------------------------------------------------- */

/** Signed distance to a rounded box centred at the origin (< 0 inside). */
export function sdRoundedBox(
  px: number,
  py: number,
  halfW: number,
  halfH: number,
  r: number,
): number {
  const qx = Math.abs(px) - halfW + r;
  const qy = Math.abs(py) - halfH + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return inside + outside - r;
}

/** Squircle-dome slope -> Snell's-law bend (glass IOR 1.5). x = 0 at rim, 1 at plateau. */
export function bendFromDepth(x: number): number {
  const u = 1 - Math.min(1, Math.max(0, x));
  const denom = (1 - u ** 4) ** 0.75;
  if (denom < 1e-6) return 0;
  const thetaI = Math.atan(Math.min(u ** 3 / denom, 8));
  const sinT = Math.sin(thetaI) / 1.5;
  if (sinT >= 1) return Math.sin(thetaI);
  return Math.sin(thetaI - Math.asin(sinT));
}

/** phi(d) = integral of bend along distance from rim. */
function buildPhiTable(bevelPx: number): Float32Array {
  const n = Math.max(1, Math.ceil(bevelPx));
  const phi = new Float32Array(n + 1);
  for (let d = 1; d <= n; d++) phi[d] = phi[d - 1] + bendFromDepth(d / n);
  return phi;
}

function samplePhi(phi: Float32Array, depth: number): number {
  const max = phi.length - 1;
  if (depth <= 0) return phi[0];
  if (depth >= max) return phi[max];
  const i = Math.floor(depth);
  const f = depth - i;
  return phi[i] * (1 - f) + phi[i + 1] * f;
}

export function computeDisplacementData(opts: DisplacementOptions): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const dpr = Math.min(2, Math.max(1, opts.dpr ?? 1));
  const gain = opts.gain ?? 1.35;
  const light = opts.light ?? { x: -0.55, y: -0.85 };
  const lightLen = Math.hypot(light.x, light.y) || 1;
  const lx = light.x / lightLen;
  const ly = light.y / lightLen;

  const W = Math.max(1, Math.round(opts.width * dpr));
  const H = Math.max(1, Math.round(opts.height * dpr));
  const halfW = W / 2;
  const halfH = H / 2;
  const r = Math.min(opts.radius * dpr, halfW, halfH);
  const bevel = Math.max(1, Math.min(opts.bevelDepth * dpr, Math.min(halfW, halfH)));
  const phi = buildPhiTable(bevel);

  // Height field over the shape, then displace along its gradient.
  // Interior pixels (-d >= bevel) sit on the constant plateau phi[bevel], so dPhi = 0
  // and text centred inside the pill stays completely sharp and undistorted.
  const field = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const py = y - halfH + 0.5;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const d = sdRoundedBox(x - halfW + 0.5, py, halfW, halfH, r);
      field[row + x] = d > 0 ? 0 : samplePhi(phi, Math.min(bevel, -d));
    }
  }

  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const py = y - halfH + 0.5;
    const row = y * W;
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(H - 1, y + 1);
    const invDy = 1 / (y1 - y0 || 1);
    for (let x = 0; x < W; x++) {
      const px = x - halfW + 0.5;
      const i = (row + x) << 2;
      const d = sdRoundedBox(px, py, halfW, halfH, r);

      if (d > 0) {
        data[i] = 128;
        data[i + 1] = 128;
        data[i + 2] = 128;
        data[i + 3] = 0;
        continue;
      }

      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(W - 1, x + 1);
      const dPhiX = (field[row + x1] - field[row + x0]) / (x1 - x0 || 1);
      const dPhiY = (field[y1 * W + x] - field[y0 * W + x]) * invDy;

      // Cap so the rim compresses cleanly and never folds over itself.
      const dx = Math.max(-1, Math.min(1, dPhiX * gain));
      const dy = Math.max(-1, Math.min(1, dPhiY * gain));

      let specular = 0;
      if (d >= -bevel) {
        const gx =
          sdRoundedBox(px + 1, py, halfW, halfH, r) -
          sdRoundedBox(px - 1, py, halfW, halfH, r);
        const gy =
          sdRoundedBox(px, py + 1, halfW, halfH, r) -
          sdRoundedBox(px, py - 1, halfW, halfH, r);
        const len = Math.hypot(gx, gy) || 1;
        const dot = (gx / len) * lx + (gy / len) * ly;
        const rim = 1 - Math.min(1, -d / bevel);
        specular = (Math.max(0, dot) + Math.max(0, -dot) * 0.35) * rim;
      }

      data[i] = Math.round(128 + dx * 127);
      data[i + 1] = Math.round(128 + dy * 127);
      data[i + 2] = Math.round(specular * 255);
      data[i + 3] = 255;
    }
  }

  return { data, width: W, height: H };
}

/** Encodes the displacement map as a pre-decoded PNG blob URL for feImage. */
export async function generateDisplacementMapUrl(
  opts: DisplacementOptions,
): Promise<{ url: string; isBlob: boolean }> {
  const { data, width, height } = computeDisplacementData(opts);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  const isBlob = blob !== null;
  const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/png');

  // Decode the map before attaching the SVG filter so Chromium never flashes an empty frame.
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
  });

  return { url, isBlob };
}

/* ---------------------------------------------------------------------------
 * SVG filter DOM builder (avoids innerHTML, supports live scale updates)
 * ------------------------------------------------------------------------- */

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'xlink:href') el.setAttributeNS(XLINK_NS, 'xlink:href', v);
    else el.setAttribute(k, v);
  }
  return el;
}

export function createLiquidGlassFilter(opts: LiquidGlassFilterOptions): LiquidGlassFilterNodes {
  const { id, mapUrl, width, height, scale, aberration, frost } = opts;
  const pad = Math.ceil(
    Math.max(scale, opts.maxScale ?? scale) +
      Math.max(aberration, opts.maxAberration ?? aberration) +
      4,
  );
  const px = (pad / Math.max(1, width)) * 100;
  const py = (pad / Math.max(1, height)) * 100;

  const svg = svgEl('svg', {
    width: '0',
    height: '0',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'gd-toc__filters',
  });

  const filter = svgEl('filter', {
    id,
    'color-interpolation-filters': 'sRGB',
    x: `-${px.toFixed(3)}%`,
    y: `-${py.toFixed(3)}%`,
    width: `${(100 + 2 * px).toFixed(3)}%`,
    height: `${(100 + 2 * py).toFixed(3)}%`,
  });

  // Pixel-sized map matched to the lens; % units wash out the rim bend.
  const image = svgEl('feImage', {
    href: mapUrl,
    'xlink:href': mapUrl,
    x: '0',
    y: '0',
    width: String(width),
    height: String(height),
    result: 'map',
    preserveAspectRatio: 'none',
  });
  filter.appendChild(image);

  const mkDisplace = (s: number, result: string) =>
    svgEl('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'map',
      scale: s.toFixed(2),
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result,
    });

  let dispR: SVGFEDisplacementMapElement | null = null;
  let dispG: SVGFEDisplacementMapElement;
  let dispB: SVGFEDisplacementMapElement | null = null;

  const splitRgb = (opts.maxAberration ?? aberration) > 0 || aberration > 0;
  if (!splitRgb) {
    dispG = mkDisplace(scale, 'rgb');
    filter.appendChild(dispG);
  } else {
    dispR = mkDisplace(scale + aberration, 'dispR');
    const red = svgEl('feColorMatrix', {
      in: 'dispR',
      type: 'matrix',
      values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
      result: 'red',
    });
    dispG = mkDisplace(scale, 'dispG');
    const green = svgEl('feColorMatrix', {
      in: 'dispG',
      type: 'matrix',
      values: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
      result: 'green',
    });
    dispB = mkDisplace(Math.max(0, scale - aberration), 'dispB');
    const blue = svgEl('feColorMatrix', {
      in: 'dispB',
      type: 'matrix',
      values: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
      result: 'blue',
    });
    const rg = svgEl('feBlend', {
      in: 'red',
      in2: 'green',
      mode: 'screen',
      result: 'rg',
    });
    const rgb = svgEl('feBlend', {
      in: 'rg',
      in2: 'blue',
      mode: 'screen',
      result: 'rgb',
    });
    filter.append(dispR, red, dispG, green, dispB, blue, rg, rgb);
  }

  let blur: SVGFEGaussianBlurElement | null = null;
  if (frost > 0) {
    blur = svgEl('feGaussianBlur', {
      in: 'rgb',
      stdDeviation: frost.toFixed(2),
    });
    filter.appendChild(blur);
  }

  svg.appendChild(filter);
  return { id, svg, image, dispR, dispG, dispB, blur };
}

/** Updates displacement scale and chromatic aberration live on an existing filter without rebuilding. */
export function updateLiquidGlassScale(
  nodes: LiquidGlassFilterNodes,
  scale: number,
  aberration: number,
): void {
  const sG = Math.max(0, scale);
  nodes.dispG.setAttribute('scale', sG.toFixed(2));
  if (nodes.dispR) {
    nodes.dispR.setAttribute('scale', (sG + Math.max(0, aberration)).toFixed(2));
  }
  if (nodes.dispB) {
    nodes.dispB.setAttribute('scale', Math.max(0, sG - Math.max(0, aberration)).toFixed(2));
  }
}
