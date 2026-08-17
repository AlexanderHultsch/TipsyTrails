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
