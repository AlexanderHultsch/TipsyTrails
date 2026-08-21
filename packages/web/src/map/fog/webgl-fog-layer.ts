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
import { gridQuadCorners } from './grid-geometry.js';
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

// Section 7.3: "The edge is softened with a two-cell blur plus a
// low-frequency noise offset, so the boundary never reads as a hard circle
// or as visible squares." The noise displaces the *sampling position*
// before the blur (domain warping) so the revealed boundary is perturbed
// organically rather than staying a smooth circle/rounded-square outline;
// the 5x5 box blur (a 2-texel radius around each fragment) is what removes
// the per-cell staircase edge a nearest/bilinear sample of a binary mask
// would otherwise show.
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_fog;
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

// Section 7.3: fog dense enough to hide detail, short of literal alpha 1 so
// unrevealed ground still reads as fogged terrain rather than as a blank
// panel. Orientation on unrevealed ground comes from the motorway layer,
// which is drawn *above* this one (ink-style.ts, fog-controller.ts), not
// from what shows through here.
const float FOG_MAX_OPACITY = ${glslFloat(CONFIG.FOG_MAX_OPACITY)};

void main() {
  // The quad reaches past the grid into the map's padding ring
  // (grid-geometry.ts), which has no cells and so can never be revealed.
  // WebGL2 has no CLAMP_TO_BORDER, and CLAMP_TO_EDGE would smear the
  // grid's edge texels across that whole ring - a cell revealed at the
  // city's edge would trail a cleared stripe out to the boundary - so the
  // ring is decided here instead of by the sampler.
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    fragColor = vec4(u_fogColor * FOG_MAX_OPACITY, FOG_MAX_OPACITY);
    return;
  }

  vec2 noiseCoord = v_uv / (u_texelSize * 6.0);
  vec2 offsetCells = (vec2(valueNoise(noiseCoord), valueNoise(noiseCoord + 91.7)) - 0.5) * 3.0;
  vec2 uv = v_uv + offsetCells * u_texelSize;

  float sum = 0.0;
  float weight = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec2 sampleUv = uv + vec2(float(dx), float(dy)) * u_texelSize;
      sum += texture(u_fog, sampleUv).r;
      weight += 1.0;
    }
  }
  float fog = sum / weight;
  float alpha = smoothstep(0.12, 0.88, fog) * FOG_MAX_OPACITY;
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

    const corners = gridQuadCorners(this.gridParams);
    const vertexData = new Float32Array(corners.length * 4);
    corners.forEach((corner, i) => {
      vertexData[i * 4] = corner.merc.x;
      vertexData[i * 4 + 1] = corner.merc.y;
      vertexData[i * 4 + 2] = corner.u;
      vertexData[i * 4 + 3] = corner.v;
    });
    this.quadBuffer = gl2.createBuffer();
    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.quadBuffer);
    gl2.bufferData(gl2.ARRAY_BUFFER, vertexData, gl2.STATIC_DRAW);

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

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.quadBuffer);
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
