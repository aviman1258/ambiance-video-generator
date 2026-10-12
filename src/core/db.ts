import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Each entry runs once, in order. Append new migrations; never edit old ones.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE image_batches (
    id                  INTEGER PRIMARY KEY,
    scene_prompt        TEXT    NOT NULL,
    full_prompt         TEXT    NOT NULL,
    style_preset        TEXT    NOT NULL,
    parent_batch_id     INTEGER REFERENCES image_batches(id),
    reference_image_id  INTEGER REFERENCES images(id),
    provider            TEXT    NOT NULL,
    model               TEXT    NOT NULL,
    requested_count     INTEGER NOT NULL,
    status              TEXT    NOT NULL, -- running | succeeded | partial | failed | interrupted
    error               TEXT,
    created_at          TEXT    NOT NULL
  );

  CREATE TABLE images (
    id          INTEGER PRIMARY KEY,
    batch_id    INTEGER NOT NULL REFERENCES image_batches(id),
    file_path   TEXT    NOT NULL, -- relative to the asset root
    sha256      TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    bytes       INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    saved       INTEGER NOT NULL DEFAULT 0,
    notes       TEXT,
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX images_batch ON images(batch_id);
  CREATE INDEX images_saved ON images(saved);

  CREATE TABLE animations (
    id              INTEGER PRIMARY KEY,
    image_id        INTEGER NOT NULL REFERENCES images(id),
    motion_prompt   TEXT    NOT NULL,
    provider        TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    duration_s      INTEGER NOT NULL,
    resolution      TEXT    NOT NULL,
    loop_mode       TEXT    NOT NULL, -- same-first-last | none
    estimated_cost_usd REAL NOT NULL,
    operation_id    TEXT,
    status          TEXT    NOT NULL, -- pending | running | succeeded | failed
    file_path       TEXT,
    starred         INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
  );
  CREATE INDEX animations_image ON animations(image_id);
  CREATE INDEX animations_status ON animations(status);

  CREATE TABLE cost_ledger (
    id         INTEGER PRIMARY KEY,
    at         TEXT    NOT NULL,
    provider   TEXT    NOT NULL,
    operation  TEXT    NOT NULL, -- image.generate | video.generate
    usd        REAL    NOT NULL,
    ref_type   TEXT    NOT NULL,
    ref_id     INTEGER NOT NULL
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'ambiance.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  for (let i = row.v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}
