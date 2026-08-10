// SPEC.md Section 7.3's fallback gate: "If WebGL2 is unavailable, fall back
// to a 2D canvas overlay." A scratch, never-attached canvas is the standard
// way to probe this without side effects.
//
// Exposed as an injectable function type - fog-controller.ts takes one as a
// constructor option instead of calling detectWebGL2 directly - because
// jsdom (this repo's test environment) implements no WebGL context at all,
// so the only way to exercise both the WebGL2 and the 2D-canvas-fallback
// code paths in a test is to force the detector's result rather than the
// real browser capability. See fog-controller.test.ts.
export type WebGL2Detector = () => WebGL2RenderingContext | null;

export const detectWebGL2: WebGL2Detector = () => {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2');
  } catch {
    return null;
  }
};
