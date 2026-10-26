import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Время хранится в миллисекундах Unix (UTC): так проще считать длительность
// и нет проблем с часовыми поясами при сравнении.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS employees (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    -- Имя в нижнем регистре для проверки дублей. COLLATE NOCASE здесь не
    -- подходит: SQLite приводит к одному регистру только латиницу.
    name_key   TEXT    NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    description TEXT    NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
  );

  -- У сотрудника может быть только один запущенный таймер.
  -- Правило проверяется и в коде, но индекс защищает от гонки двух запросов.
  CREATE UNIQUE INDEX IF NOT EXISTS one_running_timer_per_employee
    ON time_entries(employee_id) WHERE ended_at IS NULL;

  CREATE INDEX IF NOT EXISTS time_entries_by_start
    ON time_entries(started_at);
`;

/**
 * Открывает базу SQLite и создаёт таблицы, если их ещё нет.
 * @param {string} path путь к файлу базы или ':memory:' для тестов
 */
export function openDatabase(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}
