import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Three levels up from this file's own directory (packages/api/src) to the
// repository root — the same style seed-city.test.ts and startup.test.ts
// use to reach data/seed and data/cities.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf-8');
const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));

// The data directories the API reads at boot from a path resolved relative
// to its compiled module rather than an env var with an absolute default
// (unlike TILES_DIR): `data/seed` (routes/static-data.ts, read by grid.bin
// loading and district seeding) and `data/cities` (db/seed-city.ts). Both
// crash the boot with an uncaught ENOENT if the runtime image does not
// contain them — see the Dockerfile's runtime-stage comment. This list is
// the thing to extend the next time a startup path reads a new one.
const RUNTIME_DATA_DIRS = ['data/seed', 'data/cities'];

describe('runtime image contents', () => {
  it.each(RUNTIME_DATA_DIRS)(
    '%s exists in the repository at the path the Dockerfile copies it from',
    (dir) => {
      expect(existsSync(join(REPO_ROOT, dir))).toBe(true);
    },
  );

  it.each(RUNTIME_DATA_DIRS)(
    'the Dockerfile runtime stage COPYs %s to the same relative path',
    (dir) => {
      const copyPattern = new RegExp(`COPY\\s+(--\\S+\\s+)*${dir}\\s+\\./${dir}\\b`);
      expect(runtimeStage).toMatch(copyPattern);
    },
  );
});

// @tipsytrails/web and @tipsytrails/api both resolve @tipsytrails/shared
// through its `main`/`exports`, which point at shared's gitignored `dist/`.
// The build stage's `pnpm install --ignore-scripts` (see the comment above
// that RUN line) deliberately skips the root `prepare` hook that would
// otherwise build shared, so the build stage's own RUN lines are the only
// thing that can produce that `dist/` before web or api need it. Building
// web or api before shared once broke the image while every other test
// stayed green — see the Dockerfile's build-stage RUN lines.
describe('build stage ordering', () => {
  const buildStage = dockerfile.slice(
    dockerfile.indexOf('AS build'),
    dockerfile.indexOf('AS runtime'),
  );
  const sharedBuildIndex = buildStage.indexOf('RUN pnpm --filter @tipsytrails/shared build');
  const webBuildIndex = buildStage.indexOf('RUN pnpm --filter @tipsytrails/web build');
  const apiBuildIndex = buildStage.indexOf('RUN pnpm --filter @tipsytrails/api build');

  it('builds @tipsytrails/shared before @tipsytrails/web', () => {
    expect(sharedBuildIndex).toBeGreaterThan(-1);
    expect(webBuildIndex).toBeGreaterThan(-1);
    expect(sharedBuildIndex).toBeLessThan(webBuildIndex);
  });

  it('builds @tipsytrails/shared before @tipsytrails/api', () => {
    expect(apiBuildIndex).toBeGreaterThan(-1);
    expect(sharedBuildIndex).toBeLessThan(apiBuildIndex);
  });
});

// SPEC.md Section 4.3: the platform creates the /data bind mount as root, so
// the container starts as root, chowns the volume and drops to `node` itself.
// The four things below are what makes that work, and each of them is a
// one-line edit away from silently undoing it: a reintroduced `USER node`
// takes the chown away, a missing COPY/chmod/ENTRYPOINT means the entrypoint
// never runs (leaving the server as root), and without gosu the entrypoint's
// last line fails and nothing starts at all.
describe('root-owned bind mount (SPEC.md Section 4.3)', () => {
  it('docker-entrypoint.sh exists in the repository at the path the Dockerfile copies it from', () => {
    expect(existsSync(join(REPO_ROOT, 'docker-entrypoint.sh'))).toBe(true);
  });

  it('the Dockerfile runtime stage does not set `USER node` — the entrypoint owns the drop', () => {
    expect(runtimeStage).not.toMatch(/^\s*USER\s+node\b/m);
  });

  it('the Dockerfile runtime stage installs gosu', () => {
    expect(runtimeStage).toMatch(/apt-get\s+install\s+[^\n]*\bgosu\b/);
  });

  it('the Dockerfile runtime stage COPYs the entrypoint to /usr/local/bin and chmods it', () => {
    expect(runtimeStage).toMatch(
      /COPY\s+(--\S+\s+)*docker-entrypoint\.sh\s+\/usr\/local\/bin\/docker-entrypoint\.sh\b/,
    );
    expect(runtimeStage).toMatch(/RUN\s+chmod\s+\+x\s+\/usr\/local\/bin\/docker-entrypoint\.sh\b/);
  });

  it('the Dockerfile runtime stage sets the entrypoint, leaving the server as the CMD', () => {
    expect(runtimeStage).toMatch(/ENTRYPOINT\s+\["\/usr\/local\/bin\/docker-entrypoint\.sh"\]/);
    expect(runtimeStage).toMatch(/CMD\s+\["node",\s*"dist\/server\.js"\]/);
  });

  it('the entrypoint execs the CMD as node via gosu', () => {
    const entrypoint = readFileSync(join(REPO_ROOT, 'docker-entrypoint.sh'), 'utf-8');
    expect(entrypoint).toMatch(/^exec gosu node "\$@"$/m);
  });
});

// SPEC.md Section 4.3: `docker compose exec tipsy-trails npm run seed:admin`
// must resolve from the container's working directory. The runtime stage is
// a `pnpm deploy` output, not the source tree, so `npm run` has nothing to
// read unless package.json itself is copied in — nothing else in this
// stage provides one.
describe('npm run seed:admin (SPEC.md Section 4.3)', () => {
  const apiPackageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/api/package.json'), 'utf-8'),
  ) as { scripts: Record<string, string> };

  it('the Dockerfile runtime stage COPYs package.json to the working directory', () => {
    expect(runtimeStage).toMatch(
      /COPY\s+(--\S+\s+)*\/app\/packages\/api\/package\.json\s+\.\/package\.json\b/,
    );
  });

  it('packages/api/package.json defines a seed:admin script targeting the compiled dist output', () => {
    expect(apiPackageJson.scripts['seed:admin']).toBe('node dist/db/seed-admin-cli.js');
  });

  it('the seed:admin script path matches where tsconfig.build.json actually emits it', () => {
    const buildConfig = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/api/tsconfig.build.json'), 'utf-8'),
    ) as { compilerOptions: { outDir: string; rootDir: string } };
    expect(
      existsSync(
        join(
          REPO_ROOT,
          'packages/api',
          buildConfig.compilerOptions.rootDir,
          'db/seed-admin-cli.ts',
        ),
      ),
    ).toBe(true);
    expect(apiPackageJson.scripts['seed:admin']).toBe(
      `node ${buildConfig.compilerOptions.outDir}/db/seed-admin-cli.js`,
    );
  });
});
