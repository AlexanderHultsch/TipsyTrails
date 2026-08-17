// Stub for the cell_size_m grid rebuild (SPEC.md Section 6.2, Section 14
// Open Item O3). Not implemented — this script validates its arguments and
// the city config the same way the other pipeline scripts do, then refuses
// to run.
//
// Why it refuses rather than doing part of the job: changing a city's
// cell_size_m does not just mean re-running scripts/build-grid.ts. Every
// existing fog_state.mask is a bitmask indexed by the *old* grid's width,
// height and cell numbering (SPEC.md Section 5.5); a new grid.bin and
// grid-meta.json alone leave every live player's revealed area meaningless
// against the new grid. A real implementation would need to:
//
//   1. Run the equivalent of scripts/build-grid.ts against the new
//      cell_size_m to produce a new grid.bin and grid-meta.json.
//   2. For every existing fog_state row, decode the old mask, project each
//      set bit's cell centre back to (lat, lon) via the old grid parameters
//      (Section 6.1), then re-encode the result as set bits in the new
//      grid — lossy when cells get coarser, and leaving some new cells only
//      partially covered when they get finer, either of which is a product
//      decision, not just an algorithm.
//   3. Recompute fog_district_progress and fog_daily_progress consistently
//      with the migrated mask, and write the new mask alongside them in one
//      transaction, the same way an ordinary reveal does (Section 7.3).
//   4. Do all of this atomically against a live database — a partial
//      migration would leave players with corrupted or lost progress, which
//      is worse than the feature not existing yet.
//
// That migration is real, per-user database work (O3), not something to
// half-build behind a flag. Until it exists, this script's only job is to
// fail loudly and say so, rather than silently doing nothing.
//
// Usage:
//   node scripts/rebuild-grid.ts --city=karlsruhe
//
// Always exits with an error. There is no --dry-run: a dry run previews
// work this script does not do.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCityConfig, type CityConfig } from '../packages/shared/src/city.ts';

interface CliArgs {
  city: string;
}

function parseArgs(argv: string[]): CliArgs {
  let city: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--city=')) {
      city = arg.slice('--city='.length);
    } else {
      throw new Error(`Unrecognised argument "${arg}". Expected --city=<slug>.`);
    }
  }

  if (!city) {
    throw new Error('Missing required --city=<slug> argument.');
  }

  return { city };
}

function loadCityConfig(repoRoot: string, slug: string): CityConfig {
  const configPath = join(repoRoot, 'data', 'cities', `${slug}.json`);
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `No city config found at "${configPath}". Expected data/cities/${slug}.json — check the --city ` +
        `slug and that the file exists.`,
      { cause: err },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `"${configPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return parseCityConfig(json);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const config = loadCityConfig(repoRoot, args.city);

  throw new Error(
    `Rebuilding "${config.name}" (current cell_size_m: ${config.cell_size_m}) at a new ` +
      'cell_size_m is not implemented: it requires migrating every existing fog_state.mask to ' +
      'the new grid, and this stub refuses to do half that job. See SPEC.md Section 14, Open ' +
      'Item O3.',
  );
}

main().catch((err: unknown) => {
  console.error(`rebuild-grid: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
