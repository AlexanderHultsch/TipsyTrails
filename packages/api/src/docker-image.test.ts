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
