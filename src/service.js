// Бизнес-логика учёта времени. Ничего не знает об HTTP, поэтому легко тестируется.

export class AppError extends Error {
  /**
   * @param {number} status HTTP-код, который вернёт сервер
   * @param {string} message понятное пользователю сообщение
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 200;

function requireText(value, field, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new AppError(400, `Поле «${field}» не может быть пустым`);
  if (text.length > maxLength) {
    throw new AppError(400, `Поле «${field}» длиннее ${maxLength} символов`);
  }
  return text;
}

function toEntry(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    description: row.description,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: () => number }} [options] now подменяется в тестах
 */
export function createService(db, { now = Date.now } = {}) {
  const q = {
    insertEmployee: db.prepare(
      'INSERT INTO employees (name, name_key, created_at) VALUES (?, ?, ?)',
    ),
    employeeById: db.prepare('SELECT id, name FROM employees WHERE id = ?'),
    employeeByKey: db.prepare('SELECT id FROM employees WHERE name_key = ?'),
    listEmployees: db.prepare('SELECT id, name FROM employees ORDER BY name'),
    runningByEmployee: db.prepare(
      'SELECT * FROM time_entries WHERE employee_id = ? AND ended_at IS NULL',
    ),
    allRunning: db.prepare('SELECT * FROM time_entries WHERE ended_at IS NULL'),
    insertEntry: db.prepare(
      'INSERT INTO time_entries (employee_id, description, started_at) VALUES (?, ?, ?)',
    ),
    stopEntry: db.prepare('UPDATE time_entries SET ended_at = ? WHERE id = ?'),
    entryById: db.prepare('SELECT * FROM time_entries WHERE id = ?'),
    // Запись попадает в период, если пересекается с ним: началась до конца
    // периода и закончилась (или ещё идёт) после его начала.
    entriesInPeriod: db.prepare(`
      SELECT * FROM time_entries
      WHERE started_at < :to AND (ended_at IS NULL OR ended_at > :from)
      ORDER BY started_at
    `),
  };

  function getEmployee(id) {
    const employee = q.employeeById.get(Number(id));
    if (!employee) throw new AppError(404, 'Сотрудник не найден');
    return employee;
  }

  return {
    addEmployee(name) {
      const cleanName = requireText(name, 'Имя', MAX_NAME).replace(/\s+/g, ' ');
      // Ключ без учёта регистра: «Анна Вымыслова» и «анна вымыслова» — один человек.
      const key = cleanName.toLocaleLowerCase('ru');
      if (q.employeeByKey.get(key)) {
        throw new AppError(409, `Сотрудник «${cleanName}» уже есть`);
      }
      const { lastInsertRowid } = q.insertEmployee.run(cleanName, key, now());
      return { id: Number(lastInsertRowid), name: cleanName, running: null };
    },

    /** Список сотрудников вместе с их запущенным таймером (если он есть). */
    listEmployees() {
      const running = new Map(q.allRunning.all().map((row) => [row.employee_id, toEntry(row)]));
      return q.listEmployees.all().map((e) => ({
        id: e.id,
        name: e.name,
        running: running.get(e.id) ?? null,
      }));
    },

    startTimer(employeeId, description) {
      const employee = getEmployee(employeeId);
      const text = requireText(description, 'Описание задачи', MAX_DESCRIPTION);
      if (q.runningByEmployee.get(employee.id)) {
        throw new AppError(409, `У сотрудника «${employee.name}» таймер уже запущен`);
      }
      const { lastInsertRowid } = q.insertEntry.run(employee.id, text, now());
      return toEntry(q.entryById.get(lastInsertRowid));
    },

    stopTimer(employeeId) {
      const employee = getEmployee(employeeId);
      const running = q.runningByEmployee.get(employee.id);
      if (!running) {
        throw new AppError(409, `У сотрудника «${employee.name}» нет запущенного таймера`);
      }
      // Часы могут сдвинуться назад (NTP, ручная правка) — не даём получить
      // отрицательную длительность.
      q.stopEntry.run(Math.max(now(), running.started_at), running.id);
      return toEntry(q.entryById.get(running.id));
    },

    /**
     * Записи и суммарное время каждого сотрудника за период [from, to).
     * Записи, выходящие за границы периода, учитываются только частью,
     * попавшей в период. Незавершённый таймер считается до текущего момента.
     * @param {string} from ISO-дата начала периода (включительно)
     * @param {string} to ISO-дата конца периода (не включительно)
     */
    report(from, to) {
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        throw new AppError(400, 'Укажите корректные даты начала и конца периода');
      }
      if (fromMs >= toMs) {
        throw new AppError(400, 'Начало периода должно быть раньше конца');
      }

      const current = now();
      const byEmployee = new Map();
      for (const row of q.entriesInPeriod.all({ from: fromMs, to: toMs })) {
        const end = row.ended_at ?? current;
        const seconds = Math.max(
          0,
          Math.floor((Math.min(end, toMs) - Math.max(row.started_at, fromMs)) / 1000),
        );
        const list = byEmployee.get(row.employee_id) ?? [];
        list.push({ ...toEntry(row), seconds });
        byEmployee.set(row.employee_id, list);
      }

      const employees = q.listEmployees.all().map((e) => {
        const entries = byEmployee.get(e.id) ?? [];
        return {
          id: e.id,
          name: e.name,
          totalSeconds: entries.reduce((sum, entry) => sum + entry.seconds, 0),
          entries,
        };
      });

      return {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        totalSeconds: employees.reduce((sum, e) => sum + e.totalSeconds, 0),
        employees,
      };
    },
  };
}
