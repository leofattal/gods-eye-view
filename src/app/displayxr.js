/**
 * Glasses-free 3D on DisplayXR spatial displays (https://displayxr.com).
 *
 * In the DisplayXR Browser, the globe is woven into stereo: each frame renders
 * the Cesium scene once per eye and copies both into a side-by-side canvas that
 * the browser weaves for the panel. Everywhere else this module does nothing —
 * the probe fails and the app stays exactly as it was.
 *
 * Model: a DisplayXR CAMERA rig with an identity pose, so the runtime reports
 * each eye relative to the app camera (camera space, +x right, +y up, -z
 * forward) with an off-axis projection that keeps zero disparity at the
 * convergence distance. Each eye is applied to Cesium's camera after every
 * other preRender listener (so cockpit/follow cameras have already placed it)
 * and the mono camera is restored before postRender, so 2D overlays and the
 * rest of the app keep seeing the normal camera.
 *
 * URL options: `?dxr=0` disables it; `?dxrDepth=1.5` scales stereo depth;
 * `?dxr=sim` fakes a DisplayXR browser in any browser and shows the raw
 * side-by-side pair (left eye left), for checking the stereo pipeline.
 */
import * as Cesium from 'cesium';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

const HOLD_ID = 'displayxr-stereo';
// Disparity of a point at infinity, as a fraction of the window width, at
// depth 1. Small: a globe has a huge depth range and comfort matters more.
const BASE_DISPARITY = 0.012;
const MIN_CONVERGENCE_M = 30;
const MAX_CONVERGENCE_M = 2.0e7;

function readOptions(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search);
  const off = ['0', 'off', 'false'].includes(
    (params.get('dxr') || '').toLowerCase(),
  );
  const depth = Number(params.get('dxrDepth'));
  return {
    enabled: !off,
    simulate: (params.get('dxr') || '').toLowerCase() === 'sim',
    depth: Number.isFinite(depth) && depth >= 0 && depth <= 5 ? depth : 1,
  };
}

const scratchCenter = new Cesium.Cartesian2();
const scratchHit = new Cesium.Cartesian3();

/** Distance along the view axis to the ground at screen centre, world metres. */
export function convergenceDistance(scene) {
  const camera = scene.camera;
  const canvas = scene.canvas;
  scratchCenter.x = canvas.clientWidth / 2;
  scratchCenter.y = canvas.clientHeight / 2;
  let distance;
  try {
    const ray = camera.getPickRay(scratchCenter);
    const hit =
      ray && Cesium.IntersectionTests.rayEllipsoid(ray, Cesium.Ellipsoid.WGS84);
    if (hit) {
      const point = Cesium.Ray.getPoint(ray, hit.start, scratchHit);
      distance = Cesium.Cartesian3.distance(camera.positionWC, point);
    }
  } catch {
    /* fall through to the height estimate */
  }
  if (!(distance > 0)) {
    const height = camera.positionCartographic?.height;
    // Horizon/sky views (cockpit): converge a few heights out.
    distance = Number.isFinite(height) ? Math.abs(height) * 4 : 1e5;
  }
  return Math.min(Math.max(distance, MIN_CONVERGENCE_M), MAX_CONVERGENCE_M);
}

/**
 * The camera-rig descriptor for the current mono camera. metersToVirtual
 * scales the runtime's 63 mm eye separation so a point at infinity lands at
 * BASE_DISPARITY × depth of the window width (cameraRigDisparityPct inverted).
 */
export function cameraRig({ fovy, aspect, convergence, depth }) {
  const baseline =
    BASE_DISPARITY * depth * 2 * Math.tan(fovy / 2) * aspect * convergence;
  return {
    type: 'camera',
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    verticalFov: fovy,
    convergenceDiopters: 1 / convergence,
    ipdFactor: 1,
    parallaxFactor: 1,
    metersToVirtual: Math.max(baseline / 0.063, 1e-6),
  };
}

/**
 * Off-axis shift of an eye projection, as the frustum's near-plane offset per
 * metre of near distance: (r+l)/2n = P[8]/P[0], (t+b)/2n = P[9]/P[5]
 * (column-major WebGL projection).
 */
export function projectionSkew(m) {
  return {
    x: m[0] ? m[8] / m[0] : 0,
    y: m[5] ? m[9] / m[5] : 0,
  };
}

function saveCamera(camera, out = {}) {
  out.position = Cesium.Cartesian3.clone(camera.position, out.position);
  out.direction = Cesium.Cartesian3.clone(camera.direction, out.direction);
  out.up = Cesium.Cartesian3.clone(camera.up, out.up);
  out.right = Cesium.Cartesian3.clone(camera.right, out.right);
  out.transform = Cesium.Matrix4.clone(camera.transform, out.transform);
  return out;
}

function restoreCamera(camera, saved) {
  Cesium.Cartesian3.clone(saved.position, camera.position);
  Cesium.Cartesian3.clone(saved.direction, camera.direction);
  Cesium.Cartesian3.clone(saved.up, camera.up);
  Cesium.Cartesian3.clone(saved.right, camera.right);
}

// Cesium renders several frusta with different near planes and clones the
// camera frustum for each; an absolute xOffset would skew each one
// differently. Make the offset follow `near` on the frustum and its clones.
function setFrustumSkew(frustum, kx, ky) {
  frustum.__gevSkewed = true;
  const define = (target) => {
    Object.defineProperty(target, 'xOffset', {
      configurable: true,
      get() {
        return kx * this.near;
      },
      set() {},
    });
    Object.defineProperty(target, 'yOffset', {
      configurable: true,
      get() {
        return ky * this.near;
      },
      set() {},
    });
  };
  define(frustum);
  frustum.clone = function clone(result) {
    const copy = Cesium.PerspectiveFrustum.prototype.clone.call(this, result);
    define(copy);
    return copy;
  };
}

function clearFrustumSkew(frustum) {
  if (!frustum?.__gevSkewed) return;
  delete frustum.__gevSkewed;
  delete frustum.xOffset;
  delete frustum.yOffset;
  delete frustum.clone;
  frustum.xOffset = 0;
  frustum.yOffset = 0;
}

const scratchOffset = new Cesium.Cartesian3();

/** Move the camera to one eye: camera-space eye position, skewed frustum. */
function applyEye(camera, base, view) {
  const p = view.transform.position;
  const offset = scratchOffset;
  Cesium.Cartesian3.multiplyByScalar(base.right, p.x, offset);
  Cesium.Cartesian3.add(base.position, offset, camera.position);
  Cesium.Cartesian3.multiplyByScalar(base.up, p.y, offset);
  Cesium.Cartesian3.add(camera.position, offset, camera.position);
  // Camera space looks down -z, so +z is backwards along the view direction.
  Cesium.Cartesian3.multiplyByScalar(base.direction, -p.z, offset);
  Cesium.Cartesian3.add(camera.position, offset, camera.position);
  const skew = projectionSkew(view.projectionMatrix);
  if (camera.frustum instanceof Cesium.PerspectiveFrustum)
    setFrustumSkew(camera.frustum, skew.x, skew.y);
}

/**
 * Install DisplayXR stereo for a Cesium viewer. Resolves to a disposer, or to
 * null when the browser cannot weave (every non-DisplayXR browser).
 */
export async function installDisplayXR(
  viewer,
  {
    options = readOptions(),
    loadSdk = () => import('@displayxr/inline3d'),
  } = {},
) {
  if (!options.enabled) return null;
  if (options.simulate) loadSdk = async () => simulatedSdk();
  else if (!globalThis.navigator?.xr) return null;
  let sdk;
  try {
    sdk = await loadSdk();
  } catch {
    return null;
  }
  if (!sdk.inline3DAvailable?.()) return null;
  const wall = await sdk.createInline3D({ lazy: false });
  if (!wall?.supported || viewer.isDestroyed()) return null;

  const scene = viewer.scene;
  const camera = scene.camera;
  const source = scene.canvas;
  const output = document.createElement('canvas');
  output.className = 'gev-displayxr-stereo';
  output.setAttribute('aria-hidden', 'true');
  Object.assign(output.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    display: 'block',
  });
  source.insertAdjacentElement('afterend', output);
  const ctx = output.getContext('2d', { alpha: false });

  const base = {};
  // Read-only diagnostics for the console: globalThis.__gevDisplayXR.
  const stats = { frames: 0, eyes: 0, simulated: !!options.simulate };
  globalThis.__gevDisplayXR = stats;
  let eye = null;
  let active = false;
  let disposed = false;

  // Last-in-line hooks: the eye goes on after every app preRender listener,
  // and comes off before any postRender listener reads the camera.
  const preRender = scene.preRender;
  const postRender = scene.postRender;
  const originalPre = preRender.raiseEvent;
  const originalPost = postRender.raiseEvent;
  preRender.raiseEvent = function (...args) {
    const result = originalPre.apply(this, args);
    if (eye) applyEye(camera, base, eye);
    return result;
  };
  postRender.raiseEvent = function (...args) {
    if (eye) {
      restoreCamera(camera, base);
      clearFrustumSkew(camera.frustum);
    }
    return originalPost.apply(this, args);
  };

  const sizeOutput = () => {
    const w = Math.max(1, source.width) * 2;
    const h = Math.max(1, source.height);
    if (output.width !== w || output.height !== h) {
      output.width = w;
      output.height = h;
    }
  };

  const start = () => {
    if (active) return;
    active = true;
    viewer.useDefaultRenderLoop = false;
    holdContinuousRender(HOLD_ID);
  };
  const stop = () => {
    if (!active) return;
    active = false;
    eye = null;
    releaseContinuousRender(HOLD_ID);
    if (!disposed && !document.hidden) viewer.useDefaultRenderLoop = true;
    output.style.display = 'none';
  };

  // The app restores Cesium's loop on tab-visible; while weaving, the woven
  // frame loop owns rendering instead.
  const onVisibility = () => {
    if (active && !document.hidden) viewer.useDefaultRenderLoop = false;
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onFrame = (views) => {
    stats.frames++;
    if (disposed || viewer.isDestroyed()) return;
    if (!views || views.length < 2) return;
    start();
    output.style.display = 'block';
    sizeOutput();
    const widget = viewer.cesiumWidget;
    scene.initializeFrame();
    const time = viewer.clock.tick();
    if (widget && widget._canRender === false) return;
    saveCamera(camera, base);
    const frustum = camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum)
      handle.setViewRig(
        cameraRig({
          fovy: frustum.fovy,
          aspect: frustum.aspectRatio,
          convergence: convergenceDistance(scene),
          depth: options.depth,
        }),
      );
    for (const view of views) {
      const viewport = layerRef.getViewport(view);
      if (!viewport || !(viewport.width > 0) || !(viewport.height > 0))
        continue;
      eye = view;
      try {
        scene.render(time);
      } finally {
        if (eye) {
          // postRender did not run (nothing rendered): restore here.
          restoreCamera(camera, base);
          clearFrustumSkew(camera.frustum);
        }
        eye = null;
      }
      stats.eyes++;
      ctx.drawImage(
        source,
        0,
        0,
        source.width,
        source.height,
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height,
      );
    }
  };

  let layerRef = null;
  const handle = wall.addScene(
    output,
    (views, layer) => {
      layerRef = layer;
      onFrame(views);
    },
    {
      bufferClamped: true,
      viewRig: cameraRig({
        fovy: camera.frustum.fovy ?? 1,
        aspect: camera.frustum.aspectRatio ?? 1.6,
        convergence: convergenceDistance(scene),
        depth: options.depth,
      }),
      onLayerLost: stop,
    },
  );
  sizeOutput();

  return () => {
    if (disposed) return;
    stop();
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    preRender.raiseEvent = originalPre;
    postRender.raiseEvent = originalPost;
    try {
      handle.remove();
    } catch {
      /* already gone */
    }
    output.remove();
    if (!viewer.isDestroyed() && !document.hidden)
      viewer.useDefaultRenderLoop = true;
  };
}

/**
 * A stand-in for the DisplayXR SDK: two fixed eyes from the current rig,
 * converged at its convergence distance, rendered side by side every frame.
 */
export function simulatedSdk() {
  return {
    inline3DAvailable: () => true,
    async createInline3D() {
      return {
        supported: true,
        addScene(canvas, onFrame, opts = {}) {
          let rig = opts.viewRig ?? {};
          let raf = 0;
          const layer = {
            getViewport: (view) => ({
              x: view.eye === 'left' ? 0 : canvas.width / 2,
              y: 0,
              width: canvas.width / 2,
              height: canvas.height,
            }),
          };
          const views = () => {
            const half =
              0.0315 * (rig.ipdFactor ?? 1) * (rig.metersToVirtual || 1);
            const invD = rig.convergenceDiopters ?? 0;
            return ['left', 'right'].map((eye) => {
              const x = eye === 'left' ? -half : half;
              const m = new Float32Array(16);
              m[0] = 1;
              m[5] = 1;
              m[8] = -x * invD; // zero disparity at the convergence plane
              return {
                eye,
                transform: { position: { x, y: 0, z: 0 } },
                projectionMatrix: m,
              };
            });
          };
          const tick = () => {
            onFrame(views(), layer);
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
          return {
            setViewRig(next) {
              rig = next;
              return true;
            },
            remove() {
              cancelAnimationFrame(raf);
            },
          };
        },
      };
    },
  };
}
