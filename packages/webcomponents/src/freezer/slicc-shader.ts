import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { advanceFrameTs, BURST_MS, shouldRender } from './frame-budget.js';

/**
 * The SLICC background field — a single WebGL element with three program modes:
 * `cone` (caramelized glass with Voronoi fractures), `scoop` (a lush flowing
 * ice-cream gradient that swirls and breathes), and `freezer` (water
 * crystallizing into ice from the corner). One canvas, one program swapped by
 * the `mode` attribute.
 *
 * Sits behind the app (`position: fixed; inset: 0; z-index: 0; pointer-events:
 * none`). Renders on a frame budget: ambient motion at 15 fps, bursting to
 * display rate for 800 ms after an interactive stimulus (pulse, attribute /
 * theme / size changes). A static field — `cone` with `speed=0`, or
 * `prefers-reduced-motion` — renders once per stimulus and stops the loop
 * entirely. Pauses on disconnect and falls back to a per-mode CSS gradient
 * when WebGL is absent.
 *
 * @attr mode - `cone` (default) | `scoop` | `freezer`
 * @attr tint - CSS color washed into the scoop field / event glow (the active accent)
 * @attr coverage - 0..1 freezer frost growth / cone glass density and geometry
 * @attr speed - 0..2 cone glass animation rate multiplier (default 0.0625;
 *   0 genuinely pauses — the field renders once per change and stops)
 * @attr dpr - canvas resolution cap in device-pixel-ratio units (0.5..2,
 *   default 1 — the washed background field does not need Retina density)
 * @attr scroll - chat scroll offset in CSS px; pans the field with the content
 * @attr intensity - multiplier for coverage (freezer)
 * @attr no-webgl - reflected when WebGL is unavailable (CSS fallback)
 * @csspart canvas - the WebGL canvas
 */

const VERT = 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos,0.0,1.0); }';

// Shared uniform header + fbm noise. Every declared uniform is read by at least
// one program so the common render path contains no dead uniform plumbing.
const HEAD = `precision highp float;
uniform vec2 u_res; uniform float u_time; uniform float u_energy;
uniform vec2 u_center; uniform vec3 u_evt; uniform float u_freeze; uniform float u_dark;
uniform float u_falloff; uniform float u_life; uniform vec3 u_tint; uniform float u_scroll;
uniform float u_brightness; uniform float u_contrast; uniform float u_noise; uniform float u_blur;
vec3 themeBg(){ return mix(vec3(0.97,0.95,0.89), vec3(0.09,0.08,0.06), u_dark); }`;

const NOISE = `
float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p);
  float a=hash21(i),b=hash21(i+vec2(1.,0.)),c=hash21(i+vec2(0.,1.)),d=hash21(i+vec2(1.,1.));
  vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float v=0.,a=0.5; for(int i=0;i<5;i++){ v+=a*vnoise(p); p=p*2.02+vec2(7.1,3.7); a*=0.5;} return v; }
vec2 warp(vec2 p, float t){ float a=fbm(p+vec2(0.0,1.7)+t*0.10); float b=fbm(p+vec2(5.2,1.3)-t*0.08); return p+0.85*vec2(a,b); }`;

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
     deviation budget the cone glass uses. */
  col=mix(freezerBg(),col,0.22);
  gl_FragColor=vec4(col,1.0);
}`;

// Sugar Glass adapted from pbakaus/radiant (MIT), static/sugar-glass.html.
// Uniform mapping: u_time*(u_life+0.15)*u_speed is crack speed; u_falloff is light
// bleed; u_center replaces mouse parallax; u_scroll pans the field; u_tint
// washes the glass; u_energy/u_evt pulse at u_center; u_dark selects palette.
const FRAG_SUGAR = `${HEAD}${NOISE}
uniform float u_speed;
vec2 sugarHash(vec2 p){ p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p)*43758.5453123); }
vec3 sugarVoronoi(vec2 p,float t){
  vec2 n=floor(p),f=fract(p),nearPt=vec2(0.0),nearCell=vec2(0.0); float minDist=8.0;
  for(int j=-1;j<=1;j++){ for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j));
    vec2 o=sugarHash(n+g)*0.5+0.25; o=0.5+0.4*sin(t*0.3+6.2831*o); vec2 d=g+o-f; float dd=dot(d,d);
    if(dd<minDist){ minDist=dd; nearPt=d; nearCell=n+g; } } }
  float edge=8.0;
  for(int j=-1;j<=1;j++){ for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j));
    vec2 o=sugarHash(n+g)*0.5+0.25; o=0.5+0.4*sin(t*0.3+6.2831*o); vec2 d=g+o-f; vec2 delta=d-nearPt;
    if(dot(delta,delta)>0.001) edge=min(edge,dot(0.5*(nearPt+d),normalize(delta))); } }
  return vec3(sqrt(minDist),edge,hash21(nearCell));
}
float sugarEdge(vec2 p,float t){
  vec2 n=floor(p),f=fract(p),nearPt=vec2(0.0); float minDist=8.0;
  for(int j=-1;j<=1;j++){ for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j));
    vec2 o=sugarHash(n+g); o=0.5+0.35*sin(t*0.5+6.2831*o); vec2 d=g+o-f; float dd=dot(d,d);
    if(dd<minDist){ minDist=dd; nearPt=d; } } }
  float edge=8.0;
  for(int j=-1;j<=1;j++){ for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j));
    vec2 o=sugarHash(n+g); o=0.5+0.35*sin(t*0.5+6.2831*o); vec2 d=g+o-f; vec2 delta=d-nearPt;
    if(dot(delta,delta)>0.001) edge=min(edge,dot(0.5*(nearPt+d),normalize(delta))); } }
  return edge;
}
vec3 sugarLattice(vec2 p,float scale){
  float ca=cos(0.7853981634), sa=sin(0.7853981634);
  vec2 pr=mat2(ca,-sa,sa,ca)*p; vec2 g=pr*scale; g.x+=g.y*0.5;
  vec2 id=floor(g), f=fract(g)-0.5;
  float edge=min(0.5-abs(f.x),0.5-abs(f.y));
  return vec3(length(f)*0.70710678,edge,hash21(id));
}
void main(){
  vec2 uv=gl_FragCoord.xy/u_res; float aspect=u_res.x/u_res.y;
  vec2 p=(gl_FragCoord.xy-u_res*0.5)/min(u_res.x,u_res.y); p.y-=u_scroll;
  vec2 parallax=-(u_center-0.5)*0.15*sign(u_speed); float t=u_time*(u_life+0.15)*u_speed;
  p+=vec2(sin(p.y*12.0+t*2.3),cos(p.x*10.0+t*1.7))*0.003;
  float sugarCoverage=clamp(u_freeze/2.2,0.0,1.0);
  float waffleMask=step(0.82,sugarCoverage);
  float scale=mix(2.9,6.6,smoothstep(0.0,0.75,sugarCoverage));
  vec3 voronoiMacro=sugarVoronoi((p+parallax)*scale+0.5,t);
  vec3 latticeMacro=sugarLattice(p+parallax,8.0);
  vec3 macro=mix(voronoiMacro,latticeMacro,waffleMask);
  float microEdge=sugarEdge((p+parallax*2.5)*9.0+vec2(3.7,1.2),t*0.7);
  float crackPulse=0.5+0.3*sin(t*1.5)+0.2*sin(t*2.7+1.0);
  float softness=clamp(u_blur,0.0,1.0);
  float macroWidth=mix(0.025,0.085,softness)*crackPulse;
  float microWidth=mix(0.015,0.055,softness)*crackPulse;
  float seamStrength=mix(1.0,0.28,softness);
  float macroCrack=(1.0-smoothstep(0.0,macroWidth,macro.y))*seamStrength;
  float microCrack=(1.0-smoothstep(0.0,microWidth,microEdge))*seamStrength;
  float crack=clamp(macroCrack+microCrack*0.4,0.0,1.0);
  float macroGlow=1.0-smoothstep(0.0,macroWidth*4.0,macro.y);
  float microGlow=1.0-smoothstep(0.0,microWidth*3.0,microEdge);
  float glow=macroGlow*0.7+microGlow*0.3;
  float thickness=0.6+0.4*macro.z, hue=macro.z*0.3;
  vec3 amber=mix(vec3(0.78,0.585,0.424),vec3(0.34,0.16,0.035),u_dark);
  vec3 caramel=mix(vec3(0.831,0.647,0.455),vec3(0.46,0.22,0.045),u_dark);
  vec3 deepAmber=mix(vec3(0.29,0.125,0.0),vec3(0.10,0.035,0.0),u_dark);
  vec3 glass=mix(deepAmber,mix(amber,caramel,hue),thickness);
  glass=mix(glass*1.1,glass*0.85,smoothstep(0.0,0.5,macro.x));
  vec3 rose=mix(vec3(0.90,0.65,0.60),vec3(0.42,0.19,0.10),u_dark);
  glass=mix(glass,rose,glow*(0.3+0.2*sin(macro.z*12.0+t*0.8))*0.25);
  glass=mix(glass,u_tint,0.06);
  float fill=mix(1.0,0.35,smoothstep(0.45,0.75,sugarCoverage));
  fill=mix(fill,0.75,waffleMask); glass=mix(themeBg(),glass,fill);
  vec3 crackLight=mix(vec3(1.0,0.91,0.75),vec3(0.74,0.38,0.10),u_dark);
  vec3 crackBright=mix(vec3(1.0,0.96,0.90),vec3(0.90,0.52,0.16),u_dark);
  vec3 lightCol=mix(crackLight,crackBright,crack); float bleed=clamp(0.55+u_falloff*1.5,0.4,1.3);
  vec3 col=mix(glass,lightCol*0.8,glow*bleed*0.5); col=mix(col,lightCol,crack*bleed);
  float sss=0.5+0.5*sin(p.x*3.0+t*0.5)*sin(p.y*2.5+t*0.3); col+=vec3(0.05,0.03,0.01)*sss*thickness;
  float vig=smoothstep(0.0,1.0,1.0-dot(p*0.8,p*0.8)); col*=0.6+0.4*vig; col=pow(col,vec3(0.95));
  float focus=length(vec2((uv.x-u_center.x)*aspect,uv.y-u_center.y)); col+=u_evt*u_energy*exp(-focus*focus*10.0)*0.12;
  /* Background budget: clamp the hero treatment, then expose at most 20%. */
  vec3 bg=themeBg(); col=mix(bg,clamp(col,0.0,1.0),0.20);
  float noiseFreq=mix(80.0,4.0,clamp(u_blur,0.0,1.0)); float grain=fbm(uv*noiseFreq)-0.5;
  col+=u_noise*grain; col=(col-0.5)*u_contrast+0.5; col*=u_brightness; col=clamp(col,0.0,1.0);
  col=clamp(col,max(bg-vec3(0.20),vec3(0.0)),min(bg+vec3(0.20),vec3(1.0)));
  gl_FragColor=vec4(col,1.0);
}`;

export type ShaderMode = 'cone' | 'scoop' | 'freezer';
export interface SugarGlassPreset {
  readonly mode: 'cone';
  readonly tint: string;
  readonly brightness: number;
  readonly contrast: number;
  readonly noise: number;
  readonly blur: number;
  readonly coverage: number;
  readonly speed: number;
}

/**
 * Tuned Sugar Glass storyboard presets (all remain within the 20% background budget):
 * - Caramel — Radiant-like warm amber cells with visible crack light.
 * - Caramel-soft — Caramel's field with a softer brightness and contrast treatment.
 * - Frosted — broad, quiet seams and restrained contrast for maximum prose legibility.
 * - Brittle — dense small cells, sharp bright fractures, and low glass fill.
 * - Waffle-glass — sugar rendering over Cone's 45-degree, half-sheared lattice geometry.
 * Cone glass uses `coverage` for cell scale; values >= 0.82 select the lattice geometry.
 */
export const SUGAR_GLASS_PRESETS = {
  caramel: {
    mode: 'cone',
    tint: '#d08a3c',
    brightness: 1.1,
    contrast: 1.1,
    noise: 0.025,
    blur: 0.14,
    coverage: 0.28,
    speed: 0.0625,
  },
  'caramel-soft': {
    mode: 'cone',
    tint: '#d08a3c',
    brightness: 1.2,
    contrast: 0.75,
    noise: 0.025,
    blur: 0.14,
    coverage: 0.28,
    speed: 1,
  },
  frosted: {
    mode: 'cone',
    tint: '#ead9bd',
    brightness: 1,
    contrast: 0.55,
    noise: 0.005,
    blur: 0.9,
    coverage: 0.08,
    speed: 1,
  },
  brittle: {
    mode: 'cone',
    tint: '#ffd089',
    brightness: 0.96,
    contrast: 1.2,
    noise: 0.055,
    blur: 0.02,
    coverage: 0.68,
    speed: 1,
  },
  'waffle-glass': {
    mode: 'cone',
    tint: '#d3a15f',
    brightness: 1,
    contrast: 0.9,
    noise: 0.02,
    blur: 0.08,
    coverage: 0.9,
    speed: 1,
  },
} as const satisfies Readonly<Record<string, SugarGlassPreset>>;
export type SugarGlassPresetName = keyof typeof SUGAR_GLASS_PRESETS;

const PROGRAMS: Record<ShaderMode, string> = {
  cone: FRAG_SUGAR,
  scoop: FRAG_SCOOP,
  freezer: FRAG_FREEZER,
};
/** Fragment sources, exposed so tests can compile and pixel-probe the fields. */
export const SHADER_FRAGMENTS: Readonly<Record<ShaderMode, string>> = PROGRAMS;
const MODES = new Set<ShaderMode>(['cone', 'scoop', 'freezer']);

const FALLBACK: Record<ShaderMode, string> = {
  cone: 'radial-gradient(120% 120% at 35% 45%, color-mix(in srgb,#d08a3c 20%,var(--bg)) 0%, var(--bg) 70%)',
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

/** Backing-store resolution caps, in device-pixel-ratio units. The field is a
 *  background clamped to a ±20% deviation budget around the theme bg, so
 *  DPR 1 is visually indistinguishable at a quarter of DPR 2's pixel cost on
 *  Retina; showcase/hero uses can opt back up via the `dpr` attribute. */
const DEFAULT_DPR_CAP = 1;
const MIN_DPR_CAP = 0.5;
const MAX_DPR_CAP = 2;

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
  'u_falloff',
  'u_life',
  'u_tint',
  'u_brightness',
  'u_contrast',
  'u_noise',
  'u_blur',
  'u_speed',
] as const;
type UniformName = (typeof UNIFORMS)[number];

function clampNum(v: number, lo: number, hi: number, fb: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb;
}

/** A compiled+linked program kept per mode so a switch never recompiles. */
interface CachedProgram {
  program: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  aPos: number;
  loc: Partial<Record<UniformName, WebGLUniformLocation | null>>;
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
  static readonly observedAttributes = [
    'mode',
    'tint',
    'coverage',
    'intensity',
    'scroll',
    'brightness',
    'contrast',
    'noise',
    'blur',
    'speed',
    'dpr',
  ];

  readonly #root: ShadowRoot;
  #canvas: HTMLCanvasElement | null = null;
  #gl: WebGLRenderingContext | null = null;
  #program: WebGLProgram | null = null;
  /** Compiled+linked program per mode — built once, reused on every switch. */
  #programs: Partial<Record<ShaderMode, CachedProgram>> = {};
  #buffer: WebGLBuffer | null = null;
  #loc: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
  #aPos = -1;
  #raf = 0;
  #start = 0;
  #energy = 0;
  #lastFrameTs = Number.NEGATIVE_INFINITY;
  #burstUntil = 0;
  #contextLost = false;
  #ro: ResizeObserver | null = null;
  #reduced = false;
  // Cached CSS-derived uniforms. Resolved on connect / `tint` change / theme
  // change — NEVER per frame: resolving them calls getComputedStyle and (via
  // colorToVec3) appends a probe to document.body, which forces a full-document
  // style recalc. Doing that every animation frame was the flicker's cause.
  #tintVec: [number, number, number] = [0.816, 0.541, 0.235];
  #evtVec: [number, number, number] = [0.957, 0.247, 0.369];
  #darkVal = 0;
  #themeObserver: MutationObserver | null = null;
  #colorSchemeMq: MediaQueryList | null = null;
  #onColorSchemeChange: (() => void) | null = null;
  #builtMode: ShaderMode | null = null;
  #onContextLost: ((e: Event) => void) | null = null;
  #onContextRestored: (() => void) | null = null;

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
      // ResizeObserver delivers a mandatory initial notification on observe();
      // that is a mount artifact, not a user resize — bursting on it would open
      // an 800 ms full-rate window on every connect (the connect render via
      // #wake() already paints the initial size). Skip exactly one.
      let initial = true;
      this.#ro = new ResizeObserver(() => {
        if (initial) {
          initial = false;
          return;
        }
        this.#wake({ burst: true });
      });
      this.#ro.observe(this);
    }
    this.#refreshColorUniforms();
    this.#observeTheme();
    this.#start = performance.now() / 1000;
    this.#lastFrameTs = Number.NEGATIVE_INFINITY;
    this.#contextLost = false;
    this.#wake();
  }

  disconnectedCallback(): void {
    this.#stopLoop();
    this.#ro?.disconnect();
    this.#ro = null;
    this.#themeObserver?.disconnect();
    this.#themeObserver = null;
    if (this.#colorSchemeMq && this.#onColorSchemeChange) {
      this.#colorSchemeMq.removeEventListener('change', this.#onColorSchemeChange);
    }
    this.#colorSchemeMq = null;
    this.#onColorSchemeChange = null;
    this.#dispose();
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    // `tint` drives the tint + event-tint uniforms. A mode change also refreshes
    // the cache because a tint-less cone uses the Caramel default.
    if (name === 'tint' || name === 'mode') this.#refreshColorUniforms();
    if (name === 'mode' && this.#gl && this.mode !== this.#builtMode) {
      // Switch to the (cached) program and repaint synchronously so the
      // previous mode's frame does not linger for a rAF — the blue flicker.
      if (this.#linkMode()) {
        this.#renderFrame();
        this.#lastFrameTs = performance.now();
        this.#applyFallbackBg();
        // No burst: the sync render above already delivered the response, and
        // a burst here would double-draw a static field. The wake only (re)arms
        // the loop for animated modes.
        this.#wake();
        return;
      }
    }
    this.#applyFallbackBg();
    this.#wake({ burst: true });
  }

  /** Active program. */
  get mode(): ShaderMode {
    const m = this.getAttribute('mode') as ShaderMode | null;
    return m && MODES.has(m) ? m : 'cone';
  }
  set mode(value: ShaderMode) {
    this.setAttribute('mode', value);
  }

  /** Freezer frost growth / cone glass cell density and geometry 0..1. */
  get coverage(): number {
    const fallback = this.mode === 'cone' ? SUGAR_GLASS_PRESETS.caramel.coverage : 0.66;
    return clampNum(Number.parseFloat(this.getAttribute('coverage') ?? ''), 0, 1, fallback);
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

  /** Cone glass multiplier on final color (Caramel default = 1.1). */
  get brightness(): number {
    return clampNum(
      Number.parseFloat(this.getAttribute('brightness') ?? ''),
      0.5,
      1.5,
      SUGAR_GLASS_PRESETS.caramel.brightness
    );
  }
  set brightness(value: number) {
    this.setAttribute('brightness', String(value));
  }

  /** Cone glass contrast around a 0.5 pivot (Caramel default = 1.1). */
  get contrast(): number {
    return clampNum(
      Number.parseFloat(this.getAttribute('contrast') ?? ''),
      0.5,
      2,
      SUGAR_GLASS_PRESETS.caramel.contrast
    );
  }
  set contrast(value: number) {
    this.setAttribute('contrast', String(value));
  }

  /** Cone glass grain amount added to the final color (Caramel default = 0.025). */
  get noise(): number {
    return clampNum(
      Number.parseFloat(this.getAttribute('noise') ?? ''),
      0,
      0.3,
      SUGAR_GLASS_PRESETS.caramel.noise
    );
  }
  set noise(value: number) {
    this.setAttribute('noise', String(value));
  }

  /**
   * Cone glass blur of the noise layer only (0 = sharp grain, 1 = soft).
   * Reflects the `blur` attribute; named `blurAmount` because `HTMLElement`
   * already defines a `blur()` method. Caramel default = 0.14.
   */
  get blurAmount(): number {
    return clampNum(
      Number.parseFloat(this.getAttribute('blur') ?? ''),
      0,
      1,
      SUGAR_GLASS_PRESETS.caramel.blur
    );
  }
  set blurAmount(value: number) {
    this.setAttribute('blur', String(value));
  }

  /** Cone glass animation rate multiplier (0 = paused, Caramel default = 0.0625). */
  get speed(): number {
    return clampNum(
      Number.parseFloat(this.getAttribute('speed') ?? ''),
      0,
      2,
      SUGAR_GLASS_PRESETS.caramel.speed
    );
  }
  set speed(value: number) {
    this.setAttribute('speed', String(value));
  }

  /** Canvas resolution cap in device-pixel-ratio units (0.5..2, default 1). */
  get dpr(): number {
    return clampNum(
      Number.parseFloat(this.getAttribute('dpr') ?? ''),
      MIN_DPR_CAP,
      MAX_DPR_CAP,
      DEFAULT_DPR_CAP
    );
  }
  set dpr(value: number) {
    this.setAttribute('dpr', String(value));
  }

  get noWebgl(): boolean {
    return this.hasAttribute('no-webgl');
  }

  /** Bump the reactive energy (an event landed) — glows + surges briefly. */
  pulse(amount = 1): void {
    this.#energy = Math.min(1.4, this.#energy + amount);
    this.#wake({ burst: true });
  }

  // ---- internals ----

  #applyFallbackBg(): void {
    const fb = this.#root.querySelector<HTMLElement>('.fallback');
    if (fb) fb.style.background = FALLBACK[this.mode];
  }

  /** Resolve + cache the CSS-derived uniforms (tint, event tint, dark mode).
   *  Called on connect, on a `mode`/`tint` change, and on a theme change — NEVER per
   *  frame. Each call uses getComputedStyle and (via colorToVec3) a one-shot
   *  probe appended to document.body, so running it every animation frame
   *  forced a full-document style recalc — the flicker. The values only change
   *  on a theme/tint switch, so caching them is safe. */
  #refreshColorUniforms(): void {
    const tintAttr =
      this.getAttribute('tint') ?? (this.mode === 'cone' ? SUGAR_GLASS_PRESETS.caramel.tint : '');
    this.#tintVec = colorToVec3(tintAttr, [0.545, 0.361, 0.965]);
    this.#evtVec = colorToVec3(tintAttr, [0.957, 0.247, 0.369]);
    this.#darkVal = this.#darkUniform();
  }

  /** Re-resolve the cached color uniforms when the theme flips. `tint` is often
   *  `var(--waffle)` and `--ink` is theme-dependent, so a light/dark toggle (a
   *  class / `data-theme` change on <html>/<body>, or the OS color-scheme media
   *  query) changes the resolved values WITHOUT firing attributeChangedCallback.
   *  The wake below repaints promptly (burst window); a static or reduced-motion
   *  field renders exactly one frame and re-stops. */
  #observeTheme(): void {
    const refresh = (): void => {
      this.#refreshColorUniforms();
      this.#wake({ burst: true });
    };
    if (typeof MutationObserver !== 'undefined') {
      this.#themeObserver = new MutationObserver(refresh);
      for (const node of [document.documentElement, document.body]) {
        if (node)
          this.#themeObserver.observe(node, {
            attributes: true,
            attributeFilter: ['class', 'data-theme'],
          });
      }
    }
    if (typeof matchMedia === 'function') {
      this.#colorSchemeMq = matchMedia('(prefers-color-scheme: dark)');
      this.#onColorSchemeChange = refresh;
      this.#colorSchemeMq.addEventListener('change', this.#onColorSchemeChange);
    }
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

  /** Compile + link a fresh program for a mode (no caching, no activation). */
  #buildProgram(mode: ShaderMode): CachedProgram | null {
    const gl = this.#gl;
    if (!gl) return null;
    const vs = this.#compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = this.#compile(gl, gl.FRAGMENT_SHADER, PROGRAMS[mode]);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return null;
    }
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    const aPos = gl.getAttribLocation(program, 'a_pos');
    const loc: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
    for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(program, u);
    return { program, vs, fs, aPos, loc };
  }

  /**
   * Activate the program for the current mode, building it once and caching it.
   * Revisiting a mode reuses the cached program — no recompile/relink — and just
   * refreshes the active program + uniform locations.
   */
  #linkMode(): boolean {
    const gl = this.#gl;
    if (!gl) return false;
    const mode = this.mode;
    let cached = this.#programs[mode];
    if (!cached) {
      const built = this.#buildProgram(mode);
      if (!built) return false;
      this.#programs[mode] = built;
      cached = built;
    }
    this.#program = cached.program;
    this.#aPos = cached.aPos;
    this.#loc = cached.loc;
    gl.useProgram(cached.program);
    this.#builtMode = mode;
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
    this.#installContextHandlers(cv);
    if (this.#setupGlResources()) return true;
    // Resource setup can fail after acquiring a context and compiling a program
    // (for example when buffer allocation is exhausted). Keep #gl alive until
    // disposal so the partial program and the context are actually released.
    this.#dispose();
    return false;
  }

  /** Link the active mode and (re)build the fullscreen-triangle buffer. */
  #setupGlResources(): boolean {
    const gl = this.#gl;
    if (!gl) return false;
    if (!this.#linkMode()) return false;
    const buf = gl.createBuffer();
    if (!buf) return false;
    this.#buffer = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    return true;
  }

  /**
   * On context loss the cached programs/shaders/buffer are invalid GPU handles,
   * so drop the whole cache; on restore the same context is reusable, so relink
   * (rebuilding the cache lazily) and resume the loop.
   */
  #installContextHandlers(cv: HTMLCanvasElement): void {
    this.#removeContextHandlers(cv);
    this.#onContextLost = (e: Event) => {
      e.preventDefault();
      this.#contextLost = true;
      this.#stopLoop();
      this.#programs = {};
      this.#program = null;
      this.#builtMode = null;
      this.#loc = {};
      this.#buffer = null;
    };
    this.#onContextRestored = () => {
      if (!this.isConnected || !this.#gl) return;
      this.#programs = {};
      if (!this.#setupGlResources()) return;
      this.#contextLost = false;
      this.#start = performance.now() / 1000;
      this.#lastFrameTs = Number.NEGATIVE_INFINITY;
      this.#wake();
    };
    cv.addEventListener('webglcontextlost', this.#onContextLost, false);
    cv.addEventListener('webglcontextrestored', this.#onContextRestored, false);
  }

  #removeContextHandlers(cv: HTMLCanvasElement): void {
    if (this.#onContextLost) cv.removeEventListener('webglcontextlost', this.#onContextLost);
    if (this.#onContextRestored)
      cv.removeEventListener('webglcontextrestored', this.#onContextRestored);
    this.#onContextLost = null;
    this.#onContextRestored = null;
  }

  #resize(): void {
    const cv = this.#canvas;
    if (!cv) return;
    const dpr = Math.min(this.dpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
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
    // Cached (resolved on connect / tint change / theme change) — never
    // recomputed here: getComputedStyle + a document.body probe per frame was
    // the flicker. See #refreshColorUniforms / #observeTheme.
    const dark = this.#darkVal;
    const tint = this.#tintVec;
    const evt = this.#evtVec;
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
    gl.uniform1f(u.u_falloff ?? null, 0.3);
    gl.uniform1f(u.u_life ?? null, 0.35);
    gl.uniform3f(u.u_tint ?? null, tint[0], tint[1], tint[2]);
    gl.uniform1f(u.u_brightness ?? null, this.brightness);
    gl.uniform1f(u.u_contrast ?? null, this.contrast);
    gl.uniform1f(u.u_noise ?? null, this.noise);
    gl.uniform1f(u.u_blur ?? null, this.blurAmount);
    gl.uniform1f(u.u_speed ?? null, this.speed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Energy decays toward rest.
    this.#energy *= 0.95;
    if (this.#energy < 0.001) this.#energy = 0;
  }

  /** True while the field has intrinsic motion. Cone glass with `speed` 0 is
   *  genuinely static — u_speed zeroes the crack clock, the micro-wobble, and
   *  (via sign(u_speed)) the parallax — while scoop and freezer animate on
   *  u_time unconditionally. Reduced motion always reads as static. */
  #isAnimated(): boolean {
    if (this.#reduced) return false;
    if (this.mode === 'cone' && this.speed === 0) return false;
    return true;
  }

  /** Single scheduler entry point — every stimulus lands here: connect, any
   *  observed attribute change, theme flip, resize, context restore, pulse().
   *  `burst` opens a BURST_MS full-rate window so the response is crisp; the
   *  tick decides per-frame whether the budget admits a render and whether the
   *  loop keeps running at all. Batched same-microtask stimuli coalesce into
   *  the one pending rAF. A lost GL context parks the scheduler entirely until
   *  restore (render would no-op but an animated mode would spin the loop). */
  #wake(opts: { burst?: boolean } = {}): void {
    if (opts.burst) this.#burstUntil = performance.now() + BURST_MS;
    if (this.#raf || !this.#gl || this.#contextLost) return;
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #tick = (ts: number): void => {
    this.#raf = 0;
    const energetic = ts < this.#burstUntil || this.#energy > 0;
    if (shouldRender(ts, this.#lastFrameTs, energetic)) {
      this.#lastFrameTs = advanceFrameTs(ts, this.#lastFrameTs, energetic);
      this.#renderFrame();
    }
    // Self-terminate AFTER the render so the final at-rest frame paints:
    // static fields stop dead; reduced motion never loops (one frame per wake).
    if (this.#reduced || (!this.#isAnimated() && this.#energy === 0)) return;
    this.#raf = requestAnimationFrame(this.#tick);
  };

  #stopLoop(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #dispose(): void {
    const gl = this.#gl;
    const cv = this.#canvas;
    if (cv) this.#removeContextHandlers(cv);
    if (gl) {
      if (this.#buffer) gl.deleteBuffer(this.#buffer);
      // Free every cached program + its shaders, not just the active one.
      for (const cached of Object.values(this.#programs)) {
        if (!cached) continue;
        gl.deleteProgram(cached.program);
        gl.deleteShader(cached.vs);
        gl.deleteShader(cached.fs);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.#gl = null;
    this.#program = null;
    this.#programs = {};
    this.#loc = {};
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
