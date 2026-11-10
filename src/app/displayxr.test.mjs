import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraRig, projectionSkew } from './displayxr.js';

test('camera rig converges at the given distance with an identity pose', () => {
  const rig = cameraRig({ fovy: 1, aspect: 1.6, convergence: 5000, depth: 1 });
  assert.equal(rig.type, 'camera');
  assert.deepEqual(rig.position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(rig.orientation, { x: 0, y: 0, z: 0, w: 1 });
  assert.equal(rig.verticalFov, 1);
  assert.equal(rig.convergenceDiopters, 1 / 5000);
});

test('camera rig puts infinity at the target disparity, scaled by depth', () => {
  const fovy = 1;
  const aspect = 1.6;
  const disparityAtInfinity = (rig) =>
    (0.063 * rig.metersToVirtual * rig.convergenceDiopters) /
    (2 * Math.tan(fovy / 2) * aspect);
  for (const convergence of [100, 5000, 2e6]) {
    const one = cameraRig({ fovy, aspect, convergence, depth: 1 });
    const two = cameraRig({ fovy, aspect, convergence, depth: 2 });
    assert.ok(Math.abs(disparityAtInfinity(one) - 0.012) < 1e-9);
    assert.ok(Math.abs(disparityAtInfinity(two) - 0.024) < 1e-9);
  }
});

test('depth 0 stays a valid (flat) rig', () => {
  const rig = cameraRig({ fovy: 1, aspect: 1, convergence: 100, depth: 0 });
  assert.ok(rig.metersToVirtual > 0);
});

test('projection skew reads the off-axis terms of a column-major matrix', () => {
  const m = new Float32Array(16);
  m[0] = 2;
  m[5] = 4;
  m[8] = 0.5;
  m[9] = -1;
  assert.deepEqual(projectionSkew(m), { x: 0.25, y: -0.25 });
  assert.deepEqual(projectionSkew(new Float32Array(16)), { x: 0, y: 0 });
});
