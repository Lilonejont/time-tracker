import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createService } from './service.js';
import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
// За обратным прокси (nginx) ставим HOST=127.0.0.1, чтобы порт не был виден снаружи.
const host = process.env.HOST;
const dbPath =
  process.env.DB_PATH ?? fileURLToPath(new URL('../data/timetracker.db', import.meta.url));

const db = openDatabase(dbPath);
const server = createServer(createService(db));

server.listen(port, host, () => {
  console.log(`Учёт времени: http://${host ?? 'localhost'}:${port}`);
  console.log(`База данных: ${dbPath}`);
});

// Корректно закрываем базу, чтобы WAL-журнал был записан в основной файл.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
