import { describe, expect, it } from 'vitest';
import { generateAvatarSvg } from './avatar.js';

const SAMPLE_SEEDS = Array.from({ length: 25 }, (_, i) => `seed-${i}`);

describe('generateAvatarSvg', () => {
  it('is deterministic for the same seed', () => {
    const first = generateAvatarSvg('alexander');
    const second = generateAvatarSvg('alexander');
    expect(first).toBe(second);
  });

  it('produces at least twenty distinct outputs across twenty-five distinct seeds', () => {
    const outputs = new Set(SAMPLE_SEEDS.map((seed) => generateAvatarSvg(seed)));
    expect(outputs.size).toBeGreaterThanOrEqual(20);
  });

  it('returns a well-formed, scalable SVG string', () => {
    const svg = generateAvatarSvg('example');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox');

    const rootTag = svg.match(/^<svg[^>]*>/)?.[0] ?? '';
    expect(rootTag).not.toContain('width=');
    expect(rootTag).not.toContain('height=');
  });

  it('uses only the two supplied colours, never a third', () => {
    const ink = '#123456';
    const paper = '#abcdef';
    const svg = generateAvatarSvg('example', ink, paper);

    const hexColours = new Set(svg.match(/#[0-9a-fA-F]{3,8}/g));
    expect(hexColours).toEqual(new Set([ink, paper]));
    expect(svg).not.toContain('rgb(');
  });

  it('changes output when custom colours are passed, and includes them', () => {
    const defaultOutput = generateAvatarSvg('example');
    const ink = '#00ff00';
    const paper = '#ff00ff';
    const customOutput = generateAvatarSvg('example', ink, paper);

    expect(customOutput).not.toBe(defaultOutput);
    expect(customOutput).toContain(ink);
    expect(customOutput).toContain(paper);
  });

  it('does not throw and still returns a valid SVG for an empty seed', () => {
    const svg = generateAvatarSvg('');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox');
  });

  it('contains no script tags or inline event handlers', () => {
    for (const seed of SAMPLE_SEEDS) {
      const svg = generateAvatarSvg(seed);
      expect(svg).not.toContain('<script');
      expect(svg).not.toMatch(/\son\w+\s*=/i);
    }
  });
});
