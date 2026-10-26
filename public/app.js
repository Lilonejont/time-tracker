// Интерфейс без фреймворков: данные берём из API и перерисовываем списки.

const $ = (selector) => document.querySelector(selector);

const els = {
  now: $('#now'),
  employeeForm: $('#employee-form'),
  employeeName: $('#employee-name'),
  employees: $('#employees'),
  employeesEmpty: $('#employees-empty'),
  employeeTemplate: $('#employee-template'),
  reportForm: $('#report-form'),
  from: $('#from'),
  to: $('#to'),
  report: $('#report'),
  toast: $('#toast'),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Ошибка ${response.status}`);
  return data;
}

let toastTimer;
function showError(error) {
  els.toast.textContent = error.message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 4000);
}

// ---------- Форматирование ----------

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

function formatRange(entry) {
  const start = new Date(entry.startedAt);
  const startText = `${dateFormat.format(start)}, ${timeFormat.format(start)}`;
  if (!entry.endedAt) return `${startText} — идёт`;
  const end = new Date(entry.endedAt);
  const sameDay = start.toDateString() === end.toDateString();
  return `${startText} — ${sameDay ? '' : `${dateFormat.format(end)}, `}${timeFormat.format(end)}`;
}

/** Дата из <input type="date"> как локальная полночь. */
function localMidnight(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------- Сотрудники и таймеры ----------

function renderEmployees(employees) {
  els.employeesEmpty.hidden = employees.length > 0;
  els.employees.replaceChildren(
    ...employees.map((employee) => {
      const item = els.employeeTemplate.content.firstElementChild.cloneNode(true);
      item.dataset.id = employee.id;
      item.classList.toggle('is-running', Boolean(employee.running));
      item.querySelector('.employee-name').textContent = employee.name;

      const elapsed = item.querySelector('.elapsed');
      if (employee.running) {
        elapsed.dataset.startedAt = employee.running.startedAt;
        item.querySelector('.running-task').textContent = employee.running.description;
      }
      item.querySelector('.timer-form').hidden = Boolean(employee.running);
      item.querySelector('.running-row').hidden = !employee.running;
      return item;
    }),
  );
  tick();
}

async function loadEmployees() {
  renderEmployees(await api('/api/employees'));
}

els.employeeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/employees', { method: 'POST', body: { name: els.employeeName.value } });
    els.employeeName.value = '';
    await Promise.all([loadEmployees(), loadReport()]);
  } catch (error) {
    showError(error);
  }
});

els.employees.addEventListener('submit', async (event) => {
  event.preventDefault();
  const item = event.target.closest('.employee');
  const description = event.target.elements.description.value;
  try {
    await api(`/api/employees/${item.dataset.id}/start`, { method: 'POST', body: { description } });
    // Запущенная задача сразу видна и в отчёте, а не только после «Стоп».
    await Promise.all([loadEmployees(), loadReport()]);
  } catch (error) {
    showError(error);
  }
});

els.employees.addEventListener('click', async (event) => {
  if (!event.target.matches('.stop')) return;
  const item = event.target.closest('.employee');
  event.target.disabled = true;
  try {
    await api(`/api/employees/${item.dataset.id}/stop`, { method: 'POST' });
    await Promise.all([loadEmployees(), loadReport()]);
  } catch (error) {
    showError(error);
    event.target.disabled = false;
  }
});

// Каждую секунду обновляем часы и время запущенных таймеров.
function tick() {
  const now = Date.now();
  els.now.textContent = new Date(now).toLocaleString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const el of document.querySelectorAll('.elapsed[data-started-at]')) {
    el.textContent = formatDuration((now - Date.parse(el.dataset.startedAt)) / 1000);
  }
}
setInterval(tick, 1000);

// ---------- Отчёт ----------

function setPreset(preset) {
  const today = localMidnight(toInputValue(new Date()));
  let from = today;
  if (preset === 'last7') {
    from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  } else if (preset === 'month') {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
  }
  els.from.value = toInputValue(from);
  els.to.value = toInputValue(today);
}

function renderReport(report) {
  const withTime = report.employees.filter((e) => e.entries.length > 0);
  if (withTime.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'За выбранный период записей нет.';
    els.report.replaceChildren(empty);
    return;
  }

  const total = document.createElement('p');
  total.className = 'report-total';
  total.innerHTML = '<span>Всего за период</span> <strong></strong>';
  total.querySelector('strong').textContent = formatDuration(report.totalSeconds);

  const list = document.createElement('div');
  list.className = 'report-list';
  for (const employee of withTime) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const name = document.createElement('span');
    name.textContent = employee.name;
    const sum = document.createElement('strong');
    sum.textContent = formatDuration(employee.totalSeconds);
    summary.append(name, sum);

    const table = document.createElement('table');
    table.innerHTML =
      '<thead><tr><th>Задача</th><th>Когда</th><th class="num">Время</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const entry of employee.entries) {
      const row = body.insertRow();
      row.insertCell().textContent = entry.description;
      row.insertCell().textContent = formatRange(entry);
      const cell = row.insertCell();
      cell.className = 'num';
      cell.textContent = formatDuration(entry.seconds);
    }
    table.append(body);
    details.append(summary, table);
    list.append(details);
  }
  els.report.replaceChildren(total, list);
}

async function loadReport() {
  if (!els.from.value || !els.to.value) return;
  const from = localMidnight(els.from.value);
  const toDay = localMidnight(els.to.value);
  // «По» включает выбранный день целиком, поэтому конец — полночь следующего дня.
  const to = new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate() + 1);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  try {
    renderReport(await api(`/api/report?${params}`));
  } catch (error) {
    els.report.replaceChildren(); // не оставляем на экране отчёт за другой период
    showError(error);
  }
}

els.reportForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loadReport();
});

els.reportForm.addEventListener('click', (event) => {
  const preset = event.target.dataset.preset;
  if (!preset) return;
  setPreset(preset);
  loadReport();
});

// ---------- Старт ----------

setPreset('last7');
loadEmployees().catch(showError);
loadReport();
