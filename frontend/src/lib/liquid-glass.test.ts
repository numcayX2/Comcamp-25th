import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bendFromDepth,
  computeDisplacementData,
  sdRoundedBox,
} from './liquid-glass.ts';

test('sdRoundedBox is negative inside, zero on edge, positive outside', () => {
  assert.ok(sdRoundedBox(0, 0, 100, 22, 22) < 0);
  assert.equal(sdRoundedBox(0, 22, 100, 22, 22), 0);
  assert.ok(sdRoundedBox(105, 0, 100, 22, 22) > 0);
  assert.ok(sdRoundedBox(99, 21, 100, 22, 22) > 0); // corner clipped by pill radius
});

test('bendFromDepth is strongest near rim and drops to 0 at centre plateau', () => {
  const nearRim = bendFromDepth(0.05);
  const midBevel = bendFromDepth(0.5);
  const plateau = bendFromDepth(1);
  assert.ok(nearRim > midBevel && midBevel > 0);
  assert.equal(plateau, 0);
});

test('computeDisplacementData keeps pill interior flat, bends bevel rim, and masks outside', () => {
  const { data, width, height } = computeDisplacementData({
    width: 240,
    height: 44,
    radius: 999,
    bevelDepth: 11,
    dpr: 1,
  });
  assert.equal(width, 240);
  assert.equal(height, 44);

  const px = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };

  // Centre plateau (where Thai ToC text sits) must stay optically flat (neutral 128, 128).
  const center = px(120, 22);
  assert.equal(center.r, 128);
  assert.equal(center.g, 128);
  assert.equal(center.b, 0);
  assert.equal(center.a, 255);

  // Top bevel rim must bend vertically and receive upper-left specular highlight.
  const topRim = px(120, 2);
  assert.equal(topRim.a, 255);
  assert.notEqual(topRim.g, 128);
  assert.ok(topRim.b > 0);

  // Bottom bevel rim must bend opposite to top rim.
  const bottomRim = px(120, 41);
  assert.equal(bottomRim.a, 255);
  assert.ok((topRim.g - 128) * (bottomRim.g - 128) < 0);

  // Corner outside rounded pill must be masked out (alpha = 0).
  const corner = px(0, 0);
  assert.equal(corner.a, 0);
});
