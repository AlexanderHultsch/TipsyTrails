import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ios/SPEC.md Section 12, Step F's substep F4, and its Definition of Done's
// second and third items:
//
//   - "Every Swift file in ios/TipsyTrails/ carries no numeric literal other
//     than 0, 1 and -1" (I1, mechanically) - GUARD 1 below.
//   - "The runtime module implements every method of the Host interface of
//     7.2 and no other" - GUARD 2 below.
//
// ios/SPEC.md 13.1 says plainly that nothing in this repository can compile
// a line of Swift: this suite, run under `pnpm --filter @tipsytrails/tracker
// test`, is the whole of what can be proven about ios/TipsyTrails/ before the
// owner's Mac. Both guards below are, deliberately, TEXT checks and not a
// Swift parser or a type checker - packages/tracker/package.json declares
// only @tipsytrails/shared and vite (ios/SPEC.md I7 puts a pnpm-lock.yaml
// change out of reach for this branch), so `host.ts` and every `.swift` file
// are read as text and picked apart by hand, in the style
// packages/tracker/src/ios-config.test.ts already uses for project.yml and
// PrivacyInfo.xcprivacy.
//
// WHAT NEITHER GUARD PROVES, stated plainly because a guard that overstates
// what it proves is worse than no guard at all: neither guard proves the
// Swift compiles, that a signature matches host.ts's types, that a
// function's body does what its name or its comment claims, or that the
// bridge actually works end to end on a device. Guard 1 proves a textual
// property of every byte outside comments and string literals; Guard 2
// proves a set of ten names is the same set of ten names on both sides of
// the language boundary. ios/SPEC.md 13.1 draws the line between what this
// repository can check and what only Xcode and the owner's phone can, and
// this file sits entirely on the near side of it.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const IOS_ROOT = join(REPO_ROOT, 'ios');
const IOS_APP_ROOT = join(IOS_ROOT, 'TipsyTrails');
const HOST_TS_PATH = join(REPO_ROOT, 'packages/tracker/src/host.ts');
const HOST_BRIDGE_SWIFT_PATH = join(IOS_APP_ROOT, 'Runtime/HostBridge.swift');

// Step F's own decision (ios/SPEC.md Section 12): every layout number
// Section 11's four screens need is confined, by construction, to this one
// file - a SwiftUI padding or a colour component is not one of the
// constants I1 governs (I1 is about the tracker's constants reaching Swift
// from config.ts), so excluding this one file from Guard 1 narrows the rule
// without opening a hole for a real game constant to hide in.
const NUMERIC_LITERAL_EXCLUDED_FILE = join(IOS_APP_ROOT, 'Screens/Metrics.swift');

function listSwiftFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSwiftFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      files.push(fullPath);
    }
  }
  return files;
}

// STRIPPING, its own function because this is where either guard would be
// wrong if it is wrong (a false "numeric literal found" inside a spec
// citation like "Section 7.3", or inside user-facing copy, would make Guard
// 1 untrustworthy and worth deleting the moment it inconveniences someone).
//
// Walks the source once, character by character, and removes three shapes -
// a `//` line comment, a `/* */` block comment (nestable, matching Swift's
// own rule), and a string literal, both the ordinary `"..."` form and the
// triple-quoted `"""..."""` form (Web/WebViewController.swift's injected
// script is written as one of these) - while preserving every real newline
// character that falls inside one of them, so the line number of every
// character that survives is exactly the line number it had in the source.
// Guard 1's failure message is only actionable because of that invariant,
// which is why the tests below check it directly rather than trusting it.
//
// What this does NOT handle, because nothing in this repository needs it
// today (checked by hand, grepping the whole of ios/TipsyTrails/): a raw
// string literal (`#"..."#`), and a `\(...)` string interpolation that
// itself contains a numeric literal or a nested quote - both are swallowed
// whole as part of the enclosing string rather than read back into code. A
// future Swift file that puts a number inside an interpolation would slip
// past this guard silently; that is this function's one known gap.
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
          continue;
        }
        if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
          continue;
        }
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    if (source.slice(i, i + 3) === '"""') {
      i += 3;
      while (i < n && source.slice(i, i + 3) !== '"""') {
        if (source[i] === '\\') {
          if (source[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 3;
      continue;
    }
    if (source[i] === '"') {
      i += 1;
      // An ordinary Swift string literal never spans a real newline - a stray
      // `\n` here means an unterminated literal, and stopping the scan there
      // rather than consuming the rest of the file is the safer failure.
      while (i < n && source[i] !== '"' && source[i] !== '\n') {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

describe("stripCommentsAndStrings (Guard 1's own stripping, tested against hand-written text)", () => {
  it('removes a line comment but keeps the code before it on the same line', () => {
    expect(stripCommentsAndStrings('let x = 5 // see Section 7.3\n')).toBe('let x = 5 \n');
  });

  it('removes a block comment, including one that spans multiple lines', () => {
    expect(stripCommentsAndStrings('let a = /* 42 is not real */ 1\n')).toBe('let a =  1\n');
    const multiline = 'let a = 1 /* line one\nstill a comment, 99\nlast line */ let b = 1\n';
    const stripped = stripCommentsAndStrings(multiline);
    expect(stripped).not.toContain('99');
    expect(stripped.split('\n').length).toBe(multiline.split('\n').length);
  });

  it('removes a nested block comment entirely', () => {
    expect(stripCommentsAndStrings('/* outer 1 /* inner 2 */ still outer 3 */ let x = 1\n')).toBe(
      ' let x = 1\n',
    );
  });

  it('removes the contents of an ordinary string literal, including digits and an escaped quote', () => {
    expect(stripCommentsAndStrings('let s = "Section 7.3 has \\"5\\" bars"\n')).toBe('let s = \n');
  });

  it('removes a triple-quoted string literal while preserving its embedded newlines', () => {
    const source = 'let s = """\n  the year is 1999\n  and so is this 2000\n"""\nlet n = 1\n';
    const stripped = stripCommentsAndStrings(source);
    expect(stripped).not.toContain('1999');
    expect(stripped).not.toContain('2000');
    expect(stripped.split('\n').length).toBe(source.split('\n').length);
    // "let n = 1" must still land on its original line number (5).
    expect(stripped.split('\n')[4]).toBe('let n = 1');
  });

  it('leaves a real numeric literal outside any comment or string untouched', () => {
    expect(stripCommentsAndStrings('let radius = 42\n')).toBe('let radius = 42\n');
  });

  it('does not let a `//` inside a string literal start a false line comment', () => {
    // The string (with its "//") is removed whole, and the real line
    // comment after it is removed too - what survives is the code on either
    // side: "let s = " before the string, one space before the comment.
    expect(stripCommentsAndStrings('let s = "https://5.example" // 7\n')).toBe('let s =  \n');
  });
});

// Section 0 rule and Step F's Definition of Done, read literally: "no
// numeric literal other than 0, 1 and -1". A literal is one optional leading
// `-` and one run of digits, with one optional decimal part, and it must not
// sit directly against a letter, digit or underscore on either side - the
// guard against reading the "256" out of "SHA256" or the "1970" out of
// "timeIntervalSince1970" as if either were a stray constant, which both
// Runtime/HostBridge.swift and Diagnostics/DiagnosticsStore.swift's own
// identifiers would otherwise trip.
const ALLOWED_NUMERIC_LITERALS = new Set(['0', '1', '-1']);
const NUMERIC_LITERAL_PATTERN = /(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g;

interface NumericLiteralViolation {
  file: string;
  line: number;
  literal: string;
  lineText: string;
}

function numericLiteralViolations(filePath: string, source: string): NumericLiteralViolation[] {
  const violations: NumericLiteralViolation[] = [];
  const strippedLines = stripCommentsAndStrings(source).split('\n');
  strippedLines.forEach((strippedLine, index) => {
    for (const match of strippedLine.matchAll(NUMERIC_LITERAL_PATTERN)) {
      if (!ALLOWED_NUMERIC_LITERALS.has(match[0])) {
        violations.push({
          file: filePath,
          line: index + 1,
          literal: match[0],
          lineText: strippedLine.trim(),
        });
      }
    }
  });
  return violations;
}

describe('GUARD 1: no Swift file outside Screens/Metrics.swift carries a numeric literal other than 0, 1, -1', () => {
  const swiftFiles = listSwiftFiles(IOS_APP_ROOT).filter(
    (file) => file !== NUMERIC_LITERAL_EXCLUDED_FILE,
  );

  it('found at least one Swift file to examine, other than the excluded one', () => {
    expect(swiftFiles.length).toBeGreaterThan(0);
  });

  it('carries no numeric literal other than 0, 1 or -1 outside comments and string literals (I1)', () => {
    const allViolations = swiftFiles.flatMap((filePath) =>
      numericLiteralViolations(filePath, readFileSync(filePath, 'utf-8')),
    );

    expect(
      allViolations,
      `ios/SPEC.md I1 and Step F's Definition of Done: every Swift file outside ` +
        `Screens/Metrics.swift may carry only 0, 1 or -1 as a numeric literal. Found:\n` +
        allViolations
          .map(
            (violation) =>
              `  ${violation.file}:${violation.line} — literal "${violation.literal}" in: ${violation.lineText}`,
          )
          .join('\n'),
    ).toEqual([]);
  });
});

// GUARD 2: the Host bridge's method names (ios/SPEC.md 7.2, Step F's
// Definition of Done's third item). host.ts is parsed as text rather than
// imported - packages/tracker does not declare `typescript` as a dependency,
// and adding it would rewrite pnpm-lock.yaml, which ios/SPEC.md I7 puts out
// of reach for this branch.
function hostInterfaceMemberNames(hostTsSource: string): string[] {
  const interfaceMatch = /interface Host \{([\s\S]*?)\n\}/.exec(hostTsSource);
  if (!interfaceMatch) return [];
  const body = stripCommentsAndStrings(interfaceMatch[1]);
  const names: string[] = [];
  for (const line of body.split('\n')) {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

// Runtime/HostBridge.swift's own comment: every member of `Host` is
// installed as `host.setObject(someBlock, forKeyedSubscript: "name" as
// NSString)` - the one shape that file uses for this, and (by that file's
// own comment) the only place in the app that writes one of these ten names
// as a string. `context.setObject(host, forKeyedSubscript:
// "__tipsyTrailsHost" as NSString)` is a different receiver (`context`, not
// `host`) and is deliberately not matched by this pattern.
//
// Read from the RAW source, deliberately not run through
// stripCommentsAndStrings above: the key name this pattern greps for is
// itself a string literal, and that function's whole job is to erase string
// literals, which would erase the very key this is looking for. Read by
// hand once (this file's own header) that no comment or other string in
// Runtime/HostBridge.swift happens to contain this exact shape - a
// `host.setObject` call followed by `forKeyedSubscript:` and a quoted name -
// so grepping the raw text is safe here.
const HOST_INSTALL_PATTERN =
  /host\.setObject\(\s*[\w]+,\s*forKeyedSubscript:\s*"([^"]+)"\s*as\s*NSString\)/g;

function hostBridgeInstalledNames(hostBridgeSwiftSource: string): string[] {
  const names: string[] = [];
  for (const match of hostBridgeSwiftSource.matchAll(HOST_INSTALL_PATTERN)) {
    names.push(match[1]);
  }
  return names;
}

describe('GUARD 2: Runtime/HostBridge.swift installs every Host member and no other', () => {
  const hostTsSource = readFileSync(HOST_TS_PATH, 'utf-8');
  const hostBridgeSwiftSource = readFileSync(HOST_BRIDGE_SWIFT_PATH, 'utf-8');

  const hostMembers = hostInterfaceMemberNames(hostTsSource);
  const swiftInstalls = hostBridgeInstalledNames(hostBridgeSwiftSource);

  it('parsed a non-empty Host interface from host.ts', () => {
    expect(hostMembers.length).toBeGreaterThan(0);
  });

  it('found at least one installed member in HostBridge.swift', () => {
    expect(swiftInstalls.length).toBeGreaterThan(0);
  });

  it('installs exactly the members host.ts declares, no fewer and no more', () => {
    const hostMemberSet = new Set(hostMembers);
    const swiftInstallSet = new Set(swiftInstalls);

    // In host.ts but never installed by the Swift: a call the tracker can
    // make that is `undefined` on a real phone, and crashes there.
    const missingFromSwift = hostMembers.filter((name) => !swiftInstallSet.has(name));
    // Installed by the Swift but not declared on Host: dead code, or a typo
    // of a real member - the same crash wearing a disguise.
    const extraInSwift = swiftInstalls.filter((name) => !hostMemberSet.has(name));

    expect(
      missingFromSwift,
      `host.ts declares these Host members but Runtime/HostBridge.swift never installs them - ` +
        `calling one of these from the tracker is undefined at runtime on a real phone: ` +
        `${missingFromSwift.join(', ')}`,
    ).toEqual([]);
    expect(
      extraInSwift,
      `Runtime/HostBridge.swift installs these names onto the host object but host.ts's Host ` +
        `interface declares no such member - dead code or a typo of a real one: ` +
        `${extraInSwift.join(', ')}`,
    ).toEqual([]);
  });
});
