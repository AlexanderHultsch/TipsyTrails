import { describe, expect, it, vi } from 'vitest';
import type { GridParams } from '@tipsytrails/shared';
import { CONFIG } from '@tipsytrails/shared';
import { WebGLFogLayer, glslFloat, glslInt } from './webgl-fog-layer.js';
import { gridQuadCorners } from './grid-geometry.js';
import type { LngLatBox } from './grid-geometry.js';

// jsdom has no WebGL2 context (the task brief: "do not try to instantiate a
// real GL context"), so WebGLFogLayer is exercised here against a hand-built
// fake shaped like the small slice of WebGL2RenderingContext it actually
// calls. Every `create*` call returns a distinct token object so the
// matching `delete*` call in onRemove can be asserted against it. This
// proves the class's own call sequencing and texture-region math; it proves
// nothing about how a real GPU rasterises the shader - see the task report.
function createFakeGl() {
  let nextId = 1;
  const calls: Record<string, unknown[][]> = {};
  function record(name: string, args: unknown[]) {
    (calls[name] ??= []).push(args);
  }
  function tokenFactory(kind: string) {
    return () => {
      const token = { kind, id: nextId++ };
      record(`create${kind}`, [token]);
      return token;
    };
  }

  const gl = {
    // Constants - real WebGL2 numeric values aren't important here, only
    // that each is distinct and stable across calls.
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    DYNAMIC_DRAW: 6,
    TEXTURE_2D: 7,
    R8: 8,
    RED: 9,
    UNSIGNED_BYTE: 10,
    TEXTURE_MIN_FILTER: 11,
    TEXTURE_MAG_FILTER: 12,
    LINEAR: 13,
    TEXTURE_WRAP_S: 14,
    TEXTURE_WRAP_T: 15,
    CLAMP_TO_EDGE: 16,
    UNPACK_ALIGNMENT: 17,
    FLOAT: 18,
    TEXTURE0: 19,
    TRIANGLE_STRIP: 20,

    createShader: vi.fn(tokenFactory('Shader')),
    shaderSource: vi.fn((...args: unknown[]) => record('shaderSource', args)),
    compileShader: vi.fn((...args: unknown[]) => record('compileShader', args)),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn((...args: unknown[]) => record('deleteShader', args)),

    createProgram: vi.fn(tokenFactory('Program')),
    attachShader: vi.fn((...args: unknown[]) => record('attachShader', args)),
    linkProgram: vi.fn((...args: unknown[]) => record('linkProgram', args)),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn((...args: unknown[]) => record('deleteProgram', args)),
    useProgram: vi.fn((...args: unknown[]) => record('useProgram', args)),

    createTexture: vi.fn(tokenFactory('Texture')),
    bindTexture: vi.fn((...args: unknown[]) => record('bindTexture', args)),
    texImage2D: vi.fn((...args: unknown[]) => record('texImage2D', args)),
    texSubImage2D: vi.fn((...args: unknown[]) => record('texSubImage2D', args)),
    texParameteri: vi.fn((...args: unknown[]) => record('texParameteri', args)),
    pixelStorei: vi.fn((...args: unknown[]) => record('pixelStorei', args)),
    deleteTexture: vi.fn((...args: unknown[]) => record('deleteTexture', args)),
    activeTexture: vi.fn((...args: unknown[]) => record('activeTexture', args)),

    createBuffer: vi.fn(tokenFactory('Buffer')),
    bindBuffer: vi.fn((...args: unknown[]) => record('bindBuffer', args)),
    bufferData: vi.fn((...args: unknown[]) => record('bufferData', args)),
    deleteBuffer: vi.fn((...args: unknown[]) => record('deleteBuffer', args)),

    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn(() => ({ kind: 'UniformLocation' })),
    enableVertexAttribArray: vi.fn((...args: unknown[]) => record('enableVertexAttribArray', args)),
    vertexAttribPointer: vi.fn((...args: unknown[]) => record('vertexAttribPointer', args)),
    uniformMatrix4fv: vi.fn((...args: unknown[]) => record('uniformMatrix4fv', args)),
    uniform1i: vi.fn((...args: unknown[]) => record('uniform1i', args)),
    uniform2f: vi.fn((...args: unknown[]) => record('uniform2f', args)),
    uniform3f: vi.fn((...args: unknown[]) => record('uniform3f', args)),
    drawArrays: vi.fn((...args: unknown[]) => record('drawArrays', args)),
  };

  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

const GRID_PARAMS: GridParams = {
  origin_lat: 48.94,
  origin_lon: 8.275,
  grid_width: 6,
  grid_height: 5,
  cell_size_m: 50,
};
const GRID = { width: GRID_PARAMS.grid_width, height: GRID_PARAMS.grid_height };

function emptyMask(): Uint8Array {
  return new Uint8Array(Math.ceil((GRID.width * GRID.height) / 8));
}

function setCell(mask: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(mask);
  copy[index >> 3] |= 1 << (index & 7);
  return copy;
}

// The camera the layer reads its quad extent from. `getBounds()` is the one
// map call the render path makes (webgl-fog-layer.ts): in maplibre-gl 4.7.1
// it is the smallest lng/lat box around the four unprojected screen corners,
// so it already widens as the map is rotated. Here it is a plain settable
// box, so a test can move the camera without a real transform.
function fakeMap(box: LngLatBox = { west: 8.276, south: 48.941, east: 8.278, north: 48.9425 }) {
  const state = { box };
  const map = {
    triggerRepaint: vi.fn(),
    getBounds: () => ({
      getWest: () => state.box.west,
      getSouth: () => state.box.south,
      getEast: () => state.box.east,
      getNorth: () => state.box.north,
    }),
    setBox: (next: LngLatBox) => {
      state.box = next;
    },
  };
  return map as unknown as import('maplibre-gl').Map & { setBox: (next: LngLatBox) => void };
}

function lastQuad(gl: WebGL2RenderingContext): Float32Array {
  const calls = (gl.bufferData as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][1] as Float32Array;
}

function expectedQuad(viewport: LngLatBox | null): Float32Array {
  const corners = gridQuadCorners(GRID_PARAMS, viewport);
  const data = new Float32Array(corners.length * 4);
  corners.forEach((corner, i) => {
    data[i * 4] = corner.merc.x;
    data[i * 4 + 1] = corner.merc.y;
    data[i * 4 + 2] = corner.u;
    data[i * 4 + 3] = corner.v;
  });
  return data;
}

describe('WebGLFogLayer', () => {
  it('uploads the whole grid as the initial R8 texture on onAdd, once', () => {
    const { gl } = createFakeGl();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
    });

    layer.onAdd(fakeMap(), gl);

    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
    const [, , internalFormat, width, height] = (gl.texImage2D as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(internalFormat).toBe(gl.R8);
    expect(width).toBe(GRID.width);
    expect(height).toBe(GRID.height);
  });

  it('draws a single quad (4 vertices, TRIANGLE_STRIP) per render call', () => {
    const { gl } = createFakeGl();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
    });
    layer.onAdd(fakeMap(), gl);

    layer.render(gl, new Float32Array(16), {} as never);

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLE_STRIP, 0, 4);
  });

  it('updates only the bounding rectangle of changed cells, not the whole texture', () => {
    const { gl } = createFakeGl();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => true, // no animation frames to step through
    });
    layer.onAdd(fakeMap(), gl);
    (gl.texSubImage2D as ReturnType<typeof vi.fn>).mockClear();

    // Reveal cells (1,1) and (2,2) in the 6x5 grid -> indices 7 and 14.
    const before = emptyMask();
    const after = setCell(setCell(before, 7), 14);

    layer.applyDelta(before, after);

    expect(gl.texSubImage2D).toHaveBeenCalledTimes(1);
    const [, , xoffset, yoffset, width, height] = (gl.texSubImage2D as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect({ xoffset, yoffset, width, height }).toEqual({
      xoffset: 1,
      yoffset: 1,
      width: 2,
      height: 2,
    });
  });

  it('does nothing when no cell changed', () => {
    const { gl } = createFakeGl();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => true,
    });
    layer.onAdd(fakeMap(), gl);
    (gl.texSubImage2D as ReturnType<typeof vi.fn>).mockClear();

    const mask = emptyMask();
    layer.applyDelta(mask, new Uint8Array(mask));

    expect(gl.texSubImage2D).not.toHaveBeenCalled();
  });

  it('writes the final state in a single upload with no animation frames when reducedMotion is true', () => {
    const { gl } = createFakeGl();
    const requestFrame = vi.fn();
    const cancelFrame = vi.fn();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => true,
      requestFrame,
      cancelFrame,
    });
    layer.onAdd(fakeMap(), gl);
    (gl.texSubImage2D as ReturnType<typeof vi.fn>).mockClear();

    const before = emptyMask();
    const after = setCell(before, 0);
    layer.applyDelta(before, after);

    expect(requestFrame).not.toHaveBeenCalled();
    expect(gl.texSubImage2D).toHaveBeenCalledTimes(1);
    // The one revealed cell in the rect must already be at its final,
    // fully-clear texel value (0), not mid-animation.
    const data = (gl.texSubImage2D as ReturnType<typeof vi.fn>).mock.calls[0][8] as Uint8Array;
    expect(Array.from(data)).toEqual([0]);
  });

  it('animates the changed region from opaque to clear over successive frames when motion is allowed', () => {
    const { gl } = createFakeGl();
    let time = 0;
    // An object property, not a bare `let`, so it doesn't fall into
    // TypeScript's control-flow narrowing of a closure-mutated `let` back
    // to its literal initial value at the read site below.
    const pendingFrame: { current: FrameRequestCallback | null } = { current: null };
    const requestFrame = vi.fn((cb: FrameRequestCallback) => {
      pendingFrame.current = cb;
      return 1;
    });
    const cancelFrame = vi.fn();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
      now: () => time,
      requestFrame,
      cancelFrame,
    });
    layer.onAdd(fakeMap(), gl);
    (gl.texSubImage2D as ReturnType<typeof vi.fn>).mockClear();

    const before = emptyMask();
    const after = setCell(before, 0);
    layer.applyDelta(before, after);

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(gl.texSubImage2D).toHaveBeenCalledTimes(1);
    const firstFrameData = (gl.texSubImage2D as ReturnType<typeof vi.fn>).mock
      .calls[0][8] as Uint8Array;
    expect(firstFrameData[0]).toBe(255); // elapsed 0ms -> still fully fogged

    time = 300; // halfway through the 600ms animation
    pendingFrame.current?.(time);
    const midFrameData = (gl.texSubImage2D as ReturnType<typeof vi.fn>).mock
      .calls[1][8] as Uint8Array;
    expect(midFrameData[0]).toBe(128);

    time = 600; // animation complete
    pendingFrame.current?.(time);
    const lastFrameData = (gl.texSubImage2D as ReturnType<typeof vi.fn>).mock
      .calls[2][8] as Uint8Array;
    expect(lastFrameData[0]).toBe(0);
    // The loop stops requesting further frames once progress reaches 1.
    expect(requestFrame).toHaveBeenCalledTimes(2);
  });

  it('cancels an in-flight animation before starting a new one for a later reveal', () => {
    const { gl } = createFakeGl();
    let handleId = 0;
    const requestFrame = vi.fn(() => ++handleId);
    const cancelFrame = vi.fn();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
      requestFrame,
      cancelFrame,
    });
    layer.onAdd(fakeMap(), gl);

    const step0 = emptyMask();
    const step1 = setCell(step0, 0);
    const step2 = setCell(step1, 1);

    layer.applyDelta(step0, step1);
    expect(cancelFrame).not.toHaveBeenCalled();

    layer.applyDelta(step1, step2);
    expect(cancelFrame).toHaveBeenCalledWith(1);
  });

  it('tears down every GL resource it created and cancels a pending animation on onRemove', () => {
    const { gl } = createFakeGl();
    const requestFrame = vi.fn(() => 42);
    const cancelFrame = vi.fn();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
      requestFrame,
      cancelFrame,
    });
    const map = fakeMap();
    layer.onAdd(map, gl);

    const before = emptyMask();
    const after = setCell(before, 0);
    layer.applyDelta(before, after); // leaves an animation frame pending

    layer.onRemove(map, gl);

    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });

  it('takes the fog opacity in its shader from CONFIG, not from a literal of its own', () => {
    const { gl } = createFakeGl();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
    });

    layer.onAdd(fakeMap(), gl);

    const sources = (gl.shaderSource as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, source]) => source as string,
    );
    const fragment = sources.find((source) => source.includes('FOG_MAX_OPACITY'));
    expect(fragment).toBeDefined();
    expect(fragment).toContain(
      `const float FOG_MAX_OPACITY = ${glslFloat(CONFIG.FOG_MAX_OPACITY)};`,
    );
  });

  it('bakes the edge blur radius and alpha band into the shader from CONFIG', () => {
    const { gl } = createFakeGl();
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
    });

    layer.onAdd(fakeMap(), gl);

    const sources = (gl.shaderSource as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, source]) => source as string,
    );
    const fragment = sources.find((source) => source.includes('EDGE_BLUR_RADIUS'));
    expect(fragment).toBeDefined();

    // The blur radius has to reach the loop bounds as a compile-time int -
    // a uniform could not, and glslFloat's "1.0" would not compile as one.
    expect(fragment).toContain(
      `const int EDGE_BLUR_RADIUS = ${glslInt(CONFIG.FOG_EDGE_BLUR_RADIUS_CELLS)};`,
    );
    expect(fragment).toContain('for (int dy = -EDGE_BLUR_RADIUS; dy <= EDGE_BLUR_RADIUS; dy++)');

    // The alpha ramp is a band centred on the blurred mask's midpoint, not a
    // sweep across nearly its whole range.
    const half = CONFIG.FOG_EDGE_ALPHA_HALF_WIDTH;
    expect(fragment).toContain(`const float EDGE_ALPHA_LOW = ${glslFloat(0.5 - half)};`);
    expect(fragment).toContain(`const float EDGE_ALPHA_HIGH = ${glslFloat(0.5 + half)};`);
    expect(fragment).toContain('smoothstep(EDGE_ALPHA_LOW, EDGE_ALPHA_HIGH, fog)');
  });

  // The two constants above are tunable, so asserting the shader reads them
  // cannot say anything about their values - this does. Section 7.3's edge
  // has to read as a boundary, because it is the feedback that the reveal
  // mechanic works at all, and the pair fixes exactly how wide the visible
  // transition is: blurring a LINEAR-sampled binary mask leaves the blurred
  // value linear in distance from the boundary with slope 1 / (2r + 1) per
  // cell, so the alpha band of half-width h spans 2 * (2r + 1) * h cells.
  //
  // One cell is the line worth holding. Wider than that and the edge is
  // blurrier than the grain of the grid it is an edge of, which is the
  // "fades out so gradually that you cannot make out a clear boundary" this
  // replaced: r = 2 with h = 0.38 came to 3.8 cells, 190 m of ramp.
  it('keeps the visible fog transition inside a single grid cell', () => {
    const cells =
      2 * (2 * CONFIG.FOG_EDGE_BLUR_RADIUS_CELLS + 1) * CONFIG.FOG_EDGE_ALPHA_HALF_WIDTH;
    expect(cells).toBeLessThan(1);
    expect(cells).toBeGreaterThan(0); // an edge, not a hard cut at exactly 0.5
  });

  it('builds the quad from the map viewport and rebuilds it when the camera moves', () => {
    const { gl } = createFakeGl();
    const northUp: LngLatBox = { west: 8.2755, south: 48.9405, east: 8.2775, north: 48.9425 };
    // What the same viewport reports once it is turned: getBounds widens,
    // because the rotated corners stick out past the axis-aligned box.
    const turned: LngLatBox = { west: 8.2748, south: 48.9401, east: 8.2782, north: 48.9429 };
    const map = fakeMap(northUp);
    const layer = new WebGLFogLayer({
      id: 'fog',
      grid: GRID,
      gridParams: GRID_PARAMS,
      initialMask: emptyMask(),
      reducedMotion: () => false,
    });
    layer.onAdd(map, gl);

    layer.render(gl, new Float32Array(16), {} as never);
    const first = lastQuad(gl);
    expect(Array.from(first)).toEqual(Array.from(expectedQuad(northUp)));

    map.setBox(turned);
    layer.render(gl, new Float32Array(16), {} as never);
    const second = lastQuad(gl);
    expect(Array.from(second)).toEqual(Array.from(expectedQuad(turned)));
    expect(Array.from(second)).not.toEqual(Array.from(first));

    // And it is not the fixed city-wide quad that left the rotated corners
    // bare - that one ignores the camera entirely.
    expect(Array.from(second)).not.toEqual(Array.from(expectedQuad(null)));
  });
});

// GLSL has no implicit int->float conversion, so a whole-number opacity that
// stringified as "1" would make the shader fail to compile - and that throw
// is uncaught, taking the map down. There is no GPU here to compile against,
// so this pins the literal's syntax instead.
describe('glslFloat', () => {
  it('gives a whole number a decimal point, so it is a float literal and not an int', () => {
    expect(glslFloat(1)).toBe('1.0');
    expect(glslFloat(0)).toBe('0.0');
  });

  it('leaves a fractional value with its leading zero and its digits intact', () => {
    expect(glslFloat(0.88)).toBe('0.88');
    expect(glslFloat(0.9)).toBe('0.9');
  });

  it('formats the configured fog opacity as valid GLSL float syntax', () => {
    expect(glslFloat(CONFIG.FOG_MAX_OPACITY)).toMatch(/^\d+\.\d+$/);
  });
});

// The mirror of the above: GLSL has no implicit float->int conversion either,
// so the blur radius must reach the shader as "1", never as "1.0".
describe('glslInt', () => {
  it('leaves a whole number without a decimal point', () => {
    expect(glslInt(1)).toBe('1');
    expect(glslInt(0)).toBe('0');
    expect(glslInt(-2)).toBe('-2');
  });

  it('refuses a fractional value instead of emitting a shader that cannot compile', () => {
    expect(() => glslInt(1.5)).toThrow(/whole number/);
  });

  it('formats the configured blur radius as valid GLSL int syntax', () => {
    expect(glslInt(CONFIG.FOG_EDGE_BLUR_RADIUS_CELLS)).toMatch(/^-?\d+$/);
  });
});
