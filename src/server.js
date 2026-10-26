import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './service.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 10_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'Тело запроса должно быть в формате JSON');
  }
}

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relative));
  // Не выпускаем запросы вида /../src/db.js за пределы папки public.
  if (!filePath.startsWith(PUBLIC_DIR) || filePath.endsWith(sep)) {
    return sendJson(res, 404, { error: 'Не найдено' });
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Не найдено' });
  }
}

/** Таблица маршрутов API: метод, шаблон пути, обработчик. */
function buildRoutes(service) {
  return [
    ['GET', /^\/api\/employees$/, () => [200, service.listEmployees()]],
    [
      'POST',
      /^\/api\/employees$/,
      async (req) => [201, service.addEmployee((await readJson(req)).name)],
    ],
    [
      'POST',
      /^\/api\/employees\/(\d+)\/start$/,
      async (req, [id]) => [201, service.startTimer(id, (await readJson(req)).description)],
    ],
    ['POST', /^\/api\/employees\/(\d+)\/stop$/, (_req, [id]) => [200, service.stopTimer(id)]],
    [
      'GET',
      /^\/api\/report$/,
      (_req, _params, url) => [
        200,
        service.report(url.searchParams.get('from'), url.searchParams.get('to')),
      ],
    ],
  ];
}

/**
 * @param {ReturnType<import('./service.js').createService>} service
 */
export function createServer(service) {
  const routes = buildRoutes(service);

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Метод не поддерживается' });
        return await serveStatic(url.pathname, res);
      }

      const pathMatches = routes.filter(([, pattern]) => pattern.test(url.pathname));
      if (pathMatches.length === 0) return sendJson(res, 404, { error: 'Не найдено' });

      const route = pathMatches.find(([method]) => method === req.method);
      if (!route) return sendJson(res, 405, { error: 'Метод не поддерживается' });

      const [, pattern, handler] = route;
      const params = url.pathname.match(pattern).slice(1);
      const [status, data] = await handler(req, params, url);
      sendJson(res, status, data);
    } catch (error) {
      if (error instanceof AppError) return sendJson(res, error.status, { error: error.message });
      console.error(error);
      sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  });
}
