// SPEC.md Section 7.3, "Rendering": a MapLibre CustomLayerInterface that
// draws the fog as a single full-screen quad (grid-geometry.ts), sampling
// an R8 texture with one texel per grid cell. This is the GL-heavy half of
// the fog layer and is exercised in tests only through an injected
// gl-shaped fake (webgl-fog-layer.test.ts) - jsdom has no real WebGL2
// context, so nothing here can be verified against an actual GPU. See the
// task report for what a human needs to check on a real device.
import type { CustomLayerInterface, CustomRenderMethod, Map as MaplibreMap } from 'maplibre-gl';
import type { GridParams } from '@tipsytrails/shared';
import { CONFIG } from '@tipsytrails/shared';
import { gridQuadCorners, lngLatBox } from './grid-geometry.js';
import type { LngLatBox } from './grid-geometry.js';
import {
  boundingTexelRect,
  diffRevealedCells,
  extractTexelRect,
  maskToFogTexels,
  texelToCell,
} from './grid-texture.js';
import type { GridSize, TexelRect } from './grid-texture.js';
import { fogTexelAt, revealProgress } from './reveal-animation.js';

// A muted, near-paper grey - "milky grey fog" (SPEC.md Section 8.1). Chosen
// to sit close to ink-style.ts's PAPER (#f4efe6) / INK (#1c1a17) family
// without importing that module, the same way this file's shader is its
// own implementation rather than a shared one: the fog layer and the
// vector base style are two independent MapLibre layers.
const FOG_COLOR: readonly [number, number, number] = [0.78, 0.76, 0.71];

/**
 * Formats a number as a GLSL float literal. GLSL has no implicit int→float
 * conversion, so `const float x = 1;` is a compile error - and a failed
 * compile throws out of `compileShader` below, uncaught. A whole-number
 * opacity must therefore still carry a decimal point.
 */
export function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * Formats a number as a GLSL int literal. The mirror image of `glslFloat`,
 * and needed for the same reason from the other side: GLSL has no implicit
 * float→int conversion either, so `const int r = 1.0;` is as much a compile
 * error as `const float x = 1;` is - and a failed compile throws out of
 * `compileShader` below, uncaught, taking the map down. A value that is not
 * a whole number has no int literal at all, so this refuses it here, where
 * the message can say so, rather than at shader compile time.
 */
export function glslInt(value: number): string {
  if (!Number.isInteger(value)) {
    throw new Error(`A GLSL int literal needs a whole number, got ${value}.`);
  }
  return String(value);
}

/**
 * SPEC.md Section 7.3's uneven fog density, as octaves of one value noise
 * summed at falling amplitude - fractional Brownian motion, the ordinary
 * construction. The count is the whole judgement here and three is it.
 *
 * One octave is a lattice, and a lattice reads as a regular grid of blobs at
 * whatever zoom makes its period a comfortable fraction of the screen - the
 * "visible cloud texture" this must not become. Two hide that only partly,
 * because a frequency ratio of 2 puts the second lattice's corners exactly on
 * the first one's and the two grids agree instead of cancelling. Three, at
 * ratios that are not whole multiples of each other and each shifted by its
 * own offset so the lattices do not share an origin either, leave no common
 * grid to find.
 *
 * A fourth would buy nothing but detail at cell scale, and detail at cell
 * scale is precisely what stops reading as uneven density and starts reading
 * as a texture. More is not better here: Section 7.3's "no regular cloud
 * texture" is a ceiling on how structured this may look.
 *
 * The frequencies are relative to CONFIG.FOG_DENSITY_NOISE_CELLS, so the
 * finest feature is that many cells divided by the last frequency - about 5
 * cells, deliberately kept well above the size of a screen pixel at
 * MAP_MIN_ZOOM, where anything finer would alias into shimmer.
 */
export const FOG_DENSITY_OCTAVES = [
  { frequency: 1, amplitude: 1, offset: 0 },
  { frequency: 2.13, amplitude: 0.5, offset: 19.3 },
  { frequency: 4.57, amplitude: 0.25, offset: 41.1 },
] as const;

const DENSITY_NOISE_EXPRESSION = FOG_DENSITY_OCTAVES.map(
  (octave) =>
    `${glslFloat(octave.amplitude)} * valueNoise(p * ${glslFloat(octave.frequency)} + ${glslFloat(octave.offset)})`,
).join('\n    + ');

const DENSITY_AMPLITUDE_TOTAL = FOG_DENSITY_OCTAVES.reduce(
  (total, octave) => total + octave.amplitude,
  0,
);

/**
 * The fog's alpha, mirrored in TypeScript.
 *
 * `edgeFactor` is the shader's `smoothstep(EDGE_ALPHA_LOW, EDGE_ALPHA_HIGH,
 * fog)` - 0 on revealed ground, 1 on fully unrevealed ground - and `density`
 * is the fBm above, which is bounded to 0..1 by construction.
 *
 * The density term multiplies *into* the same product as the edge factor
 * rather than being added beside it, and that is the property that keeps
 * revealed ground revealed: at `edgeFactor === 0` the whole expression is 0
 * whatever the density is. A term added outside the product would put a haze
 * on ground the player has earned, which is the opposite of the mechanic.
 *
 * This exists because the shader is a string that cannot be executed in this
 * repository - jsdom has no WebGL2 - so the arithmetic is tested here and the
 * shader source is held to the same expression by a substring assertion in
 * webgl-fog-layer.test.ts. That pairing is textual, not semantic: it proves
 * the two say the same thing today, and it is the strongest guarantee
 * available without a GPU.
 */
export function fogAlpha(edgeFactor: number, density: number): number {
  return edgeFactor * (CONFIG.FOG_MAX_OPACITY - CONFIG.FOG_DENSITY_VARIATION * density);
}

const VERTEX_SHADER = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
}
`;

// Section 7.3's fog edge. Two things soften it and they do different jobs.
//
// The noise displaces the *sampling position* before the blur (domain
// warping) so the revealed boundary is perturbed organically rather than
// reading as a circle around the player or as a staircase of 50 m squares.
// That is what Section 7.3 asks for and it stays exactly as it was.
//
// The box blur is what sets how *wide* the transition is, and it used to be
// far too wide: a 2-cell radius, whose ramp the old `smoothstep(0.12, 0.88)`
// then stretched across nearly the whole opacity range, put ~190 m of fade
// between fogged and revealed ground - a boundary the player could not make
// out, and so a mechanic the player could not see working. Both numbers are
// now `CONFIG.FOG_EDGE_*` and baked in below. Blurring a binary mask
// sampled with LINEAR filtering leaves the blurred value linear in distance
// from the boundary with slope 1 / (2r + 1) per cell, so the visible
// transition is exactly `2 * (2r + 1) * h` cells wide - see config.ts.
//
// The blur bounds must be compile-time constants, which is why the radius is
// interpolated into the source rather than passed as a uniform.
//
// Everything above is the *edge*. Inside it the fog used to be a flat wash at
// one alpha, which read as a sheet of tracing paper laid over the map rather
// than as unexplored ground. `fogDensity` below varies that alpha with noise
// sampled in grid space, so a patch of the city keeps its own density as the
// camera moves over it - see `main`, and `FOG_DENSITY_OCTAVES` for why the
// noise is layered the way it is.
//
// PRECISION IS `highp` DELIBERATELY (SPEC.md Open Item O15). This shader
// takes a +/-1-texel blur kernel and a +/-1.5-texel noise warp in UV space,
// and on Karlsruhe's 417 x 343 grid one texel is 0.0024 of UV. `mediump` is
// only guaranteed to 10 bits of mantissa - and is fp16 on the mobile GPUs
// this actually runs on - so near UV 1.0 its steps are about 0.001, which
// makes a one-texel offset barely two representable steps: neighbouring blur
// taps collapse onto the same texel and the warp quantises to a handful of
// discrete positions, both of which change as the camera moves. `highp` is
// fp32, roughly 20,000 steps per texel, and GLSL ES 3.00 requires it in the
// fragment stage, so WebGL2 being available is already the guarantee that
// this compiles. The density noise below needs it for the same reason.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform highp sampler2D u_fog;
uniform vec2 u_texelSize;
uniform vec3 u_fogColor;
in vec2 v_uv;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The fog's own density, 0..1, from FOG_DENSITY_OCTAVES (see the comment on
// that constant for why there are three of them and not one or four). Every
// octave is bounded to 0..1 and the sum is divided by the total amplitude, so
// this is bounded to 0..1 too - which is what makes FOG_MAX_OPACITY an
// exact ceiling rather than an approximate one.
float fogDensity(vec2 p) {
  return (
    ${DENSITY_NOISE_EXPRESSION}
  ) / ${glslFloat(DENSITY_AMPLITUDE_TOTAL)};
}

// Section 7.3: fog dense enough to hide detail, short of literal alpha 1 so
// unrevealed ground still reads as fogged terrain rather than as a blank
// panel. Orientation on unrevealed ground comes from the road and water
// layers, which are drawn *above* this one (ink-style.ts, fog-controller.ts),
// not from what shows through here.
//
// This is the alpha of the DENSEST fog and the ceiling on every fragment,
// not one value the whole quad is painted at - see config.ts.
const float FOG_MAX_OPACITY = ${glslFloat(CONFIG.FOG_MAX_OPACITY)};

// Section 7.3's uneven density, from CONFIG. The noise thins the fog by up to
// FOG_DENSITY_VARIATION below the ceiling, never above it, so the fog's alpha
// runs over [FOG_MAX_OPACITY - FOG_DENSITY_VARIATION, FOG_MAX_OPACITY].
const float FOG_DENSITY_VARIATION = ${glslFloat(CONFIG.FOG_DENSITY_VARIATION)};
const float DENSITY_NOISE_CELLS = ${glslFloat(CONFIG.FOG_DENSITY_NOISE_CELLS)};

// Section 7.3's edge, from CONFIG.FOG_EDGE_* - a whole number of cells for
// the blur's loop bounds, and the alpha ramp as a tight band centred on the
// blurred mask's midpoint rather than spread across its whole range.
const int EDGE_BLUR_RADIUS = ${glslInt(CONFIG.FOG_EDGE_BLUR_RADIUS_CELLS)};
const float EDGE_ALPHA_LOW = ${glslFloat(0.5 - CONFIG.FOG_EDGE_ALPHA_HALF_WIDTH)};
const float EDGE_ALPHA_HIGH = ${glslFloat(0.5 + CONFIG.FOG_EDGE_ALPHA_HALF_WIDTH)};

void main() {
  // THE DENSITY IS ANCHORED TO THE GROUND, NOT TO THE SCREEN. v_uv is the
  // grid's own coordinate - grid-geometry.ts derives it from the quad
  // corners' longitude and latitude against the grid's fixed south-west and
  // north-east corners, so a given patch of the city has one (u, v) forever
  // and the camera does not appear in it at all. Sampling the noise here
  // therefore gives every patch of the city its own density and keeps it as
  // the map moves underneath. Anything screen-derived - the window-relative
  // fragment position, the mercator position, the blurred sample position -
  // would make the fog crawl and shimmer under a pan, which is worse than a
  // flat wash. (The window-relative position is not named here in so many
  // words on purpose: webgl-fog-layer.test.ts asserts its identifier appears
  // nowhere in this source, and a comment would satisfy that assertion.)
  //
  // Dividing by (u_texelSize * DENSITY_NOISE_CELLS) turns UV into units of
  // that many grid cells on both axes, so the noise is isotropic in cells
  // rather than stretched by the grid's 417:343 aspect.
  float density = fogDensity(v_uv / (u_texelSize * DENSITY_NOISE_CELLS));
  float fogOpacity = FOG_MAX_OPACITY - FOG_DENSITY_VARIATION * density;

  // The quad reaches past the grid into the map's padding ring
  // (grid-geometry.ts), which has no cells and so can never be revealed.
  // WebGL2 has no CLAMP_TO_BORDER, and CLAMP_TO_EDGE would smear the
  // grid's edge texels across that whole ring - a cell revealed at the
  // city's edge would trail a cleared stripe out to the boundary - so the
  // ring is decided here instead of by the sampler.
  //
  // It takes the same density as the interior rather than a flat
  // FOG_MAX_OPACITY: the noise is continuous across UV 0 and 1, so this
  // carries the density straight over the grid's boundary. Left flat, the
  // ring would sit at the ceiling against an interior that is mostly below
  // it, and the grid's edge would appear as a rectangle drawn on the fog.
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    fragColor = vec4(u_fogColor * fogOpacity, fogOpacity);
    return;
  }

  vec2 noiseCoord = v_uv / (u_texelSize * 6.0);
  vec2 offsetCells = (vec2(valueNoise(noiseCoord), valueNoise(noiseCoord + 91.7)) - 0.5) * 3.0;
  vec2 uv = v_uv + offsetCells * u_texelSize;

  float sum = 0.0;
  float weight = 0.0;
  for (int dy = -EDGE_BLUR_RADIUS; dy <= EDGE_BLUR_RADIUS; dy++) {
    for (int dx = -EDGE_BLUR_RADIUS; dx <= EDGE_BLUR_RADIUS; dx++) {
      vec2 sampleUv = uv + vec2(float(dx), float(dy)) * u_texelSize;
      sum += texture(u_fog, sampleUv).r;
      weight += 1.0;
    }
  }
  float fog = sum / weight;
  // The density multiplies into the same product as the edge factor, so
  // revealed ground - where the smoothstep is 0 - stays at alpha 0 whatever
  // the density is. See fogAlpha() above, which mirrors this line.
  float alpha = smoothstep(EDGE_ALPHA_LOW, EDGE_ALPHA_HIGH, fog) * fogOpacity;
  // Premultiplied alpha - MapLibre's custom-layer blend func is
  // gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) (see CustomLayerInterface).
  fragColor = vec4(u_fogColor * alpha, alpha);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Could not create fog shader.');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Fog shader failed to compile: ${info ?? 'unknown error'}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Could not create fog shader program.');
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Fog shader program failed to link: ${info ?? 'unknown error'}`);
  }
  return program;
}

function createFogTexture(
  gl: WebGL2RenderingContext,
  grid: GridSize,
  texels: Uint8Array,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Could not create fog texture.');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    grid.width,
    grid.height,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    texels,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

export interface WebGLFogLayerOptions {
  id: string;
  grid: GridSize;
  gridParams: GridParams;
  initialMask: Uint8Array;
  reducedMotion: () => boolean;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * SPEC.md Section 7.3's fog custom layer. `applyDelta` is the API the fog
 * controller drives on every reveal: it diffs two masks, uploads only the
 * changed region (`texSubImage2D`, never the whole texture), and animates
 * that region from opaque to clear over `FOG_REVEAL_ANIMATION_MS` unless
 * `reducedMotion()` is true (Section 8.2), in which case the final state is
 * written in a single upload with no animation frames at all.
 */
export class WebGLFogLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private readonly grid: GridSize;
  private readonly gridParams: GridParams;
  private readonly initialMask: Uint8Array;
  private readonly reducedMotion: () => boolean;
  private readonly now: () => number;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private positionLoc = -1;
  private uvLoc = -1;
  private matrixLoc: WebGLUniformLocation | null = null;
  private texelSizeLoc: WebGLUniformLocation | null = null;
  private fogColorLoc: WebGLUniformLocation | null = null;
  private animationHandle: number | null = null;

  constructor(options: WebGLFogLayerOptions) {
    this.id = options.id;
    this.grid = options.grid;
    this.gridParams = options.gridParams;
    this.initialMask = options.initialMask;
    this.reducedMotion = options.reducedMotion;
    this.now = options.now ?? (() => Date.now());
    this.requestFrame =
      options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  }

  onAdd(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    // Gated by the controller's own WebGL2Detector before this layer is
    // ever constructed (fog-controller.ts) - MapLibre uses WebGL2 whenever
    // the browser supports it, matching that same probe, so this cast
    // reflects an assumption already validated one layer up rather than an
    // unchecked one made here.
    const gl2 = gl as WebGL2RenderingContext;
    this.map = map;
    this.gl = gl2;
    this.program = linkProgram(gl2);
    this.texture = createFogTexture(gl2, this.grid, maskToFogTexels(this.initialMask, this.grid));

    this.quadBuffer = gl2.createBuffer();
    this.writeQuad(gl2);

    this.positionLoc = gl2.getAttribLocation(this.program, 'a_position');
    this.uvLoc = gl2.getAttribLocation(this.program, 'a_uv');
    this.matrixLoc = gl2.getUniformLocation(this.program, 'u_matrix');
    this.texelSizeLoc = gl2.getUniformLocation(this.program, 'u_texelSize');
    this.fogColorLoc = gl2.getUniformLocation(this.program, 'u_fogColor');
  }

  render: CustomRenderMethod = (gl, matrix) => {
    const gl2 = gl as WebGL2RenderingContext;
    if (!this.program || !this.quadBuffer || !this.texture) {
      return;
    }
    gl2.useProgram(this.program);

    // The quad follows the camera, so it is rebuilt here rather than once in
    // onAdd: four vertices per frame, against a fixed quad that stopped
    // covering the screen the moment the map was rotated (grid-geometry.ts).
    this.writeQuad(gl2);
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    gl2.enableVertexAttribArray(this.positionLoc);
    gl2.vertexAttribPointer(this.positionLoc, 2, gl2.FLOAT, false, stride, 0);
    gl2.enableVertexAttribArray(this.uvLoc);
    gl2.vertexAttribPointer(
      this.uvLoc,
      2,
      gl2.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );

    gl2.uniformMatrix4fv(this.matrixLoc, false, matrix);
    gl2.uniform2f(this.texelSizeLoc, 1 / this.grid.width, 1 / this.grid.height);
    gl2.uniform3f(this.fogColorLoc, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);

    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, this.texture);
    gl2.uniform1i(gl2.getUniformLocation(this.program, 'u_fog'), 0);

    gl2.drawArrays(gl2.TRIANGLE_STRIP, 0, 4);
  };

  /**
   * The camera's current lng/lat extent, or null before the layer has a map.
   *
   * `getBounds()` in maplibre-gl 4.7.1 unprojects the four screen corners and
   * returns the smallest box containing them, so it already accounts for
   * bearing and for pitch; under pitch its own horizon clamp keeps the
   * sampled points below the horizon, so the result stays finite (verified
   * against the 4.7.1 transform - see the task report). `fogQuadBox` still
   * checks, because a non-finite corner would make the whole quad vanish and
   * take all the fog with it.
   */
  private viewportBox(): LngLatBox | null {
    const bounds = this.map?.getBounds();
    return bounds ? lngLatBox(bounds) : null;
  }

  private writeQuad(gl: WebGL2RenderingContext): void {
    if (!this.quadBuffer) {
      return;
    }
    const corners = gridQuadCorners(this.gridParams, this.viewportBox());
    const vertexData = new Float32Array(corners.length * 4);
    corners.forEach((corner, i) => {
      vertexData[i * 4] = corner.merc.x;
      vertexData[i * 4 + 1] = corner.merc.y;
      vertexData[i * 4 + 2] = corner.u;
      vertexData[i * 4 + 3] = corner.v;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);
  }

  onRemove(_map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl2 = gl as WebGL2RenderingContext;
    if (this.animationHandle != null) {
      this.cancelFrame(this.animationHandle);
      this.animationHandle = null;
    }
    if (this.texture) {
      gl2.deleteTexture(this.texture);
    }
    if (this.quadBuffer) {
      gl2.deleteBuffer(this.quadBuffer);
    }
    if (this.program) {
      gl2.deleteProgram(this.program);
    }
    this.texture = null;
    this.quadBuffer = null;
    this.program = null;
    this.gl = null;
    this.map = null;
  }

  /**
   * Diffs `previousMask` against `nextMask`, uploads only the bounding
   * rectangle of the cells that changed (never the whole texture), and
   * animates that rectangle from opaque fog to clear over
   * `FOG_REVEAL_ANIMATION_MS` - or writes the finished state in one upload
   * when `reducedMotion()` is true.
   */
  applyDelta(previousMask: Uint8Array, nextMask: Uint8Array): void {
    if (!this.gl || !this.texture) {
      return;
    }
    const changed = diffRevealedCells(previousMask, nextMask, this.grid);
    const rect = boundingTexelRect(changed, this.grid);
    if (!rect) {
      return;
    }

    if (this.animationHandle != null) {
      this.cancelFrame(this.animationHandle);
      this.animationHandle = null;
    }

    const finalTexels = maskToFogTexels(nextMask, this.grid);
    const finalRect = extractTexelRect(finalTexels, this.grid, rect);

    if (this.reducedMotion()) {
      this.uploadRect(rect, finalRect);
      this.map?.triggerRepaint();
      return;
    }

    const changedSet = new Set(changed);
    const start = this.now();
    // Paints the first (elapsed = 0) frame synchronously - the browser
    // shows the current texture until the next repaint regardless, and
    // this way a test can assert on frame 1 without also depending on
    // whatever the injected `requestFrame` scheduler does with its
    // callback (see webgl-fog-layer.test.ts). Every following frame runs
    // only when that scheduler invokes it.
    const frame = () => {
      const progress = revealProgress(this.now() - start, CONFIG.FOG_REVEAL_ANIMATION_MS, false);
      const buffer = new Uint8Array(rect.width * rect.height);
      for (let i = 0; i < buffer.length; i++) {
        const localX = i % rect.width;
        const localY = Math.floor(i / rect.width);
        const cellIndex = texelToCell(rect.x + localX, rect.y + localY, this.grid);
        buffer[i] = changedSet.has(cellIndex) ? fogTexelAt(progress) : finalRect[i];
      }
      this.uploadRect(rect, buffer);
      this.map?.triggerRepaint();

      if (progress < 1) {
        this.animationHandle = this.requestFrame(frame);
      } else {
        this.animationHandle = null;
      }
    };
    frame();
  }

  private uploadRect(rect: TexelRect, data: Uint8Array): void {
    const gl = this.gl;
    if (!gl || !this.texture) {
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      gl.RED,
      gl.UNSIGNED_BYTE,
      data,
    );
  }
}
