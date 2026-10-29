import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const examples = fileURLToPath(new URL('../examples/knowledge/', import.meta.url));

export class Store {
  constructor(path = ':memory:', { seed = true } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, operation_key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    if (seed && !this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('seeded')) {
      const files = readdirSync(examples).filter(name => name.endsWith('.md')).sort();
      this.db.exec('BEGIN');
      try {
        for (const file of files) {
          const content = readFileSync(join(examples, file), 'utf8');
          const title = content.match(/^#\s+(.+)$/m)?.[1] || file;
          this.addDocument({ id: file.replace(/\.md$/, ''), title, content });
        }
        this.db.prepare('INSERT INTO metadata VALUES (?, ?)').run('seeded', '1');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  documents() {
    return this.db.prepare('SELECT id, title, content, created_at AS createdAt FROM documents ORDER BY created_at DESC, id').all();
  }
  addDocument({ id = randomUUID(), title, content }) {
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?)').run(id, title, content, createdAt);
    return { id, title, content, createdAt };
  }
  deleteDocument(id) { return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0; }
  saveRun(run) {
    this.db.prepare('INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(run.id, JSON.stringify(run), run.createdAt);
  }
  run(id) {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  runs() { return this.db.prepare('SELECT data FROM runs ORDER BY created_at DESC, id DESC LIMIT 100').all().map(row => JSON.parse(row.data)); }
  recoverInterruptedRuns() {
    const rows = this.db.prepare('SELECT data FROM runs').all();
    for (const { data } of rows) {
      const run = JSON.parse(data);
      if (['queued', 'running'].includes(run.status)) {
        run.status = 'failed';
        run.error = '服务重启中断了本次运行，请重新提交。';
        run.updatedAt = new Date().toISOString();
        this.saveRun(run);
      }
    }
  }
  notes() {
    return this.db.prepare('SELECT id, title, content, created_at AS createdAt FROM notes ORDER BY created_at DESC, id DESC').all();
  }
  saveNote({ title, content }, operationKey = null) {
    if (operationKey) {
      const existing = this.db.prepare('SELECT id, title, content, created_at AS createdAt FROM notes WHERE operation_key = ?').get(operationKey);
      if (existing) return existing;
    }
    const note = { id: randomUUID(), title, content, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?)').run(note.id, title, content, note.createdAt, operationKey);
    return note;
  }
  saveEvaluation(evaluation) {
    this.db.prepare('INSERT INTO evaluations VALUES (?, ?, ?)').run(evaluation.id, JSON.stringify(evaluation), evaluation.createdAt);
  }
  evaluations() { return this.db.prepare('SELECT data FROM evaluations ORDER BY created_at DESC LIMIT 20').all().map(row => JSON.parse(row.data)); }
  close() { this.db.close(); }
}
