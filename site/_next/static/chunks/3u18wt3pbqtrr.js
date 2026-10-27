(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,30050,e=>{"use strict";var t=e.i(40519),o=e.i(70087),n=e.i(64716);let a=`
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
}`,i=(e,t=0,o=1)=>Math.min(o,Math.max(t,e)),r=`
  uniform float uTime, uEnergy, uPixel, uMouseInf, uFade; uniform vec3 uMouse;
  attribute float aRand; varying float vMix; varying float vD; varying float vAlpha;
  void main(){
    vec3 n = normalize(position);
    float d = snoise(n * 1.6 + vec3(uTime * 0.25)) * (0.10 + uEnergy * 0.22);
    d += sin(n.y * 10.0 + uTime * 3.0) * 0.015 * (0.3 + uEnergy);
    d += pow(max(0.0, dot(n, uMouse)), 10.0) * 0.32 * uMouseInf;
    vec3 p = position + n * d;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Capped so dots near the camera never balloon, and faded as the camera passes through them.
    gl_PointSize = min((1.3 + aRand * 1.7 + max(d, 0.0) * 9.0) * (5.5 / -mv.z), 6.0) * uPixel;
    vMix = n.x * 0.5 + 0.5; vD = d;
    float facing = normalize(normalMatrix * n).z;
    vAlpha = (0.30 + 0.70 * smoothstep(-0.3, 0.8, facing)) * uFade * smoothstep(0.25, 1.6, -mv.z);
  }`,l=`
  uniform vec3 uA, uB, uC; varying float vMix; varying float vD; varying float vAlpha;
  void main(){
    vec2 c = gl_PointCoord - 0.5; float r = length(c); if (r > 0.5) discard;
    vec3 col = mix(uA, uB, smoothstep(0.0, 0.55, vMix)); col = mix(col, uC, smoothstep(0.55, 1.0, vMix));
    col += max(vD, 0.0) * 1.4;
    gl_FragColor = vec4(col, smoothstep(0.5, 0.0, r) * vAlpha);
  }`,s=[[2.05,"#25D366",.5,[1.25,0,.2],.5],[2.4,"#128C7E",.38,[1.05,.55,0],-.32],[2.8,"#34B7F1",.24,[1.45,-.4,.3],.22]];e.s(["createHeroScene",0,function(e,v,c,x){t.v0.enabled=!1;let d=new o.f({canvas:e,context:v,antialias:!0,alpha:!0,powerPreference:"high-performance"});d.setPixelRatio(x.pixelRatio),d.outputColorSpace=t.Rg;let p=new t.P6,u=new t.zm(45,1,.05,100);u.position.z=n.i;let y=new t.C9;p.add(y);let f=x.points,m=new t.ld;m.setAttribute("position",new t.f5(function(e){let t=new Float32Array(3*e),o=Math.PI*(3-Math.sqrt(5));for(let n=0;n<e;n++){let a=1-n/(e-1)*2,i=Math.sqrt(1-a*a),r=o*n;t[3*n]=Math.cos(r)*i*1.6,t[3*n+1]=1.6*a,t[3*n+2]=Math.sin(r)*i*1.6}return t}(f),3));let h=new Float32Array(f);for(let e=0;e<f;e++)h[e]=Math.random();m.setAttribute("aRand",new t.f5(h,1));let w=new t.Zg({uniforms:{uTime:{value:0},uEnergy:{value:.25},uPixel:{value:x.pixelRatio},uMouse:{value:new t.cE(0,0,1)},uMouseInf:{value:0},uFade:{value:1},uA:{value:new t.Es("#25D366")},uB:{value:new t.Es("#128C7E")},uC:{value:new t.Es("#34B7F1")}},vertexShader:a+r,fragmentShader:l,transparent:!0,depthWrite:!1,blending:t.tq});y.add(new t.sy(m,w));let g=function(){let e=document.createElement("canvas");e.width=e.height=64;let o=e.getContext("2d");if(o){let e=o.createRadialGradient(32,32,0,32,32,32);e.addColorStop(0,"rgba(255,255,255,1)"),e.addColorStop(.25,"rgba(220,248,198,.9)"),e.addColorStop(1,"rgba(37,211,102,0)"),o.fillStyle=e,o.fillRect(0,0,64,64)}return new t.Nk(e)}(),z=s.map(([e,o,n,a,i])=>{let r=new t.C9;r.rotation.set(...a),y.add(r);let l=[];for(let o=0;o<=256;o++){let n=o/256*Math.PI*2;l.push(new t.cE(Math.cos(n)*e,Math.sin(n)*e,0))}r.add(new t.XK(new t.ld().setFromPoints(l),new t.NQ({color:o,transparent:!0,opacity:n,blending:t.tq,depthWrite:!1})));let s=new t.C9;r.add(s);let v=new t.ld().setFromPoints([new t.cE(e,0,0),new t.cE(-e,0,0)]);return s.add(new t.sy(v,new t.Nj({size:.16,map:g,transparent:!0,depthWrite:!1,blending:t.tq}))),{g:r,spin:s,speed:i}}),M=new Float32Array(720),b=new Float32Array(720),C=new t.Es("#25D366"),A=new t.Es("#34B7F1"),E=new t.Es;for(let e=0;e<240;e++){let t=e/239;M[3*e]=-3.6+7.2*t,M[3*e+2]=.9,E.copy(C).lerp(A,t).multiplyScalar(Math.pow(Math.sin(t*Math.PI),1.4)),b[3*e]=E.r,b[3*e+1]=E.g,b[3*e+2]=E.b}let P=new t.ld;P.setAttribute("position",new t.f5(M,3)),P.setAttribute("color",new t.f5(b,3));let F=new t.NQ({vertexColors:!0,transparent:!0,blending:t.tq,depthWrite:!1});p.add(new t.DL(P,F));let S={x:0,y:0,inf:0,tinf:0},D=0,R=0,_=new t.as,q=w.uniforms;return{fit(t,o){let a=e.clientWidth,i=e.clientHeight;if(a&&i){if(d.setSize(a,i,!1),t){let e=(0,n.W)(a,i,o);u.fov=e.fov,u.aspect=e.aspect,u.setViewOffset(e.fullW,e.fullH,e.offsetX,e.offsetY,a,i)}else u.clearViewOffset(),u.fov=45,u.aspect=a/i;u.updateProjectionMatrix()}},render(e){for(let t of(c.energy+=(.22-c.energy)*.03,S.inf+=(S.tinf-S.inf)*.08,R+=(.35*S.x-R)*.04,D+=(-(.25*S.y)-D)*.04,y.rotation.y=.12*e+R,y.rotation.x=D,q.uTime.value=e,q.uEnergy.value=c.energy,q.uMouseInf.value=S.inf,q.uMouse.value.set(S.x,S.y,.7).normalize().applyQuaternion(_.copy(y.quaternion).invert()),z))t.spin.rotation.z+=.02*t.speed,t.g.rotation.z+=.0015;for(let t=0;t<240;t++){let o=M[3*t],n=Math.exp(-((o/1.7)**2));M[3*t+1]=-.72+n*(.04+.2*c.energy)*Math.sin(3.2*o+5*e)*Math.sin(.7*o-1.4*e)}P.attributes.position.needsUpdate=!0;let t=c.zoom;u.position.z=n.i-5.9*t,q.uFade.value=1-i((t-.55)/.45),F.opacity=i(1-2.2*t),d.render(p,u)},pointer(e,t){S.x=i(e,-1.5,1.5),S.y=i(t,-1.5,1.5),S.tinf=i(1.5-Math.hypot(S.x,S.y))},dispose(){p.traverse(e=>{(e instanceof t.sy||e instanceof t.DL)&&(e.geometry.dispose(),(Array.isArray(e.material)?e.material:[e.material]).forEach(e=>e.dispose()))}),g.dispose(),d.dispose()}}}],30050)}]);