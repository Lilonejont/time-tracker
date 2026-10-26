import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createService, AppError } from '../src/service.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-03-02T09:00:00.000Z');

let clock;
let service;

beforeEach(() => {
  clock = T0;
  service = createService(openDatabase(':memory:'), { now: () => clock });
});

function expectError(fn, status, messagePart) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AppError, `ожидали AppError, получили ${error}`);
    assert.equal(error.status, status);
    if (messagePart) assert.match(error.message, messagePart);
    return true;
  });
}

test('добавление сотрудника: имя обрезается, пустое и повторное отклоняются', () => {
  const anna = service.addEmployee('  Анна Вымыслова  ');
  assert.equal(anna.name, 'Анна Вымыслова');
  assert.deepEqual(
    service.listEmployees().map((e) => e.name),
    ['Анна Вымыслова'],
  );

  expectError(() => service.addEmployee('   '), 400, /Имя/);
  expectError(() => service.addEmployee(undefined), 400);
  expectError(() => service.addEmployee('анна вымыслова'), 409, /уже есть/);
});

test('старт и стоп таймера создают запись с длительностью', () => {
  const { id } = service.addEmployee('Борис Тестов');
  const started = service.startTimer(id, 'Настройка CI');
  assert.equal(started.endedAt, null);
  assert.equal(service.listEmployees()[0].running.description, 'Настройка CI');

  clock += 25 * MINUTE;
  const stopped = service.stopTimer(id);
  assert.equal(stopped.endedAt, new Date(T0 + 25 * MINUTE).toISOString());
  assert.equal(service.listEmployees()[0].running, null);

  const report = service.report('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z');
  assert.equal(report.employees[0].totalSeconds, 25 * 60);
});

test('повторный запуск таймера, пока он идёт, отклоняется и не создаёт вторую запись', () => {
  const { id } = service.addEmployee('Вера Примерова');
  service.startTimer(id, 'Документация');
  clock += 5 * MINUTE;

  expectError(() => service.startTimer(id, 'Другая задача'), 409, /уже запущен/);

  clock += 5 * MINUTE;
  service.stopTimer(id);
  const { entries } = service.report('2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z').employees[0];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].description, 'Документация');
  assert.equal(entries[0].seconds, 10 * 60);
});

test('после остановки таймер можно запустить снова — получится вторая запись', () => {
  const { id } = service.addEmployee('Вера Примерова');
  service.startTimer(id, 'Задача 1');
  clock += 10 * MINUTE;
  service.stopTimer(id);
  clock += MINUTE;
  service.startTimer(id, 'Задача 2');
  clock += 20 * MINUTE;
  service.stopTimer(id);

  const employee = service.report('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z').employees[0];
  assert.deepEqual(
    employee.entries.map((e) => e.description),
    ['Задача 1', 'Задача 2'],
  );
  assert.equal(employee.totalSeconds, 30 * 60);
});

test('таймеры разных сотрудников не мешают друг другу', () => {
  const a = service.addEmployee('Анна');
  const b = service.addEmployee('Борис');
  service.startTimer(a.id, 'А');
  service.startTimer(b.id, 'Б');
  assert.equal(service.listEmployees().filter((e) => e.running).length, 2);
});

test('стоп без запущенного таймера и действия с несуществующим сотрудником', () => {
  const { id } = service.addEmployee('Анна');
  expectError(() => service.stopTimer(id), 409, /нет запущенного/);
  expectError(() => service.startTimer(999, 'Задача'), 404);
  expectError(() => service.stopTimer(999), 404);
  expectError(() => service.startTimer(id, '  '), 400, /Описание/);
});

test('пустой отчёт: нет сотрудников вообще', () => {
  const report = service.report('2026-03-01T00:00:00Z', '2026-03-08T00:00:00Z');
  assert.deepEqual(report.employees, []);
  assert.equal(report.totalSeconds, 0);
});

test('пустой отчёт: сотрудники есть, но в периоде нет записей', () => {
  const { id } = service.addEmployee('Анна');
  service.startTimer(id, 'Старая задача');
  clock += 30 * MINUTE;
  service.stopTimer(id);

  const report = service.report('2026-04-01T00:00:00Z', '2026-04-08T00:00:00Z');
  assert.equal(report.totalSeconds, 0);
  assert.deepEqual(report.employees, [{ id, name: 'Анна', totalSeconds: 0, entries: [] }]);
});

test('запись на границе периода учитывается только своей частью внутри периода', () => {
  const { id } = service.addEmployee('Анна');
  clock = Date.parse('2026-03-02T23:30:00Z');
  service.startTimer(id, 'Ночной релиз');
  clock = Date.parse('2026-03-03T01:00:00Z');
  service.stopTimer(id);

  const day1 = service.report('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z');
  const day2 = service.report('2026-03-03T00:00:00Z', '2026-03-04T00:00:00Z');
  assert.equal(day1.totalSeconds, 30 * 60);
  assert.equal(day2.totalSeconds, 60 * 60);
});

test('запись, закончившаяся ровно в начале периода, в него не попадает', () => {
  const { id } = service.addEmployee('Анна');
  clock = Date.parse('2026-03-02T23:00:00Z');
  service.startTimer(id, 'До полуночи');
  clock = Date.parse('2026-03-03T00:00:00Z');
  service.stopTimer(id);

  const report = service.report('2026-03-03T00:00:00Z', '2026-03-04T00:00:00Z');
  assert.deepEqual(report.employees[0].entries, []);
});

test('незавершённый таймер в отчёте считается до текущего момента', () => {
  const { id } = service.addEmployee('Анна');
  service.startTimer(id, 'Идёт сейчас');
  clock += 15 * MINUTE;

  const entry = service.report('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z').employees[0]
    .entries[0];
  assert.equal(entry.endedAt, null);
  assert.equal(entry.seconds, 15 * 60);
});

test('некорректный период отклоняется', () => {
  expectError(() => service.report('вчера', '2026-03-03T00:00:00Z'), 400);
  expectError(() => service.report(null, null), 400);
  expectError(
    () => service.report('2026-03-03T00:00:00Z', '2026-03-03T00:00:00Z'),
    400,
    /раньше/,
  );
});

test('часы сдвинулись назад — длительность не становится отрицательной', () => {
  const { id } = service.addEmployee('Анна');
  service.startTimer(id, 'Задача');
  clock -= 5 * MINUTE;
  const stopped = service.stopTimer(id);
  assert.equal(stopped.endedAt, stopped.startedAt);
});

test('данные сохраняются после перезапуска (повторного открытия базы)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'time-tracker-'));
  const file = join(dir, 'test.db');
  try {
    const db1 = openDatabase(file);
    const first = createService(db1, { now: () => clock });
    const { id } = first.addEmployee('Анна');
    first.startTimer(id, 'Задача до перезапуска');
    clock += 40 * MINUTE;
    first.stopTimer(id);
    first.startTimer(id, 'Таймер, который идёт во время перезапуска');
    db1.close();

    clock += 20 * MINUTE;
    const db2 = openDatabase(file);
    const second = createService(db2, { now: () => clock });
    const [anna] = second.listEmployees();
    assert.equal(anna.name, 'Анна');
    assert.equal(anna.running.description, 'Таймер, который идёт во время перезапуска');

    second.stopTimer(anna.id);
    const report = second.report('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z');
    assert.equal(report.totalSeconds, 60 * 60);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
