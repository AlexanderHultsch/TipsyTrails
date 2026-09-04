import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Three levels up from this file's own directory (packages/api/src) to the
// repository root — the same style docker-image.test.ts uses to reach the root
// `Dockerfile`, and the reason this file lives in the api package's suite
// rather than shared's or web's: root-level infrastructure files are already
// asserted on from here.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf-8');
const caddyfile = readFileSync(join(REPO_ROOT, 'caddy/Caddyfile'), 'utf-8');

// What this file defends, in one sentence: a `{$VAR}` the Caddyfile reads is
// resolved by Caddy inside the caddy container, so anything docker-compose.yml
// does not put in that container's environment silently becomes the Caddyfile's
// own fallback instead.
//
// That is not hypothetical. `reverse_proxy api:{$API_PORT:3000}` shipped for
// months against a caddy service with no environment at all, so the fallback
// was the only value it ever used: setting API_PORT to anything but 3000 left
// the API listening on one port and Caddy proxying to another, every /api/*
// request answering 502, the api service still reporting healthy (its
// healthcheck did read the variable), and no log line anywhere naming the
// cause. The assertion below is deliberately about *every* variable the
// Caddyfile references rather than about API_PORT, because the next variable
// added to that file fails in exactly the same silent way.
//
// Only an `environment:` key counts as supplying one. `env_file:` is not
// accepted, and that is a choice rather than a limitation of the parser: the
// file it names is `.env`, which is gitignored and optional, so no test can see
// whether the variable is in it — and when it is not, the failure is precisely
// the silent fallback above. Naming the variable in the compose file is what
// makes the wiring reviewable.

// docker-compose.yml is parsed by indentation rather than with a YAML library,
// because there is no YAML parser in this repository's dependencies and adding
// one to assert on a twelve-line service block would be the larger change. The
// file is flat, two-space indented and has no multi-line scalars or flow
// mappings, so an indentation scan reads it honestly; the one YAML feature it
// does use, an anchor and its aliases, is resolved explicitly below. If that
// stops being true — a folded block scalar, a quoted key containing a colon —
// this parser has to be replaced rather than patched.
function contentLines(source: string): { indent: number; text: string }[] {
  return source
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
}

const COMPOSE_LINES = contentLines(compose);

// Every line strictly more indented than the line whose key matches `key` at
// `indent`, stopping at the first line indented at or below it.
function childLines(
  lines: { indent: number; text: string }[],
  key: string,
  indent: number,
): { indent: number; text: string }[] {
  const start = lines.findIndex(
    (line) => line.indent === indent && line.text.startsWith(`${key}:`),
  );
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.indent <= indent);
  return end === -1 ? rest : rest.slice(0, end);
}

const SERVICE_LINES = childLines(COMPOSE_LINES, 'services', 0);
const SERVICE_INDENT = SERVICE_LINES[0]?.indent ?? 2;

const serviceNames = SERVICE_LINES.filter((line) => line.indent === SERVICE_INDENT).map((line) =>
  line.text.replace(/:.*$/, ''),
);

// `*name` resolved against the `&name value` that defines it. The compose file
// declares the API's port once, in a top-level `x-api-port` extension field,
// and both services alias it; comparing the two aliases without resolving them
// would also pass if one were inlined and the other anchored, which is a
// refactor rather than a defect.
function resolveAlias(value: string): string {
  const alias = /^\*([A-Za-z0-9_-]+)$/.exec(value);
  if (!alias) return unquote(value);
  const definition = new RegExp(`&${alias[1]}\\s+(\\S.*?)\\s*$`, 'm').exec(compose);
  return definition ? unquote(definition[1]) : value;
}

function unquote(value: string): string {
  return value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

// The `environment:` block of one service, as name → value text. Both YAML
// shapes are read: the mapping form this file uses (`NAME: value`) and the list
// form (`- NAME=value`) that is equally valid Compose.
function environmentOf(service: string): Map<string, string> {
  const serviceBody = childLines(SERVICE_LINES, service, SERVICE_INDENT);
  const serviceKeyIndent = serviceBody[0]?.indent ?? SERVICE_INDENT + 2;
  const entries = new Map<string, string>();
  for (const line of childLines(serviceBody, 'environment', serviceKeyIndent)) {
    const mapping = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.text);
    const listItem = /^-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.text);
    const match = mapping ?? listItem;
    if (match) entries.set(match[1], resolveAlias(match[2].trim()));
  }
  return entries;
}

// `{$NAME}` and `{$NAME:default}` — Caddy's own environment substitution,
// resolved when Caddy loads the config inside its container.
const CADDY_ENV_REFERENCE = /\{\$([A-Za-z_][A-Za-z0-9_]*)/g;
const caddyReferences = [...new Set([...caddyfile.matchAll(CADDY_ENV_REFERENCE)].map((m) => m[1]))];

describe('the Caddyfile and the caddy service (standalone compose path)', () => {
  // A guard on the two parsers rather than on the files: if either stopped
  // matching, every assertion below would pass vacuously — which is how a test
  // that reads a file instead of importing one usually fails.
  it('parses at least one service and at least one referenced variable', () => {
    expect(serviceNames).toContain('caddy');
    expect(serviceNames).toContain('api');
    expect(caddyReferences.length).toBeGreaterThan(0);
  });

  it('has every variable the Caddyfile references in the caddy service environment', () => {
    const supplied = environmentOf('caddy');
    const missing = caddyReferences.filter((name) => !supplied.get(name));
    expect(
      missing,
      'caddy/Caddyfile reads these variables and docker-compose.yml does not give them to the ' +
        'caddy service, so Caddy will silently use the fallback written into the Caddyfile ' +
        'instead of the configured value: ' +
        missing.join(', '),
    ).toEqual([]);
  });

  it('gives the api service the same value for any variable both services set', () => {
    const caddyEnvironment = environmentOf('caddy');
    const apiEnvironment = environmentOf('api');
    for (const [name, value] of caddyEnvironment) {
      const apiValue = apiEnvironment.get(name);
      if (apiValue === undefined) continue;
      expect(
        apiValue,
        `${name} is set for both services and the two disagree — the whole point of setting it ` +
          'on the caddy service is that Caddy and the API agree about it',
      ).toBe(value);
    }
  });
});

// The upstream the reverse proxy points at, taken from the Caddyfile rather
// than written down here: `reverse_proxy <service>:{$VAR...}`. Renaming either
// the service or the variable therefore keeps this honest instead of quietly
// pinning a name that no longer exists.
describe("the reverse proxy's upstream", () => {
  const upstream = /reverse_proxy\s+([A-Za-z0-9_-]+):\{\$([A-Za-z_][A-Za-z0-9_]*)/.exec(caddyfile);

  it('names a service docker-compose.yml defines', () => {
    expect(upstream, 'caddy/Caddyfile has no `reverse_proxy <host>:{$VAR}` line').not.toBeNull();
    expect(serviceNames).toContain(upstream?.[1]);
  });

  it('takes its port from a variable both the api and the caddy service are given', () => {
    const variable = upstream?.[2] ?? '';
    // The invariant the 502 came from: the port the API listens on and the
    // port Caddy proxies to are one value, not two that happen to match.
    expect(environmentOf('api').get(variable)).toBeTruthy();
    expect(environmentOf('caddy').get(variable)).toBe(environmentOf('api').get(variable));
  });
});
