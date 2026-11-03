// The assistant page's wave field: a grid of soft points whose height and size follow moving sine waves, seen from a
// low angle so the waves roll toward the viewer (the idea of Three.js's webgl_points_waves example, MIT; written here),
// drawn with the Three.js the agent serves. It shows behind an empty chat and that chat's first answer, and thinks while
// the answer streams: the waves quicken and rise, and the emerald brightens. It draws only while the page is visible;
// with reduced motion it draws one still frame; without WebGL it does nothing (the page's CSS glow stays). stop() frees
// its one WebGL context at once.

/** Points across and deep: about 2,500 on a laptop, 900 on a phone. */
const GRID = { laptop: [60, 42], phone: [25, 36] };
const PIXEL_MAX = 1.5;
/** How fast thinking eases in and out (a share per second). */
const EASE = 2.5;
/**
 * The grid starts 4 in front of the camera and recedes a row at a time to about 22.5; the camera stands 3 above it, looking
 * down 12°, so the field fills the lower 55-60% of the view, its far rows fading into the distance.
 */
const NEAR_Z = -4;
const ROW = { laptop: 0.45, phone: 0.53 };
const CAM_Y = 3;
/** The grid is as wide as the view this deep (deeper rows narrow into the distance, faded). */
const WIDE_AT = 18;
const HALF_FOV = Math.tan((25 * Math.PI) / 180);

// Two sines roll the rows toward the viewer; a point's size follows its height and shrinks with distance (to 12 px near).
const VERTEX = `uniform float uTime, uThink, uPixel; varying float vH, vA;
  void main(){ vec3 p = position;
    float h = 0.5 * sin(p.x * 0.7 + uTime * 1.2) + 0.5 * sin(p.z * 0.9 - uTime * 1.6);
    p.y += h * (0.42 + 0.18 * uThink); vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
    vH = h * 0.5 + 0.5; float d = -mv.z;
    gl_PointSize = min(50.0 * (0.75 + 0.5 * vH) * (1.0 + 0.15 * uThink) / d, 12.0) * uPixel;
    vA = smoothstep(26.0, 12.0, d) * smoothstep(1.0, 3.0, d); }`;
// Soft dots, teal to the core's emerald (#128C7E to #25D366) by height, brighter while thinking; on white, WhatsApp's
// muted greens, faint.
const FRAGMENT = `uniform float uThink, uLight; varying float vH, vA;
  void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard;
    vec3 dark = mix(vec3(0.071, 0.549, 0.494), vec3(0.145, 0.827, 0.4), vH); dark = mix(dark, vec3(0.49, 0.95, 0.66), uThink * vH * 0.55);
    vec3 light = mix(vec3(0.0, 0.502, 0.412), vec3(0.145, 0.827, 0.4), vH * 0.6);
    float a = smoothstep(0.5, 0.05, r) * vA * (0.35 + 0.65 * vH) * mix(0.8, 0.4, uLight) * (1.0 + 0.3 * uThink);
    gl_FragColor = vec4(mix(dark, light, uLight), min(a, 1.0)); }`;

/**
 * @typedef {{ reduceMotion: boolean, phone: boolean, parallax: boolean }} WaveOpts `parallax`: drift with the mouse.
 * @typedef {{ think: (on: boolean) => void, stop: () => void }} Waves
 */

/**
 * Starts the wave field on the canvas: its controls, or null without Three.js or WebGL.
 * @param {HTMLCanvasElement} canvas @param {WaveOpts} opts
 * @returns {Promise<Waves | null>}
 */
export async function startWaves(canvas, opts) {
  /** @type {any} */
  let THREE;
  // Served by the agent from node_modules (the vendor allowlist); a URL, so the type checker does not look for it.
  const url = '/dashboard/vendor/three.js';
  try {
    THREE = await import(url);
  } catch {
    return null;
  }
  return wavesWith(THREE, canvas, opts);
}

/**
 * The wave field drawn with this Three.js (startWaves loads the agent's; the tests hand one in).
 * @param {any} THREE @param {HTMLCanvasElement} canvas @param {WaveOpts} opts
 * @returns {Waves | null}
 */
export function wavesWith(THREE, canvas, opts) {
  /** @type {any} */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null; // no WebGL: the page works without the waves
  }
  THREE.ColorManagement.enabled = false;
  const pixel = Math.min(PIXEL_MAX, devicePixelRatio || 1);
  renderer.setPixelRatio(pixel);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 60);
  const size = opts.phone ? 'phone' : 'laptop';
  const [cols, rows] = GRID[size];
  const row = ROW[size];
  const look = new THREE.Vector3(0, CAM_Y - Math.tan((12 * Math.PI) / 180) * 10, -10);
  camera.position.set(0, CAM_Y, 0);
  camera.lookAt(look);

  const pos = new Float32Array(cols * rows * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  /** Lays the grid out as wide as the view at WIDE_AT. @param {number} aspect */
  const lay = (aspect) => {
    const half = HALF_FOV * aspect * WIDE_AT + 0.5;
    for (let r = 0, i = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, i += 3) {
        pos[i] = -half + (c / (cols - 1)) * half * 2;
        pos[i + 2] = NEAR_Z - r * row;
      }
    }
    geo.getAttribute('position').needsUpdate = true;
  };
  const light = () => (document.documentElement.dataset.theme === 'light' ? 1 : 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uThink: { value: 0 }, uPixel: { value: pixel }, uLight: { value: light() } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // the waves move in the shader
  scene.add(points);
  const u = mat.uniforms;

  let aspect = 0;
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    if (Math.abs(camera.aspect - aspect) > 0.05) lay((aspect = camera.aspect));
  };
  /** Thinking, eased toward `want`; the waves' phase, so a change of speed never jumps. */
  let think = 0;
  let want = 0;
  let phase = 2;
  let last = 0;
  let raf = 0;
  let stopped = false;
  const mouse = { x: 0, y: 0 };
  const draw = () => {
    u.uTime.value = phase;
    u.uThink.value = think;
    renderer.render(scene, camera);
  };
  const frame = (/** @type {number} */ now) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    think += (want - think) * Math.min(1, dt * EASE);
    phase += dt * (0.55 + 0.75 * think);
    if (opts.parallax) {
      camera.position.x += (mouse.x * 1.2 - camera.position.x) * 0.04;
      camera.position.y += (CAM_Y - mouse.y * 0.4 - camera.position.y) * 0.04;
      camera.lookAt(look);
    }
    draw();
    raf = requestAnimationFrame(frame);
  };
  const play = () => {
    if (raf || stopped || opts.reduceMotion || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  };
  const pause = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisible = () => (document.hidden ? pause() : play());
  const onMove = (/** @type {PointerEvent} */ e) => {
    mouse.x = e.clientX / innerWidth - 0.5;
    mouse.y = e.clientY / innerHeight - 0.5;
  };
  // A new size clears the canvas: the still frame is drawn again (the moving one draws on its next frame).
  const sized = new ResizeObserver(() => {
    fit();
    if (!raf) draw();
  });
  const themed = new MutationObserver(() => {
    u.uLight.value = light();
    if (!raf) draw();
  });

  fit();
  sized.observe(canvas);
  themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', onVisible);
  if (opts.reduceMotion) draw();
  else {
    if (opts.parallax) addEventListener('pointermove', onMove, { passive: true });
    play();
  }
  return {
    think(on) {
      want = on ? 1 : 0;
      if (opts.reduceMotion) {
        think = want;
        draw();
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      pause();
      sized.disconnect();
      themed.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('pointermove', onMove);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss(); // the context goes now, not when the page is collected
    },
  };
}
