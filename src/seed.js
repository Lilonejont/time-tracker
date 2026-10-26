// Заполняет базу вымышленными сотрудниками и записями за последние дни.
// Запуск: npm run seed (только для пустой базы).
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createService } from './service.js';

const dbPath =
  process.env.DB_PATH ?? fileURLToPath(new URL('../data/timetracker.db', import.meta.url));
const db = openDatabase(dbPath);

if (db.prepare('SELECT COUNT(*) AS n FROM employees').get().n > 0) {
  console.log('В базе уже есть сотрудники — демо-данные не добавлены.');
  process.exit(0);
}

const HOUR = 3_600_000;
let clock = 0;
const service = createService(db, { now: () => clock });

const plan = {
  'Анна Вымыслова': ['Вёрстка страницы отчётов', 'Созвон с командой', 'Ревью кода'],
  'Борис Тестов': ['Настройка CI', 'Исправление бага в API'],
  'Вера Примерова': ['Подготовка презентации', 'Интервью с кандидатом', 'Документация'],
};

const today = new Date();
today.setHours(9, 0, 0, 0);

Object.entries(plan).forEach(([name, tasks], personIndex) => {
  const { id } = service.addEmployee(name);
  for (let daysAgo = 3; daysAgo >= 1; daysAgo--) {
    clock = today.getTime() - daysAgo * 24 * HOUR + personIndex * 0.5 * HOUR;
    for (const [taskIndex, task] of tasks.entries()) {
      service.startTimer(id, task);
      clock += (1 + ((daysAgo + taskIndex + personIndex) % 3)) * HOUR;
      service.stopTimer(id);
      clock += 0.25 * HOUR;
    }
  }
});

db.close();
console.log(`Добавлено ${Object.keys(plan).length} сотрудника с записями за 3 дня: ${dbPath}`);
