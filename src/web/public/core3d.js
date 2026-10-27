// The sign-in page's particle core (the same agent core as the website), drawn with Three.js served by the agent.
// Loaded only for the sign-in page. With reduced motion it draws one still frame; without WebGL it does nothing.

// Simplex noise (Ashima Arts / Stefan Gustavson, MIT), shared with the website's script.
const SNOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

/**
 * Starts the core on the canvas. Returns a stop function (stops drawing and frees the GPU resources).
 * @param {HTMLCanvasElement} canvas @param {{ reduceMotion: boolean }} opts
 * @returns {Promise<() => void>}
 */
export async function startCore(canvas, opts) {
  /** @type {any} */
  let THREE;
  // Served by the agent from node_modules (the vendor allowlist); a URL, so the type checker does not look for it.
  const url = '/dashboard/vendor/three.js';
  try {
    THREE = await import(url);
  } catch {
    return () => {};
  }
  /** @type {any} */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return () => {}; // no WebGL: the page works without the core
  }
  THREE.ColorManagement.enabled = false;
  const pixel = Math.min(2, devicePixelRatio || 1);
  renderer.setPixelRatio(pixel);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  camera.position.z = 6.4;
  const core = new THREE.Group();
  scene.add(core);

  const N = 11000;
  const pos = new Float32Array(N * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    pos[i * 3] = Math.cos(th) * r * 1.6;
    pos[i * 3 + 1] = y * 1.6;
    pos[i * 3 + 2] = Math.sin(th) * r * 1.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixel: { value: pixel } },
    vertexShader: SNOISE + `uniform float uTime, uPixel; varying float vMix, vA;
      void main(){ vec3 n = normalize(position); float d = snoise(n * 1.5 + vec3(uTime * 0.22)) * 0.16; vec4 mv = modelViewMatrix * vec4(position + n * d, 1.0);
        gl_Position = projectionMatrix * mv; gl_PointSize = min((2.3 + max(d, 0.0) * 9.0) * (5.5 / -mv.z), 6.0) * uPixel; vMix = n.x * 0.5 + 0.5;
        vA = 0.3 + 0.7 * smoothstep(-0.3, 0.8, normalize(normalMatrix * n).z); }`,
    fragmentShader: `varying float vMix, vA; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard;
        vec3 c = mix(vec3(0.145,0.827,0.4), vec3(0.071,0.549,0.494), smoothstep(0.0,0.55,vMix)); c = mix(c, vec3(0.204,0.718,0.945), smoothstep(0.55,1.0,vMix));
        gl_FragColor = vec4(c, smoothstep(0.5, 0.0, r) * vA); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  core.add(new THREE.Points(geo, mat));
  /** @type {any[]} */
  const disposables = [geo, mat];
  for (const [radius, color, opacity, rot] of /** @type {const} */ ([[2.1, '#25D366', 0.45, [1.2, 0, 0.2]], [2.5, '#34B7F1', 0.25, [1.4, -0.5, 0.3]]])) {
    const pts = [];
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    const lg = new THREE.BufferGeometry().setFromPoints(pts);
    const lm = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    const loop = new THREE.LineLoop(lg, lm);
    loop.rotation.set(rot[0], rot[1], rot[2]);
    core.add(loop);
    disposables.push(lg, lm);
  }

  const fit = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  };
  const mouse = { x: 0, y: 0 };
  const onMove = (/** @type {PointerEvent} */ e) => {
    mouse.x = e.clientX / innerWidth - 0.5;
    mouse.y = e.clientY / innerHeight - 0.5;
  };
  const draw = (/** @type {number} */ t) => {
    mat.uniforms.uTime.value = t;
    core.rotation.y = t * 0.1 + mouse.x * 0.5;
    core.rotation.x += (mouse.y * 0.4 - core.rotation.x) * 0.04;
    renderer.render(scene, camera);
  };
  fit();
  addEventListener('resize', fit);
  let raf = 0;
  if (opts.reduceMotion) draw(0);
  else {
    addEventListener('pointermove', onMove, { passive: true });
    const start = performance.now();
    const loop = (/** @type {number} */ now) => {
      draw((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener('resize', fit);
    removeEventListener('pointermove', onMove);
    for (const d of disposables) d.dispose();
    renderer.dispose();
  };
}
