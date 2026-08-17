import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));

// Holds the write lock on a not-yet-WAL database for roughly 300 ms. It has to
// be a real child process: the retry loop blocks the event loop, so nothing
// in-process could ever release the lock again.
const lockHolderScript = `
  const Database = require('better-sqlite3');
  const db = new Database(process.env.LOCK_DB_PATH);
  db.exec('CREATE TABLE IF NOT EXISTS t (x)');
  db.exec('BEGIN IMMEDIATE');
  console.log('locked');
  setTimeout(() => {
    db.exec('ROLLBACK');
    db.close();
  }, 300);
`;

let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-open-db-test-${randomUUID()}.db`);
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
});

describe('openDatabase', () => {
  it('enables WAL and foreign keys on a fresh database', () => {
    const db = openDatabase(dbPath);

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    db.close();
  });

  it('waits for a concurrent writer instead of failing the journal-mode change', async () => {
    const child = spawn(process.execPath, ['-e', lockHolderScript], {
      cwd: apiRoot,
      env: { ...process.env, LOCK_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (chunk.includes('locked')) {
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => reject(new Error('lock holder exited before it took the lock')));
    });

    const startedAt = Date.now();
    const db = openDatabase(dbPath);
    const elapsedMs = Date.now() - startedAt;

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(elapsedMs).toBeGreaterThanOrEqual(100);

    db.close();

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.on('exit', () => resolve());
    });
  }, 15000);
});
