import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { loadDistrictIdByGridIndex } from '../fog/district-index.js';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import { loadGridMeta, seedCity } from './seed-city.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// The real committed data/cities and data/seed trees, four levels up from
// this file's own directory to the repository root — the same style
// routes/static-data.test.ts uses to reach data/seed.
const REAL_DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const REAL_SEED_DIR = join(REAL_DATA_DIR, 'seed');
const REAL_CITIES_DIR = join(REAL_DATA_DIR, 'cities');
const REAL_GRID_META = JSON.parse(
  readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'grid-meta.json'), 'utf-8'),
) as {
  grid_width: number;
  grid_height: number;
  playable_cells: number;
  districts: { name: string; index: number; playable_cells: number }[];
};
const REAL_CITY_CONFIG = JSON.parse(
  readFileSync(join(REAL_CITIES_DIR, 'karlsruhe.json'), 'utf-8'),
) as { name: string; cell_size_m: number; bounding_box: { south: number; west: number } };

const baseEnv = {
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/data/tipsytrails.db',
  SESSION_SECRET: '01234567890123456789012345678901',
};

interface CityRow {
  id: number;
  slug: string;
  name: string;
  origin_lat: number;
  origin_lon: number;
  grid_width: number;
  grid_height: number;
  cell_size_m: number;
  playable_cells: number;
  is_active: number;
}

interface DistrictRow {
  id: number;
  city_id: number;
  name: string;
  playable_cells: number;
}

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-seed-city-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
});

function cityRow(): CityRow | undefined {
  return db.prepare<[string], CityRow>('SELECT * FROM cities WHERE slug = ?').get('karlsruhe');
}

function districtRows(): DistrictRow[] {
  return db.prepare<[], DistrictRow>('SELECT * FROM districts ORDER BY id').all();
}

describe('seedCity with the real committed data', () => {
  it('creates one city row and 27 district rows matching grid-meta.json', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: REAL_SEED_DIR });

    seedCity(db, env);

    const city = cityRow();
    expect(city).toBeDefined();
    expect(city).toMatchObject({
      slug: 'karlsruhe',
      name: REAL_CITY_CONFIG.name,
      origin_lat: REAL_CITY_CONFIG.bounding_box.south,
      origin_lon: REAL_CITY_CONFIG.bounding_box.west,
      grid_width: REAL_GRID_META.grid_width,
      grid_height: REAL_GRID_META.grid_height,
      cell_size_m: REAL_CITY_CONFIG.cell_size_m,
      playable_cells: REAL_GRID_META.playable_cells,
      is_active: 1,
    });

    const districts = districtRows();
    expect(districts).toHaveLength(27);
    expect(REAL_GRID_META.districts).toHaveLength(27);

    const byName = new Map(districts.map((d) => [d.name, d]));
    for (const expected of REAL_GRID_META.districts) {
      expect(byName.get(expected.name)?.playable_cells).toBe(expected.playable_cells);
      expect(byName.get(expected.name)?.city_id).toBe(city?.id);
    }
  });

  it('is idempotent: a second boot creates no duplicate rows', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: REAL_SEED_DIR });

    seedCity(db, env);
    seedCity(db, env);

    const citiesCount = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM cities')
      .get();
    expect(citiesCount?.count).toBe(1);
    expect(districtRows()).toHaveLength(27);
  });
});

describe('seedCity against a modifiable copy of the seed tree', () => {
  let tempRoot: string;
  let tempSeedDir: string;
  let gridMetaPath: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `tipsytrails-seed-city-fixture-${randomUUID()}`);
    cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
    cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
      recursive: true,
    });
    tempSeedDir = join(tempRoot, 'seed');
    gridMetaPath = join(tempSeedDir, 'karlsruhe', 'grid-meta.json');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('updates playable_cells on a second boot while keeping district ids stable', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });

    seedCity(db, env);
    const before = districtRows();
    const beforeCity = cityRow();

    const meta = JSON.parse(readFileSync(gridMetaPath, 'utf-8')) as typeof REAL_GRID_META;
    const target = meta.districts[0];
    const changedPlayableCells = target.playable_cells + 1000;
    target.playable_cells = changedPlayableCells;
    meta.playable_cells += 1000;
    writeFileSync(gridMetaPath, JSON.stringify(meta, null, 2));

    seedCity(db, env);
    const after = districtRows();
    const afterCity = cityRow();

    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    expect(afterCity?.id).toBe(beforeCity?.id);

    const changedRow = after.find((d) => d.name === target.name);
    expect(changedRow?.playable_cells).toBe(changedPlayableCells);
    expect(afterCity?.playable_cells).toBe(meta.playable_cells);

    const unchangedRow = after.find((d) => d.name === meta.districts[1].name);
    expect(unchangedRow?.playable_cells).toBe(meta.districts[1].playable_cells);
  });

  it('throws and does not touch the database when a previously seeded district is missing from grid-meta.json', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });

    seedCity(db, env);
    const before = districtRows();

    const meta = JSON.parse(readFileSync(gridMetaPath, 'utf-8')) as typeof REAL_GRID_META;
    const removed = meta.districts.shift();
    meta.playable_cells -= removed?.playable_cells ?? 0;
    writeFileSync(gridMetaPath, JSON.stringify(meta, null, 2));

    expect(() => seedCity(db, env)).toThrow(new RegExp(removed?.name ?? ''));

    expect(districtRows()).toEqual(before);
  });
});

// Review block R2 (boundaries). `grid-meta.json` is regenerated by the
// operator (`scripts/build-grid.ts`) and read by two modules; the second of
// them, `fog/district-index.ts`, used to cast the parse result instead of
// validating it and answered a wrongly regenerated file with `undefined is
// not iterable` at boot. Both readers now go through `loadGridMeta`, so both
// suites below are exercising one check — and the message it produces has to
// name the file, because the operator's next move is to regenerate that file.
describe('loadGridMeta rejects a grid-meta.json that is present but wrong', () => {
  let tempRoot: string;
  let tempSeedDir: string;
  let gridMetaPath: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `tipsytrails-grid-meta-${randomUUID()}`);
    cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
    cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
      recursive: true,
    });
    tempSeedDir = join(tempRoot, 'seed');
    gridMetaPath = join(tempSeedDir, 'karlsruhe', 'grid-meta.json');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('names the file when the JSON itself does not parse', () => {
    writeFileSync(gridMetaPath, '{ "districts": [');
    expect(() => loadGridMeta(tempSeedDir, 'karlsruhe')).toThrow(
      /grid-meta\.json is not valid JSON/,
    );
  });

  it.each([
    ['there is no districts array at all', { ...REAL_GRID_META, districts: undefined }],
    ['districts is an object rather than an array', { ...REAL_GRID_META, districts: {} }],
    ['a district has no name', { ...REAL_GRID_META, districts: [{ index: 0, playable_cells: 1 }] }],
    [
      'a district index is fractional',
      { ...REAL_GRID_META, districts: [{ name: 'A', index: 0.5, playable_cells: 1 }] },
    ],
    ['grid_width is zero', { ...REAL_GRID_META, grid_width: 0 }],
    ['the payload is a bare array', []],
  ])('names the file and the offending field when %s', (_label, meta) => {
    writeFileSync(gridMetaPath, JSON.stringify(meta));
    expect(() => loadGridMeta(tempSeedDir, 'karlsruhe')).toThrow(
      /grid-meta\.json is not a valid grid-meta\.json \(.+\)/,
    );
  });

  it('reaches loadDistrictIdByGridIndex too, which used to cast instead', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
    seedCity(db, env);

    // Written after seeding on purpose: the districts table is fully
    // populated, so nothing but the file itself can be what fails here.
    writeFileSync(gridMetaPath, JSON.stringify({ ...REAL_GRID_META, districts: undefined }));
    expect(() => loadDistrictIdByGridIndex(db, tempSeedDir, 'karlsruhe')).toThrow(
      /grid-meta\.json is not a valid grid-meta\.json/,
    );
  });

  // The absent-file case is deliberately NOT an error: it is one feature's
  // data going missing, the same way app.ts treats a missing grid.bin.
  it('still answers null, not an error, when the file is simply absent', () => {
    rmSync(gridMetaPath);
    expect(loadDistrictIdByGridIndex(db, tempSeedDir, 'karlsruhe')).toBeNull();
  });

  it('still accepts the real committed grid-meta.json unchanged', () => {
    expect(loadGridMeta(REAL_SEED_DIR, 'karlsruhe').districts).toHaveLength(
      REAL_GRID_META.districts.length,
    );
  });
});
