import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCell, type GridParams } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import { seedBars } from './seed-bars.js';
import { seedCity } from './seed-city.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// Same real committed trees seed-city.test.ts reaches, four levels up from
// this file's own directory to the repository root.
const REAL_DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const REAL_SEED_DIR = join(REAL_DATA_DIR, 'seed');
const REAL_CITIES_DIR = join(REAL_DATA_DIR, 'cities');

const REAL_CITY_CONFIG = JSON.parse(
  readFileSync(join(REAL_CITIES_DIR, 'karlsruhe.json'), 'utf-8'),
) as { cell_size_m: number; bounding_box: { south: number; west: number } };
const REAL_GRID_META = JSON.parse(
  readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'grid-meta.json'), 'utf-8'),
) as { grid_width: number; grid_height: number };

const GRID_PARAMS: GridParams = {
  origin_lat: REAL_CITY_CONFIG.bounding_box.south,
  origin_lon: REAL_CITY_CONFIG.bounding_box.west,
  grid_width: REAL_GRID_META.grid_width,
  grid_height: REAL_GRID_META.grid_height,
  cell_size_m: REAL_CITY_CONFIG.cell_size_m,
};

// Karlsruhe Schloss (SPEC.md's own worked example city, also used by
// routes/fog.test.ts): well inside the bounding box, in a single district.
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };
const SCHLOSS_CELL_INDEX = toCell(SCHLOSS.lat, SCHLOSS.lon, GRID_PARAMS);
if (SCHLOSS_CELL_INDEX === null) {
  throw new Error('SCHLOSS is expected to fall inside the committed Karlsruhe grid');
}

const baseEnv = {
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/data/tipsytrails.db',
  SESSION_SECRET: '01234567890123456789012345678901',
};

interface BarRow {
  id: number;
  city_id: number;
  district_id: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  cell_index: number;
  source: string;
  osm_id: string | null;
  status: string;
}

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-seed-bars-test-${randomUUID()}.db`);
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

function barRows(): BarRow[] {
  return db.prepare<[], BarRow>('SELECT * FROM bars ORDER BY id').all();
}

describe('seedBars against the real committed grid with a synthetic bars.json fixture', () => {
  let tempRoot: string;
  let tempSeedDir: string;
  let barsPath: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `tipsytrails-seed-bars-fixture-${randomUUID()}`);
    cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
    cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
      recursive: true,
    });
    tempSeedDir = join(tempRoot, 'seed');
    barsPath = join(tempSeedDir, 'karlsruhe', 'bars.json');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeFixture(): void {
    writeFileSync(
      barsPath,
      JSON.stringify([
        {
          osm_id: 'node/1',
          name: 'Zum Schlossgarten',
          address: 'Schlossplatz 1, 76131 Karlsruhe',
          lat: SCHLOSS.lat,
          lon: SCHLOSS.lon,
          cell_index: SCHLOSS_CELL_INDEX,
          source: 'osm',
        },
      ]),
    );
  }

  it('imports the fixture, setting district_id from the grid loaded at boot', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
    seedCity(db, env);
    writeFixture();

    seedBars(db, env);

    const bars = barRows();
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      name: 'Zum Schlossgarten',
      address: 'Schlossplatz 1, 76131 Karlsruhe',
      cell_index: SCHLOSS_CELL_INDEX,
      source: 'osm',
      osm_id: 'node/1',
      status: 'active',
    });
    expect(bars[0].district_id).not.toBeNull();

    const district = db
      .prepare<[number], { id: number }>('SELECT id FROM districts WHERE id = ?')
      .get(bars[0].district_id as number);
    expect(district).toBeDefined();
  });

  it('is idempotent: a second boot changes nothing', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
    seedCity(db, env);
    writeFixture();

    seedBars(db, env);
    const before = barRows();

    seedBars(db, env);
    const after = barRows();

    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it('updates an existing bar in place by osm_id, keeping its id stable', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
    seedCity(db, env);
    writeFixture();
    seedBars(db, env);
    const idBefore = barRows()[0].id;

    writeFileSync(
      barsPath,
      JSON.stringify([
        {
          osm_id: 'node/1',
          name: 'Zum Schlossgarten (renamed)',
          address: null,
          lat: SCHLOSS.lat,
          lon: SCHLOSS.lon,
          cell_index: SCHLOSS_CELL_INDEX,
          source: 'osm',
        },
      ]),
    );
    seedBars(db, env);

    const bars = barRows();
    expect(bars).toHaveLength(1);
    expect(bars[0].id).toBe(idBefore);
    expect(bars[0].name).toBe('Zum Schlossgarten (renamed)');
    expect(bars[0].address).toBeNull();
  });
});

describe('seedBars against the committed data/seed/karlsruhe/bars.json', () => {
  it('imports every row with a resolved district_id, cell_index and city_id', () => {
    const env = loadEnv({ ...baseEnv, SEED_DIR: REAL_SEED_DIR });
    seedCity(db, env);

    expect(() => seedBars(db, env)).not.toThrow();

    const committedBars = JSON.parse(
      readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'bars.json'), 'utf-8'),
    ) as unknown[];
    const bars = barRows();
    expect(bars).toHaveLength(committedBars.length);

    const city = db
      .prepare<[string], { id: number }>('SELECT id FROM cities WHERE slug = ?')
      .get('karlsruhe');
    expect(city).toBeDefined();

    for (const bar of bars) {
      expect(bar.district_id).not.toBeNull();
      expect(bar.cell_index).not.toBeNull();
      expect(bar.city_id).toBe(city!.id);
    }
  });
});

describe('seedBars with no bars.json present', () => {
  it('logs and leaves the database working instead of failing the boot', () => {
    const tempRoot = join(tmpdir(), `tipsytrails-seed-bars-nobars-${randomUUID()}`);
    try {
      mkdirSync(join(tempRoot, 'cities'), { recursive: true });
      cpSync(join(REAL_CITIES_DIR, 'karlsruhe.json'), join(tempRoot, 'cities', 'karlsruhe.json'));
      mkdirSync(join(tempRoot, 'seed', 'karlsruhe'), { recursive: true });
      cpSync(
        join(REAL_SEED_DIR, 'karlsruhe', 'grid-meta.json'),
        join(tempRoot, 'seed', 'karlsruhe', 'grid-meta.json'),
      );
      cpSync(
        join(REAL_SEED_DIR, 'karlsruhe', 'grid.bin'),
        join(tempRoot, 'seed', 'karlsruhe', 'grid.bin'),
      );

      const env = loadEnv({ ...baseEnv, SEED_DIR: join(tempRoot, 'seed') });
      seedCity(db, env);

      expect(() => seedBars(db, env)).not.toThrow();
      expect(barRows()).toHaveLength(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('leaves district_id NULL when the grid is unavailable', () => {
    const tempRoot = join(tmpdir(), `tipsytrails-seed-bars-nogrid-${randomUUID()}`);
    try {
      mkdirSync(join(tempRoot, 'cities'), { recursive: true });
      cpSync(join(REAL_CITIES_DIR, 'karlsruhe.json'), join(tempRoot, 'cities', 'karlsruhe.json'));
      mkdirSync(join(tempRoot, 'seed', 'karlsruhe'), { recursive: true });
      writeFileSync(
        join(tempRoot, 'seed', 'karlsruhe', 'grid-meta.json'),
        JSON.stringify({
          grid_width: REAL_GRID_META.grid_width,
          grid_height: REAL_GRID_META.grid_height,
          playable_cells: 0,
          districts: [],
        }),
      );
      writeFileSync(
        join(tempRoot, 'seed', 'karlsruhe', 'bars.json'),
        JSON.stringify([
          {
            osm_id: 'node/2',
            name: 'No Grid Bar',
            address: null,
            lat: SCHLOSS.lat,
            lon: SCHLOSS.lon,
            cell_index: SCHLOSS_CELL_INDEX,
            source: 'osm',
          },
        ]),
      );

      const env = loadEnv({ ...baseEnv, SEED_DIR: join(tempRoot, 'seed') });
      seedCity(db, env);

      seedBars(db, env);

      const bars = barRows();
      expect(bars).toHaveLength(1);
      expect(bars[0].district_id).toBeNull();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
