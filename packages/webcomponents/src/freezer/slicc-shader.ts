import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

/**
 * The SLICC background field — a single WebGL element with THREE program modes,
 * lifted from the prototype's shared `#bg-canvas` (proto/StellarRubySwift.html,
 * `__sliccShaders`): `cone` (a sheared waffle lattice that behaves like a
 * probabilistic Game of Life near a floating focal point), `scoop` (a lush
 * flowing ice-cream gradient that swirls and breathes), and `freezer` (water
 * crystallizing into ice from the corner). One canvas, one program swapped by
 * the `mode` attribute — exactly as the prototype swaps `FRAG_CONE` / `FRAG_SCOOP`
 * / `FRAG_FREEZER`.
 *
 * Sits behind the app (`position: fixed; inset: 0; z-index: 0; pointer-events:
 * none`). Honors `prefers-reduced-motion` (one static frame), pauses on
 * disconnect, and falls back to a per-mode CSS gradient when WebGL is absent.
 *
 * @attr mode - `cone` (default) | `scoop` | `freezer`
 * @attr tint - CSS color washed into the scoop field / event glow (the active accent)
 * @attr coverage - 0..1 freezer frost growth (feeds `u_freeze`)
 * @attr scroll - chat scroll offset in CSS px; pans the field with the content
 * @attr intensity - multiplier for coverage (freezer)
 * @attr no-webgl - reflected when WebGL is unavailable (CSS fallback)
 * @csspart canvas - the WebGL canvas
 */

const VERT = 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos,0.0,1.0); }';

// Full uniform header + fbm noise — the prototype's HEAD + NOISE. Every program
// declares the full set so a single render path can feed them; unused uniforms
// are harmless.
const HEAD = `precision highp float;
uniform vec2 u_res; uniform float u_time; uniform float u_energy;
uniform vec2 u_center; uniform vec3 u_evt; uniform float u_freeze; uniform float u_dark;
uniform float u_density; uniform float u_falloff; uniform float u_life;
uniform float u_blink; uniform float u_thick; uniform vec3 u_tint; uniform float u_scroll;
vec3 themeBg(){ return mix(vec3(0.97,0.95,0.89), vec3(0.09,0.08,0.06), u_dark); }`;

const NOISE = `
float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p);
  float a=hash21(i),b=hash21(i+vec2(1.,0.)),c=hash21(i+vec2(0.,1.)),d=hash21(i+vec2(1.,1.));
  vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float v=0.,a=0.5; for(int i=0;i<5;i++){ v+=a*vnoise(p); p=p*2.02+vec2(7.1,3.7); a*=0.5;} return v; }
vec2 warp(vec2 p, float t){ float a=fbm(p+vec2(0.0,1.7)+t*0.10); float b=fbm(p+vec2(5.2,1.3)-t*0.08); return p+0.85*vec2(a,b); }`;

const FRAG_CONE = `${HEAD}${NOISE}
float cellCycle(vec2 q){ float s=hash21(q+11.7);
  return 0.5+0.32*sin(u_time*u_blink+s*6.2831)+0.18*sin(u_time*0.6*u_blink+s*19.0); }
void main(){
  vec2 uv=gl_FragCoord.xy/u_res; float aspect=u_res.x/u_res.y;
  vec2 p=uv-0.5; p.x*=aspect; vec2 c=u_center-0.5; c.x*=aspect;
  vec3 bg=themeBg(); float dist=length(p-c);
  /* Chat scroll pans the (periodic) lattice with the content. */
  p.y-=u_scroll;
  float ca=cos(0.7853981634), sa=sin(0.7853981634);
  vec2 pr=mat2(ca,-sa,sa,ca)*p; float cells=12.0; vec2 g=pr*cells; g.x+=g.y*0.5;
  vec2 id=floor(g); vec2 f=fract(g)-0.5;
  float dia=mix(length(f),abs(f.x)+abs(f.y),0.82);
  float ph=hash21(id)*6.2831; float radius=0.42+0.05*sin(u_time*0.5+ph);
  float aa=2.2/cells; float outline=smoothstep(u_thick+aa,u_thick,abs(dia-radius));
  float seedDen=clamp(u_density+u_energy*0.20*exp(-dist*2.0),0.0,1.0);
  float selfCyc=cellCycle(id); float selfSoft=smoothstep(-0.05,0.05,seedDen-selfCyc);
  float selfHard=step(selfCyc,seedDen); float nbs=0.0;
  for(int j=-1;j<=1;j++){ for(int i=-1;i<=1;i++){ if(i==0&&j==0) continue;
    vec2 nb=id+vec2(float(i),float(j)); nbs+=step(cellCycle(nb),seedDen); } }
  float survive=smoothstep(1.5,1.9,nbs)-smoothstep(3.1,3.5,nbs);
  float birth=smoothstep(2.6,3.0,nbs)-smoothstep(3.0,3.4,nbs);
  float gol=clamp(selfHard*survive+(1.0-selfHard)*birth,0.0,1.0);
  float golMix=1.0-smoothstep(0.0,max(u_life,0.001),dist);
  float onState=mix(selfSoft,gol,golMix);
  float falloff=clamp(1.0-u_falloff*max(dist-0.12,0.0),0.0,1.0);
  falloff=clamp(falloff+u_energy*0.30*exp(-dist*2.0),0.0,1.0); onState*=falloff;
  float bevel=clamp(0.5-(f.x-f.y)*0.9,0.0,1.0);
  vec3 lineCol=mix(vec3(0.78,0.55,0.30),vec3(0.86,0.62,0.36),u_dark);
  vec3 hiCol=mix(vec3(0.90,0.72,0.46),vec3(0.92,0.74,0.48),u_dark);
  vec3 tint=mix(lineCol,hiCol,bevel*0.6); float stroke=outline*onState;
  // Low-contrast lattice: chat prose sits DIRECTLY on this field (the frosted
  // reading card is gone), so strokes stay close to the base color — toward
  // the light bg in light mode, toward the dark bg in dark mode.
  vec3 col=mix(bg,tint,clamp(stroke*0.20,0.0,0.20));
  col+=u_evt*u_energy*stroke*exp(-dist*dist*4.0)*0.18;
  gl_FragColor=vec4(col,1.0);
}`;

const FRAG_SCOOP = `${HEAD}${NOISE}
vec3 pal(float t){ vec3 strawberry=vec3(1.0,0.45,0.62); vec3 vanilla=vec3(1.0,0.95,0.82);
  vec3 pistachio=vec3(0.60,0.86,0.52);
  vec3 col=mix(strawberry,vanilla,smoothstep(0.0,0.5,t)); col=mix(col,pistachio,smoothstep(0.5,1.0,t)); return col; }
void main(){
  vec2 uv=gl_FragCoord.xy/u_res; float aspect=u_res.x/u_res.y;
  vec2 p=uv-0.5; p.x*=aspect; p.y-=u_scroll; vec2 c=u_center-0.5; c.x*=aspect;
  vec3 bg=mix(themeBg(),u_tint,0.14); vec2 sp=p-c; float r=length(sp); float a=atan(sp.y,sp.x);
  float breathe=1.0+0.06*sin(u_time*0.4);
  float swirl=a+r*(2.2+0.8*sin(u_time*0.15))-u_time*0.18-u_energy*2.0*exp(-r*2.0);
  vec2 q=vec2(cos(swirl),sin(swirl))*r*breathe;
  vec2 w=warp(q*1.8+vec2(0.0,u_time*0.06),u_time);
  float n=fbm(w*1.4); n+=0.4*fbm(w*2.6-u_time*0.05); n=clamp(n/1.4,0.0,1.0);
  float ribbon=fbm(w*2.2+n*1.5); float t=clamp(n*0.7+ribbon*0.4,0.0,1.0);
  vec3 ice=pal(t); float hl=smoothstep(0.45,0.7,ribbon); ice=mix(ice,ice+vec3(0.18),hl*0.6);
  ice=mix(ice,u_tint,clamp(0.32+hl*0.30,0.0,0.85)); ice+=u_energy*u_evt*0.4*exp(-r*1.5);
  ice*=0.95+0.08*sin(u_time*0.4); float mask=smoothstep(0.62,0.0,r);
  vec3 col=mix(bg,ice,clamp(mask,0.0,1.0)*0.80); col+=ice*mask*hl*0.12;
  gl_FragColor=vec4(col,1.0);
}`;

const FRAG_FREEZER = `${HEAD}${NOISE}
/* Inside-of-a-freezer ground: icy WHITE in light mode (never the warm theme
   canvas — blue-on-beige read as sand, not frost), cold blue-black in dark. */
vec3 freezerBg(){ return mix(vec3(0.965,0.98,1.0), vec3(0.05,0.08,0.13), u_dark); }
void main(){
  vec2 uv=gl_FragCoord.xy/u_res; uv.y-=u_scroll; float aspect=u_res.x/u_res.y; vec2 p=(uv-0.5); p.x*=aspect;
  /* Glacial clock: frost creeps, it never flows. */
  float t=u_time*0.08;
  vec3 iceCol=mix(vec3(0.55,0.80,1.0),vec3(0.36,0.52,0.78),u_dark);
  vec3 deepIce=mix(vec3(0.20,0.44,0.84),vec3(0.12,0.24,0.46),u_dark);
  vec3 bg=mix(freezerBg(),iceCol,0.10); float dc=distance(uv,vec2(0.0,0.0));
  float ragged=0.10*fbm(uv*6.0+3.0)+0.05*fbm(uv*14.0); float front=u_freeze*0.66+ragged-0.05;
  float edge=front-dc; float frozen=smoothstep(-0.04,0.06,edge); float wetBand=smoothstep(0.12,0.0,abs(edge));
  float ripple=0.015*sin(dc*40.0-t*0.4)*frozen; vec2 q=uv*aspect+vec2(ripple,ripple*0.5);
  float crystals=fbm(q*9.0); crystals+=0.5*fbm(q*20.0+4.0); crystals/=1.5;
  float facet=smoothstep(0.45,0.55,crystals); float veins=smoothstep(0.03,0.0,abs(fract(crystals*6.0)-0.5)-0.02);
  vec3 col=bg; vec3 wet=mix(bg,iceCol,0.5); float wetSpec=pow(clamp(fbm(uv*10.0-t*0.2),0.0,1.0),2.0);
  wet+=wetSpec*vec3(1.0)*0.25; col=mix(col,wet,wetBand*0.45);
  vec3 frost=mix(deepIce,iceCol,facet); frost+=veins*vec3(1.0)*0.30;
  float spark=smoothstep(0.92,1.0,fbm(uv*30.0))*(0.5+0.5*sin(t*0.6+crystals*20.0));
  frost+=spark*vec3(1.0)*0.4*frozen; col=mix(col,frost,frozen*0.85);
  float rim=smoothstep(0.05,0.0,abs(edge))*0.6; col+=rim*iceCol;
  /* The field is a BACKGROUND: chat prose sits directly on it, so the final
     wash pins the whole pattern close to the icy ground — the same ~20%
     deviation budget the cone lattice uses (strokes at 0.20 toward tint). */
  col=mix(freezerBg(),col,0.22);
  gl_FragColor=vec4(col,1.0);
}`;

export type ShaderMode = 'cone' | 'scoop' | 'freezer';
const PROGRAMS: Record<ShaderMode, string> = {
  cone: FRAG_CONE,
  scoop: FRAG_SCOOP,
  freezer: FRAG_FREEZER,
};
/** Fragment sources, exposed so tests can compile and pixel-probe the fields. */
export const SHADER_FRAGMENTS: Readonly<Record<ShaderMode, string>> = PROGRAMS;
const MODES = new Set<ShaderMode>(['cone', 'scoop', 'freezer']);

const FALLBACK: Record<ShaderMode, string> = {
  cone: 'radial-gradient(120% 120% at 35% 45%, color-mix(in srgb,#e0a866 40%,var(--bg)) 0%, var(--bg) 60%)',
  scoop:
    'radial-gradient(120% 120% at 40% 50%, color-mix(in srgb,#ff9bc0 40%,var(--bg)) 0%, var(--bg) 62%)',
  freezer:
    'radial-gradient(120% 120% at 0% 100%, color-mix(in srgb,#7fb0e6 55%,var(--bg)) 0%, var(--bg) 70%)',
};

const STYLE = `
:host { position: relative; display: block; pointer-events: none; }
.canvas, .fallback { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.fallback { display: none; }
:host([no-webgl]) .canvas { display: none; }
:host([no-webgl]) .fallback { display: block; }`;
const SHEET = sheet(STYLE);

const MAX_DPR = 2;

/** Fraction of the chat scroll the field pans by (1 = attached, 0 = static). */
const SCROLL_PARALLAX = 0.35;
const UNIFORMS = [
  'u_res',
  'u_scroll',
  'u_time',
  'u_energy',
  'u_center',
  'u_evt',
  'u_freeze',
  'u_dark',
  'u_density',
  'u_falloff',
  'u_life',
  'u_blink',
  'u_thick',
  'u_tint',
] as const;
type UniformName = (typeof UNIFORMS)[number];

function clampNum(v: number, lo: number, hi: number, fb: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb;
}

/** Parse a CSS color via getComputedStyle into a 0..1 rgb triple. */
function colorToVec3(css: string, fallback: [number, number, number]): [number, number, number] {
  if (!css || typeof getComputedStyle !== 'function') return fallback;
  const probe = document.createElement('span');
  probe.style.color = css;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const m = resolved.match(/[\d.]+/g)?.map(Number);
  if (!m || m.length < 3) return fallback;
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}

export class SliccShader extends HTMLElement {
  static readonly observedAttributes = ['mode', 'tint', 'coverage', 'intensity', 'scroll'];

  readonly #root: ShadowRoot;
  #canvas: HTMLCanvasElement | null = null;
  #gl: WebGLRenderingContext | null = null;
  #program: WebGLProgram | null = null;
  #buffer: WebGLBuffer | null = null;
  #loc: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
  #aPos = -1;
  #raf = 0;
  #start = 0;
  #energy = 0;
  #ro: ResizeObserver | null = null;
  #reduced = false;
  #builtMode: ShaderMode | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    const canvas = h('canvas', { class: 'canvas', part: 'canvas' }) as HTMLCanvasElement;
    const fallback = h('div', { class: 'fallback', part: 'fallback', 'aria-hidden': 'true' });
    this.#root.replaceChildren(canvas, fallback);
    this.#canvas = canvas;
  }

  connectedCallback(): void {
    this.#reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#applyFallbackBg();
    if (!this.#initGl()) {
      this.setAttribute('no-webgl', '');
      return;
    }
    this.removeAttribute('no-webgl');
    if (typeof ResizeObserver !== 'undefined') {
      this.#ro = new ResizeObserver(() => this.#renderIfStatic());
      this.#ro.observe(this);
    }
    this.#start = performance.now() / 1000;
    if (this.#reduced) this.#renderFrame();
    else this.#startLoop();
  }

  disconnectedCallback(): void {
    this.#stopLoop();
    this.#ro?.disconnect();
    this.#ro = null;
    this.#dispose();
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    if (name === 'mode' && this.#gl && this.mode !== this.#builtMode) {
      this.#linkMode();
    }
    this.#applyFallbackBg();
    this.#renderIfStatic();
  }

  /** Active program. */
  get mode(): ShaderMode {
    const m = this.getAttribute('mode') as ShaderMode | null;
    return m && MODES.has(m) ? m : 'cone';
  }
  set mode(value: ShaderMode) {
    this.setAttribute('mode', value);
  }

  /** Freezer frost growth 0..1. */
  get coverage(): number {
    return clampNum(Number.parseFloat(this.getAttribute('coverage') ?? ''), 0, 1, 0.66);
  }
  set coverage(value: number) {
    this.setAttribute('coverage', String(value));
  }

  get intensity(): number {
    return clampNum(Number.parseFloat(this.getAttribute('intensity') ?? ''), 0, 4, 1);
  }
  set intensity(value: number) {
    this.setAttribute('intensity', String(value));
  }

  /**
   * Chat scroll offset in CSS px — the field pans with the content. Reflects
   * the `scroll` attribute; named `scrollOffset` because `HTMLElement` already
   * defines a `scroll()` method.
   */
  get scrollOffset(): number {
    const n = Number.parseFloat(this.getAttribute('scroll') ?? '');
    return Number.isFinite(n) ? n : 0;
  }
  set scrollOffset(value: number) {
    this.setAttribute('scroll', String(value));
  }

  get noWebgl(): boolean {
    return this.hasAttribute('no-webgl');
  }

  /** Bump the reactive energy (an event landed) — glows + surges briefly. */
  pulse(amount = 1): void {
    this.#energy = Math.min(1.4, this.#energy + amount);
    if (this.#reduced) this.#renderFrame();
  }

  // ---- internals ----

  #applyFallbackBg(): void {
    const fb = this.#root.querySelector<HTMLElement>('.fallback');
    if (fb) fb.style.background = FALLBACK[this.mode];
  }

  #renderIfStatic(): void {
    if (this.#reduced && this.#gl) this.#renderFrame();
  }

  #compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  #linkMode(): boolean {
    const gl = this.#gl;
    if (!gl) return false;
    const vs = this.#compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = this.#compile(gl, gl.FRAGMENT_SHADER, PROGRAMS[this.mode]);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    if (this.#program) gl.deleteProgram(this.#program);
    this.#program = prog;
    gl.useProgram(prog);
    this.#aPos = gl.getAttribLocation(prog, 'a_pos');
    this.#loc = {};
    for (const u of UNIFORMS) this.#loc[u] = gl.getUniformLocation(prog, u);
    this.#builtMode = this.mode;
    return true;
  }

  #initGl(): boolean {
    const cv = this.#canvas;
    if (!cv) return false;
    const opts: WebGLContextAttributes = { premultipliedAlpha: true, alpha: true, antialias: true };
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = (cv.getContext('webgl', opts) ??
        cv.getContext('experimental-webgl', opts)) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return false;
    this.#gl = gl;
    if (!this.#linkMode()) {
      this.#gl = null;
      return false;
    }
    const buf = gl.createBuffer();
    if (!buf) {
      this.#gl = null;
      return false;
    }
    this.#buffer = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    return true;
  }

  #resize(): void {
    const cv = this.#canvas;
    if (!cv) return;
    const dpr = Math.min(MAX_DPR, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.max(1, (cv.clientWidth * dpr) | 0);
    const h = Math.max(1, (cv.clientHeight * dpr) | 0);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
  }

  #darkUniform(): number {
    if (typeof getComputedStyle !== 'function') return 0;
    const ink = getComputedStyle(this).getPropertyValue('--ink').trim();
    if (!ink) return 0;
    // Resolve --ink (hex / rgb / named — `getPropertyValue` returns it verbatim,
    // which for this token is HEX) to a 0..1 rgb triple via a probe, then read its
    // luminance: in dark mode --ink is LIGHT, which drives the dark shader. A naive
    // `/[\d.]+/` parse silently mis-reads hex (e.g. `#f5f5f2` → [5,5,2]) and would
    // pin the shader to its light palette in dark mode.
    const [r, g, b] = colorToVec3(ink, [0, 0, 0]);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 1 : 0;
  }

  #renderFrame(): void {
    const gl = this.#gl;
    const cv = this.#canvas;
    const prog = this.#program;
    if (!gl || !cv || !prog || !this.#buffer) return;
    this.#resize();
    const t = performance.now() / 1000 - this.#start;
    // Floating focal point — the prototype's slow ambient orbit (`centerFor`):
    // a very low-frequency drift (periods ~52s / ~65s), not a fast lissajous.
    const s = 0.5 + 0.5 * Math.sin(t * 0.12);
    const s2 = 0.5 + 0.5 * Math.sin(t * 0.097 + 1.0);
    const cx = 0.2 * (1 - s) + 0.46 * s;
    const cy = 0.74 * (1 - s2) + 0.3 * s2;
    const dark = this.#darkUniform();
    const tint = colorToVec3(this.getAttribute('tint') ?? '', [0.545, 0.361, 0.965]);
    const evt = colorToVec3(this.getAttribute('tint') ?? '', [0.957, 0.247, 0.369]);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(this.#aPos);
    gl.vertexAttribPointer(this.#aPos, 2, gl.FLOAT, false, 0, 0);
    const u = this.#loc;
    gl.uniform2f(u.u_res ?? null, cv.width, cv.height);
    gl.uniform1f(u.u_time ?? null, t);
    gl.uniform1f(u.u_energy ?? null, this.#energy);
    gl.uniform2f(u.u_center ?? null, cx, cy);
    gl.uniform3f(u.u_evt ?? null, evt[0], evt[1], evt[2]);
    gl.uniform1f(u.u_freeze ?? null, clampNum(this.coverage * this.intensity, 0, 1, 0.66) * 2.2);
    gl.uniform1f(u.u_dark ?? null, dark);
    // Scroll arrives in CSS px; the pattern space is viewport-height units.
    // Parallax: the field pans at a fraction of the content scroll — a 1:1
    // rate reads as "attached" (zero depth); the lag is what sells distance.
    gl.uniform1f(
      u.u_scroll ?? null,
      (this.scrollOffset * SCROLL_PARALLAX) / Math.max(1, cv.clientHeight || cv.height)
    );
    // Cone-mode knobs — pulled verbatim from the prototype's frame loop. u_blink
    // in particular is 0.05 (NOT 1.0): the Game-of-Life cells breathe slowly.
    gl.uniform1f(u.u_density ?? null, 0.29);
    gl.uniform1f(u.u_falloff ?? null, 0.3);
    gl.uniform1f(u.u_life ?? null, 0.35);
    gl.uniform1f(u.u_blink ?? null, 0.05);
    gl.uniform1f(u.u_thick ?? null, 0.02);
    gl.uniform3f(u.u_tint ?? null, tint[0], tint[1], tint[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Energy decays toward rest.
    this.#energy *= 0.95;
    if (this.#energy < 0.001) this.#energy = 0;
  }

  #startLoop(): void {
    if (this.#raf) return;
    const tick = (): void => {
      this.#renderFrame();
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  #stopLoop(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #dispose(): void {
    const gl = this.#gl;
    if (gl) {
      if (this.#buffer) gl.deleteBuffer(this.#buffer);
      if (this.#program) gl.deleteProgram(this.#program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.#gl = null;
    this.#program = null;
    this.#buffer = null;
    this.#builtMode = null;
  }
}

define('slicc-shader', SliccShader);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-shader': SliccShader;
  }
}
