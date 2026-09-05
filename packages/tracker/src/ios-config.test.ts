import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import { describe, expect, it } from 'vitest';

// ios/SPEC.md Section 12, Step F's substep F1 and its Definition of Done:
// project.yml, Config/Server.xcconfig, the Info.plist properties
// project.yml generates, and PrivacyInfo.xcprivacy, checked against this
// document and against config.ts. ios/SPEC.md 13.1 says plainly that
// nothing in this repository can run XcodeGen, Xcode or a simulator - this
// suite, run under `pnpm --filter @tipsytrails/tracker test`, is the whole
// of what can be proven about these four files before the owner's Mac.
//
// PARSING STRATEGY, stated once here rather than at every call site:
// packages/tracker/package.json declares only @tipsytrails/shared and vite
// (ios/SPEC.md I7 puts a pnpm-lock.yaml change - which adding a YAML or XML
// parser would cause - out of reach for this branch), so both project.yml
// and PrivacyInfo.xcprivacy are read as text and picked apart with regular
// expressions targeted at the specific keys this file needs, in the style
// packages/api/src/compose-caddy-env.test.ts already uses for
// docker-compose.yml and the Caddyfile. This is a TEXT check, not a SCHEMA
// check: it catches a missing key, a wrong value, or a value that drifted
// from config.ts, but it does not catch every way a YAML or plist document
// can be malformed - a key repeated under a parent this file's regexes do
// not distinguish, a value quoted in a shape the patterns below do not
// expect, or a key nobody named here. A real parser would catch all of
// that; this suite is what is possible without widening pnpm-lock.yaml.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const IOS_ROOT = join(REPO_ROOT, 'ios');

const projectYml = readFileSync(join(IOS_ROOT, 'project.yml'), 'utf-8');
const serverXcconfig = readFileSync(join(IOS_ROOT, 'Config/Server.xcconfig'), 'utf-8');
const privacyManifest = readFileSync(
  join(IOS_ROOT, 'TipsyTrails/Resources/PrivacyInfo.xcprivacy'),
  'utf-8',
);

// A minimal structural stand-in for "is valid YAML": no tab characters
// (YAML forbids them for indentation) and every non-blank, non-comment line
// either opens a `key:`, starts a `- item`, or is indented further than
// column 0 (a block-scalar continuation, a nested key, or a nested list
// item - all already covered by their own key/list-item line). It cannot
// catch every malformed YAML document - see the note above - only the
// shapes a hand-edit of this file would most obviously break: a stray tab,
// or a top-level line that is neither a key nor a dash.
function looksLikeValidYaml(text: string): boolean {
  if (text.includes('\t')) return false;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > 0) continue;
    const trimmed = line.trim();
    const isListItem = trimmed.startsWith('- ') || trimmed === '-';
    const isKeyLine = /^[A-Za-z0-9_.$()-]+:/.test(trimmed);
    if (!isListItem && !isKeyLine) return false;
  }
  return true;
}

// The scalar list following a `key:` line - `- item` lines indented deeper
// than the key, stopping at the first line indented at or shallower. Reads
// both `UIBackgroundModes` and `WKAppBoundDomains` below; both are exactly
// this shape in project.yml.
function yamlListAfter(text: string, key: string): string[] {
  const lines = text.split('\n');
  const keyIndex = lines.findIndex((line) => line.trim() === `${key}:`);
  if (keyIndex === -1) return [];
  const keyIndent = lines[keyIndex].length - lines[keyIndex].trimStart().length;
  const items: string[] = [];
  for (const line of lines.slice(keyIndex + 1)) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break;
    const match = /^-\s*(.+)$/.exec(line.trim());
    if (!match) break;
    items.push(match[1].trim());
  }
  return items;
}

// The folded block scalar (`>-`) following a `key:` line, joined back into
// one string the way YAML folds it. Used for the three purpose strings,
// including the nested `TTPlay` key under
// `NSLocationTemporaryUsageDescriptionDictionary`.
function yamlFoldedScalarAfter(text: string, key: string): string {
  const lines = text.split('\n');
  const keyIndex = lines.findIndex((line) => line.trim().startsWith(`${key}:`));
  if (keyIndex === -1) return '';
  const keyIndent = lines[keyIndex].length - lines[keyIndex].trimStart().length;
  const parts: string[] = [];
  for (const line of lines.slice(keyIndex + 1)) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break;
    parts.push(line.trim());
  }
  return parts.join(' ');
}

// `KEY = value` from an xcconfig file - the whole rest of the line, trimmed.
function xcconfigValue(text: string, key: string): string {
  const match = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(text);
  return match ? match[1].trim() : '';
}

// Every numeric literal in project.yml outside a comment, kept as a single
// token even when it has a decimal point - "17.0" is one token, not "17"
// and "0", which is what stops the deployment target and the Swift version
// from being mistaken for a stray TRACKER_* constant.
function numericLiteralsExcludingComments(text: string): string[] {
  const tokens: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0];
    for (const match of line.matchAll(/-?\d+(?:\.\d+)?/g)) {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

describe('project.yml', () => {
  it('parses as YAML (structural check) and names at least one target', () => {
    expect(looksLikeValidYaml(projectYml)).toBe(true);
    expect(projectYml).toMatch(/^targets:/m);
    expect(projectYml).toMatch(/^\s*TipsyTrails:/m);
  });

  it("sets the target's deployment target to 17.0", () => {
    const match = /^\s*deploymentTarget:\s*['"]?([\d.]+)['"]?\s*$/m.exec(projectYml);
    expect(match?.[1]).toBe('17.0');
  });

  it('sets the bundle identifier to com.ahultsch.tipsytrails', () => {
    const match = /PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)/.exec(projectYml);
    expect(match?.[1]).toBe('com.ahultsch.tipsytrails');
  });

  it('makes Config/Server.xcconfig the base configuration for Debug and Release', () => {
    const match = /configFiles:\s*\n\s*Debug:\s*(\S+)\s*\n\s*Release:\s*(\S+)/.exec(projectYml);
    expect(match?.[1]).toBe('Config/Server.xcconfig');
    expect(match?.[2]).toBe('Config/Server.xcconfig');
  });

  it('declares no numeric literal that duplicates a TRACKER_* value from CONFIG (I1)', () => {
    const trackerNumbers = Object.entries(CONFIG)
      .filter(([key, value]) => key.startsWith('TRACKER_') && typeof value === 'number')
      .map(([key, value]) => [key, String(value)] as const);
    expect(trackerNumbers.length).toBeGreaterThan(0);

    const literals = new Set(numericLiteralsExcludingComments(projectYml));
    const duplicated = trackerNumbers.filter(([, value]) => literals.has(value));
    expect(
      duplicated,
      `project.yml has a numeric literal matching these TRACKER_* constants, which should ` +
        `reach Swift through the tracker instead (ios/SPEC.md I1): ${duplicated
          .map(([key]) => key)
          .join(', ')}`,
    ).toEqual([]);
  });
});

describe('Info.plist properties (project.yml info.properties)', () => {
  it('sets UIBackgroundModes to exactly [location] (6.1)', () => {
    // Equality, not membership: a second background mode is a capability
    // this app must not have.
    expect(yamlListAfter(projectYml, 'UIBackgroundModes')).toEqual(['location']);
  });

  it('gives all three purpose strings, non-empty and ASCII (10.3, C9)', () => {
    // C9's "English only" is checked here as "ASCII", which is a proxy: it
    // catches an em dash, a smart quote, or a non-English character sneaking
    // in, but it would not catch English words borrowed into another
    // language's grammar, and it would wrongly fail a purpose string that
    // legitimately needed an accented proper noun. Neither case arises here.
    //
    // ios/SPEC.md's own Definition of Done (Section 12, Step F) calls these
    // "the four purpose strings", but Section 10.3 names exactly three keys
    // (NSLocationWhenInUseUsageDescription,
    // NSLocationAlwaysAndWhenInUseUsageDescription, and
    // NSLocationTemporaryUsageDescriptionDictionary's single TTPlay entry)
    // and this file writes exactly those three. The count in the DoD looks
    // like a drafting slip rather than a fourth string this document
    // describes anywhere; flagged in the report rather than silently
    // "fixed" by inventing a fourth key.
    const whenInUse = yamlFoldedScalarAfter(projectYml, 'NSLocationWhenInUseUsageDescription');
    const always = yamlFoldedScalarAfter(
      projectYml,
      'NSLocationAlwaysAndWhenInUseUsageDescription',
    );
    const ttPlay = yamlFoldedScalarAfter(projectYml, 'TTPlay');

    for (const value of [whenInUse, always, ttPlay]) {
      expect(value.length).toBeGreaterThan(0);
      // Printable ASCII plus space, deliberately excluding the control-code
      // range below 0x20 (which no legitimate purpose string needs and
      // which eslint's no-control-regex rule flags in a wider pattern).
      expect(/^[\x20-\x7E]*$/.test(value)).toBe(true);
    }
  });

  it('lists WKAppBoundDomains as exactly one entry, referencing SERVER_HOST', () => {
    const domains = yamlListAfter(projectYml, 'WKAppBoundDomains');
    expect(domains).toEqual(['$(SERVER_HOST)']);

    const serverHost = xcconfigValue(serverXcconfig, 'SERVER_HOST');
    expect(serverHost.length).toBeGreaterThan(0);
  });

  it("agrees with SERVER_ORIGIN: it ends with the xcconfig's SERVER_HOST (the 'cannot disagree' check)", () => {
    const serverHost = xcconfigValue(serverXcconfig, 'SERVER_HOST');
    const serverOrigin = xcconfigValue(serverXcconfig, 'SERVER_ORIGIN');
    expect(serverHost.length).toBeGreaterThan(0);
    expect(serverOrigin.endsWith(serverHost)).toBe(true);
  });

  it('exposes TTServerOrigin as $(SERVER_ORIGIN)', () => {
    const match = /TTServerOrigin:\s*(\S+)/.exec(projectYml);
    expect(match?.[1]).toBe('$(SERVER_ORIGIN)');
  });
});

describe('the tracker build phase (ios/SPEC.md 4.3)', () => {
  it('names packages/tracker/dist/tracker.js and lists the copied file in outputFiles', () => {
    expect(projectYml).toMatch(/preBuildScripts:/);
    expect(projectYml).toContain('packages/tracker/dist/tracker.js');
    const outputFiles = yamlListAfter(projectYml, 'outputFiles');
    expect(outputFiles.some((entry) => entry.endsWith('tracker.js'))).toBe(true);
  });
});

// A tag-balance walk over the plist, not a validating parser: it catches an
// unclosed <dict> or <array>, not a misplaced attribute or an entity
// reference. See the file-level note on why there is no real XML parser
// here.
function xmlTagsBalanced(xml: string): boolean {
  const stripped = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const stack: string[] = [];
  for (const match of stripped.matchAll(/<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?\/?>/g)) {
    const [full, name] = match;
    if (full.startsWith('</')) {
      if (stack.pop() !== name) return false;
    } else if (!full.endsWith('/>')) {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

// The value plist-tag pair immediately following one <key>name</key> -
// e.g. `<key>NSPrivacyTracking</key>\n\t<false/>` returns 'false'.
function plistValueAfterKey(xml: string, key: string): string {
  const match = new RegExp(`<key>${key}</key>\\s*<([a-zA-Z][\\w-]*)(?:\\s[^>]*)?/?>`).exec(xml);
  return match ? match[1] : '';
}

describe('PrivacyInfo.xcprivacy (10.3)', () => {
  it('is well-formed XML (tag-balance check)', () => {
    expect(privacyManifest).toMatch(/^<\?xml/);
    expect(xmlTagsBalanced(privacyManifest)).toBe(true);
  });

  it('declares NSPrivacyTracking false and no tracking domains', () => {
    expect(plistValueAfterKey(privacyManifest, 'NSPrivacyTracking')).toBe('false');
    const trackingDomainsBlock =
      /<key>NSPrivacyTrackingDomains<\/key>\s*<array\s*\/?>(?:\s*<\/array>)?/.exec(privacyManifest);
    expect(trackingDomainsBlock).not.toBeNull();
  });

  it('declares exactly one collected data type: precise location, linked, not tracking, app functionality', () => {
    expect(privacyManifest).toContain(
      '<string>NSPrivacyCollectedDataTypeLocationPreciseLocation</string>',
    );
    const collectedBlockMatch =
      /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(privacyManifest);
    expect(collectedBlockMatch).not.toBeNull();
    const block = collectedBlockMatch?.[1] ?? '';
    expect((block.match(/<dict>/g) ?? []).length).toBe(1);
    expect(plistValueAfterKey(block, 'NSPrivacyCollectedDataTypeLinked')).toBe('true');
    expect(plistValueAfterKey(block, 'NSPrivacyCollectedDataTypeTracking')).toBe('false');
    expect(block).toContain('<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>');
  });

  it('declares exactly one accessed API type: UserDefaults, reason CA92.1', () => {
    const accessedBlockMatch =
      /<key>NSPrivacyAccessedAPITypes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(privacyManifest);
    expect(accessedBlockMatch).not.toBeNull();
    const block = accessedBlockMatch?.[1] ?? '';
    expect((block.match(/<dict>/g) ?? []).length).toBe(1);
    expect(block).toContain('<string>NSPrivacyAccessedAPICategoryUserDefaults</string>');
    expect(block).toContain('<string>CA92.1</string>');
  });
});
