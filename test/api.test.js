// Проверка HTTP-слоя: маршруты, коды ответов и раздача статики.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createService } from '../src/service.js';
import { createServer } from '../src/server.js';

let server;
let baseUrl;

before(async () => {
  server = createServer(createService(openDatabase(':memory:')));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => server.close());

async function call(method, path, body) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, text, response };
}

test('полный сценарий через API: сотрудник → старт → повторный старт → стоп → отчёт', async () => {
  const created = await call('POST', '/api/employees', { name: 'Анна Вымыслова' });
  assert.equal(created.status, 201);
  const { id } = created.data;

  const start = await call('POST', `/api/employees/${id}/start`, { description: 'Ревью кода' });
  assert.equal(start.status, 201);

  const again = await call('POST', `/api/employees/${id}/start`, { description: 'Ещё раз' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /уже запущен/);

  const list = await call('GET', '/api/employees');
  assert.equal(list.data[0].running.description, 'Ревью кода');

  const stop = await call('POST', `/api/employees/${id}/stop`);
  assert.equal(stop.status, 200);
  assert.ok(stop.data.endedAt);

  const stopAgain = await call('POST', `/api/employees/${id}/stop`);
  assert.equal(stopAgain.status, 409);

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const report = await call('GET', `/api/report?from=${from}&to=${to}`);
  assert.equal(report.status, 200);
  assert.equal(report.data.employees[0].entries.length, 1);
});

test('пустой отчёт через API возвращает 200 и нулевое время', async () => {
  const report = await call('GET', '/api/report?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z');
  assert.equal(report.status, 200);
  assert.equal(report.data.totalSeconds, 0);
  assert.ok(report.data.employees.every((e) => e.entries.length === 0));
});

test('ошибки ввода возвращают 4xx с понятным сообщением', async () => {
  assert.equal((await call('POST', '/api/employees', '{не json')).status, 400);
  assert.equal((await call('POST', '/api/employees', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/employees/999/start', { description: 'x' })).status, 404);
  assert.equal((await call('GET', '/api/report')).status, 400);
  assert.equal((await call('GET', '/api/unknown')).status, 404);
  assert.equal((await call('DELETE', '/api/employees')).status, 405);
  assert.equal((await call('POST', '/api/employees', 'x'.repeat(20_000))).status, 413);
});

test('отдаёт интерфейс и не выпускает за пределы папки public', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);

  const traversal = await fetch(`${baseUrl}/..%2Fsrc%2Fdb.js`);
  assert.equal(traversal.status, 404);
});
