import { define } from '../internal/define.js';

/**
 * Full-screen-quad vertex passthrough, lifted verbatim from the prototype
 * (`proto/StellarRubySwift.html` `VERT`). The single triangle that covers the
 * viewport is uploaded as `[-1,-1, 3,-1, -1,3]`.
 */
const VERT = 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos,0.0,1.0); }';

/**
 * Shared uniform header + fbm noise helpers, lifted from the prototype
 * (`HEAD` + `NOISE`). Only the uniforms the freezer program actually reads are
 * declared here — `u_res`, `u_time`, `u_freeze`, `u_dark` — plus `themeBg()`
 * which bakes the page background into the shader so the canvas alpha-blends
 * over `var(--bg)`. The freezer shader is theme-independent GLSL; `u_dark`
 * (0 = light, 1 = dark) only shifts the warm/cool background mix.
 */
const HEAD = `precision highp float;
  uniform vec2 u_res; uniform float u_time; uniform float u_freeze; uniform float u_dark;
  vec3 themeBg(){ return mix(vec3(0.97,0.95,0.89), vec3(0.09,0.08,0.06), u_dark); }`;

const NOISE = `
  float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p);
    float a=hash21(i),b=hash21(i+vec2(1.,0.)),c=hash21(i+vec2(0.,1.)),d=hash21(i+vec2(1.,1.));
    vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
  float fbm(vec2 p){ float v=0.,a=0.5; for(int i=0;i<5;i++){ v+=a*vnoise(p); p=p*2.02+vec2(7.1,3.7); a*=0.5;} return v; }`;

/**
 * FREEZER frost fragment shader — lifted faithfully from the prototype
 * (`proto/StellarRubySwift.html` `FRAG_FREEZER`, ~lines 1274-1310): liquid water
 * crystallizing into ice from the bottom-left corner with a glossy wet→frosted
 * front, six-fold fbm crystal facets/veins, and a faint sparkle that scintillates
 * over time. `u_freeze` (0-1) drives how far the frost has grown across the
 * frame; the periphery is washed toward ice-blue so the corner-growth front
 * feathers into the surrounding warm chrome instead of a hard edge.
 */
const FRAG_FREEZER = `${HEAD}${NOISE}
  void main(){
    vec2 uv = gl_FragCoord.xy/u_res;
    float aspect = u_res.x/u_res.y;
    vec2 p = (uv-0.5); p.x*=aspect;
    vec3 iceCol = mix(vec3(0.62,0.76,0.92), vec3(0.78,0.88,1.0), u_dark);
    vec3 deepIce = mix(vec3(0.40,0.56,0.78), vec3(0.50,0.66,0.88), u_dark);
    vec3 bg = mix(themeBg(), iceCol, 0.12);
    float dc = distance(uv, vec2(0.0,0.0));
    float ragged = 0.10*fbm(uv*6.0 + 3.0) + 0.05*fbm(uv*14.0);
    float front = u_freeze*0.66 + ragged - 0.05;
    float edge = front - dc;
    float frozen = smoothstep(-0.04, 0.06, edge);
    float wetBand = smoothstep(0.12, 0.0, abs(edge));
    float ripple = 0.015*sin(dc*40.0 - u_time*0.4) * frozen;
    vec2 q = uv*aspect + vec2(ripple, ripple*0.5);
    float crystals = fbm(q*9.0);
    crystals += 0.5*fbm(q*20.0 + 4.0);
    crystals /= 1.5;
    float facet = smoothstep(0.45,0.55, crystals);
    float veins = smoothstep(0.03,0.0, abs(fract(crystals*6.0)-0.5)-0.02);
    vec3 col = bg;
    vec3 wet = mix(bg, iceCol, 0.5);
    float wetSpec = pow(clamp(fbm(uv*10.0 - u_time*0.2),0.0,1.0), 2.0);
    wet += wetSpec*vec3(1.0)*0.25;
    col = mix(col, wet, wetBand*0.45);
    vec3 frost = mix(deepIce, iceCol, facet);
    frost += veins*vec3(1.0)*0.25;
    float spark = smoothstep(0.92,1.0, fbm(uv*30.0)) * (0.5+0.5*sin(u_time*0.6 + crystals*20.0));
    frost += spark*vec3(1.0)*0.4*frozen;
    col = mix(col, frost, frozen*0.75);
    float rim = smoothstep(0.05,0.0, abs(edge))*0.6;
    col += rim*iceCol;
    gl_FragColor = vec4(col, 1.0);
  }`;

/**
 * Shadow stylesheet. The canvas fills the host (absolute inset 0, 100%/100%) and
 * is pointer-transparent so it never intercepts events. The `.fallback` layer is
 * an ice-blue CSS gradient shown only when WebGL is unavailable (`:host([no-webgl])`);
 * it mirrors the shader's corner-growth palette so the look degrades gracefully.
 * All colors are self-contained ice-blue (theme-independent, like the GLSL); the
 * host alpha-blends over the inherited `var(--bg)`.
 */
const STYLE = `
:host { position: relative; display: block; }
.canvas, .fallback {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; pointer-events: none;
}
.fallback {
  display: none;
  background:
    radial-gradient(120% 120% at 0% 100%,
      rgba(124, 175, 222, 0.55) 0%,
      rgba(160, 198, 232, 0.32) 28%,
      rgba(200, 222, 245, 0.12) 52%,
      transparent 72%),
    var(--bg);
}
:host([no-webgl]) .canvas { display: none; }
:host([no-webgl]) .fallback { display: block; }
`;

/** Cap the backing-store resolution at 2× CSS pixels (prototype `resize`). */
const MAX_DPR = 2;
/** Default coverage when the `coverage` attribute is absent (mid frost growth). */
const DEFAULT_COVERAGE = 0.66;
/** Default intensity multiplier when the `intensity` attribute is absent. */
const DEFAULT_INTENSITY = 1;

/** Compiled program + cached uniform/attribute locations. */
interface FrostProgram {
  prog: WebGLProgram;
  loc: number;
  u: {
    res: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    freeze: WebGLUniformLocation | null;
    dark: WebGLUniformLocation | null;
  };
}

/** Clamp a number to `[lo, hi]`, treating non-finite input as the fallback. */
function clamp(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, value));
}

/**
 * `<slicc-frost-shader>` — the FREEZER frost WebGL background lifted from the
 * prototype (PR #841 `bg-canvas` / `FRAG_FREEZER`). A self-contained element that
 * wraps a `<canvas>` in shadow DOM and runs a minimal standalone WebGL pipeline
 * (single full-screen quad + the frost fragment shader) driven by a `u_time`
 * uniform. Ice crystallizes from the bottom-left corner with six-fold fbm
 * facets, veins, and a faint sparkle, washing the periphery to ice-blue.
 *
 * The canvas fills the host and is `pointer-events: none`; it resizes DPR-aware
 * via a `ResizeObserver`. On connect the program is compiled/linked and a
 * `requestAnimationFrame` loop advances `u_time`; on disconnect the loop stops
 * and the GL context is released. `prefers-reduced-motion` renders a single
 * static frame with no loop. If WebGL is unavailable (or the program fails to
 * compile/link) the element falls back to a CSS ice-blue gradient and reflects
 * the `no-webgl` attribute.
 *
 * @attr coverage - `0`-`1`; how far the frost has grown (feeds `u_freeze`). Default `0.66`.
 * @attr intensity - frost intensity multiplier (scales coverage into `u_freeze`). Default `1`.
 * @attr no-webgl - reflected (read-only) when WebGL is unavailable; shows the CSS fallback.
 * @csspart canvas - the WebGL `<canvas>` element
 * @csspart fallback - the CSS ice-blue gradient shown when WebGL is unavailable
 */
export class SliccFrostShader extends HTMLElement {
  static readonly observedAttributes = ['coverage', 'intensity'];

  readonly #root: ShadowRoot;
  #canvas: HTMLCanvasElement | null = null;
  #gl: WebGLRenderingContext | null = null;
  #program: FrostProgram | null = null;
  #buffer: WebGLBuffer | null = null;
  #raf = 0;
  #start = 0;
  #ro: ResizeObserver | null = null;
  #reducedMotion = false;
  #mql: MediaQueryList | null = null;
  #onMotionChange: (() => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.innerHTML =
      `<style>${STYLE}</style>` +
      '<canvas class="canvas" part="canvas"></canvas>' +
      '<div class="fallback" part="fallback" aria-hidden="true"></div>';
    this.#canvas = this.#root.querySelector('.canvas');
  }

  connectedCallback(): void {
    this.#reducedMotion = this.#prefersReducedMotion();
    this.#watchReducedMotion();
    if (!this.#initGl()) {
      this.#useFallback();
      return;
    }
    this.removeAttribute('no-webgl');
    this.#observeResize();
    this.#start = performance.now() / 1000;
    if (this.#reducedMotion) this.#renderFrame();
    else this.#startLoop();
  }

  disconnectedCallback(): void {
    this.#stopLoop();
    this.#unwatchReducedMotion();
    if (this.#ro) {
      this.#ro.disconnect();
      this.#ro = null;
    }
    this.#loseContext();
  }

  attributeChangedCallback(): void {
    // A static (reduced-motion / single-frame) render must repaint when the
    // coverage/intensity uniforms change; the running loop picks them up on the
    // next frame, so nothing extra is needed there.
    if (this.isConnected && this.#reducedMotion && this.#gl) this.#renderFrame();
  }

  /** Frost growth `0`-`1` (feeds `u_freeze`). Default `0.66`. */
  get coverage(): number {
    return clamp(Number.parseFloat(this.getAttribute('coverage') ?? ''), 0, 1, DEFAULT_COVERAGE);
  }

  set coverage(value: number) {
    this.setAttribute('coverage', String(value));
  }

  /** Frost intensity multiplier (scales coverage into `u_freeze`). Default `1`. */
  get intensity(): number {
    return clamp(Number.parseFloat(this.getAttribute('intensity') ?? ''), 0, 4, DEFAULT_INTENSITY);
  }

  set intensity(value: number) {
    this.setAttribute('intensity', String(value));
  }

  /** Whether WebGL was unavailable and the CSS fallback is active (read-only). */
  get noWebgl(): boolean {
    return this.hasAttribute('no-webgl');
  }

  // ---- internals -----------------------------------------------------------

  #prefersReducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  #watchReducedMotion(): void {
    if (typeof matchMedia !== 'function') return;
    this.#mql = matchMedia('(prefers-reduced-motion: reduce)');
    this.#onMotionChange = () => {
      const reduced = !!this.#mql?.matches;
      if (reduced === this.#reducedMotion) return;
      this.#reducedMotion = reduced;
      if (!this.isConnected || !this.#gl) return;
      if (reduced) {
        this.#stopLoop();
        this.#renderFrame();
      } else {
        this.#startLoop();
      }
    };
    this.#mql.addEventListener('change', this.#onMotionChange);
  }

  #unwatchReducedMotion(): void {
    if (this.#mql && this.#onMotionChange) {
      this.#mql.removeEventListener('change', this.#onMotionChange);
    }
    this.#mql = null;
    this.#onMotionChange = null;
  }

  /** Mark WebGL as unavailable and switch on the CSS gradient fallback. */
  #useFallback(): void {
    this.setAttribute('no-webgl', '');
  }

  /** Acquire a WebGL context and compile/link the frost program. */
  #initGl(): boolean {
    const cv = this.#canvas;
    if (!cv) return false;
    const opts: WebGLContextAttributes = {
      premultipliedAlpha: true,
      alpha: true,
      antialias: true,
    };
    let gl: WebGLRenderingContext | null = null;
    try {
      gl =
        (cv.getContext('webgl', opts) as WebGLRenderingContext | null) ??
        (cv.getContext('experimental-webgl', opts) as WebGLRenderingContext | null);
    } catch {
      gl = null;
    }
    if (!gl) return false;
    this.#gl = gl;

    const program = this.#link(gl, FRAG_FREEZER);
    if (!program) {
      this.#gl = null;
      return false;
    }
    this.#program = program;

    const buf = gl.createBuffer();
    if (!buf) {
      this.#gl = null;
      this.#program = null;
      return false;
    }
    this.#buffer = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
    return true;
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

  #link(gl: WebGLRenderingContext, fragSrc: string): FrostProgram | null {
    const vs = this.#compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = this.#compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    return {
      prog,
      loc: gl.getAttribLocation(prog, 'a_pos'),
      u: {
        res: gl.getUniformLocation(prog, 'u_res'),
        time: gl.getUniformLocation(prog, 'u_time'),
        freeze: gl.getUniformLocation(prog, 'u_freeze'),
        dark: gl.getUniformLocation(prog, 'u_dark'),
      },
    };
  }

  #observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.#ro = new ResizeObserver(() => {
      // A static frame must repaint on resize; the loop repaints anyway.
      if (this.#reducedMotion && this.#gl) this.#renderFrame();
    });
    this.#ro.observe(this);
  }

  /** Sync the backing store to the host's CSS size × DPR (prototype `resize`). */
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

  /**
   * Resolve `u_dark` (0/1) from the inherited theme. `var(--ink)` is near-black
   * in light mode and near-white in dark mode, so its luminance is a reliable
   * theme probe that respects whatever scope (`.dark` / `[data-theme="dark"]`)
   * wraps the host — without re-declaring any token.
   */
  #darkUniform(): number {
    if (typeof getComputedStyle !== 'function') return 0;
    const ink = getComputedStyle(this).getPropertyValue('--ink').trim();
    const m = ink.match(/(\d+(?:\.\d+)?)/g);
    if (!m || m.length < 3) return 0;
    const [r, g, b] = m.map(Number);
    // Bright ink ⇒ dark theme.
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? 1 : 0;
  }

  /** Draw one frame at the current `u_time` (loop tick or static render). */
  #renderFrame(): void {
    const gl = this.#gl;
    const cv = this.#canvas;
    const P = this.#program;
    if (!gl || !cv || !P || !this.#buffer) return;
    this.#resize();
    const t = performance.now() / 1000 - this.#start;
    const freeze = clamp(this.coverage * this.intensity, 0, 1, DEFAULT_COVERAGE);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(P.loc);
    gl.vertexAttribPointer(P.loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(P.u.res, cv.width, cv.height);
    gl.uniform1f(P.u.time, t);
    gl.uniform1f(P.u.freeze, freeze);
    gl.uniform1f(P.u.dark, this.#darkUniform());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    if (this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
  }

  /** Release GL resources and the backing context on disconnect. */
  #loseContext(): void {
    const gl = this.#gl;
    if (gl) {
      if (this.#buffer) gl.deleteBuffer(this.#buffer);
      if (this.#program) gl.deleteProgram(this.#program.prog);
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
    this.#gl = null;
    this.#program = null;
    this.#buffer = null;
  }
}

define('slicc-frost-shader', SliccFrostShader);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-frost-shader': SliccFrostShader;
  }
}
