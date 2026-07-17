import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAP_WIDTH, MAP_HEIGHT, TICK_RATE } from '@game/shared';
import { GameServer } from './GameServer';

/**
 * Production-точка входа.
 *
 * Один процесс делает две вещи:
 *   1. раздаёт собранный клиент (статика из client/dist) по HTTP;
 *   2. держит WebSocket на том же порту (апгрейд с HTTP).
 *
 * Всё на одном порту -> один домен, простой деплой. HTTPS/WSS добавляет
 * снаружи reverse-proxy (Caddy) - он терминирует TLS и проксирует сюда.
 *
 * Порт берётся из переменной окружения PORT, с фолбэком 8080 для локали.
 */

const PORT = Number(process.env.PORT) || 8080;

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = process.env.CLIENT_DIR || join(here, '..', '..', 'client', 'dist');

// MIME-типы (в т.ч. .wasm - критично для CanvasKit).
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

/** Безопасная раздача статики (защита от path traversal). */
async function serveStatic(urlPath: string): Promise<{ body: Buffer; type: string } | null> {
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(CLIENT_DIR, safe);
  try {
    let s = await stat(filePath);
    if (s.isDirectory()) {
      filePath = join(filePath, 'index.html');
      s = await stat(filePath);
    }
    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    return { body, type };
  } catch {
    return null;
  }
}

const httpServer = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]!);
  const asset = await serveStatic(urlPath === '/' ? '/index.html' : urlPath);
  if (asset) {
    res.writeHead(200, { 'Content-Type': asset.type });
    res.end(asset.body);
    return;
  }
  // SPA-фолбэк: неизвестный путь -> index.html.
  const index = await serveStatic('/index.html');
  if (index) {
    res.writeHead(200, { 'Content-Type': index.type });
    res.end(index.body);
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer });
new GameServer(wss);

httpServer.listen(PORT, () => {
  console.log(
    `Сервер запущен на порту ${PORT} | карта ${MAP_WIDTH}x${MAP_HEIGHT}, ${TICK_RATE} тиков/с`,
  );
});

// Graceful shutdown: чистый рестарт.
function shutdown(signal: string): void {
  console.log(`\n${signal} - останавливаюсь...`);
  wss.clients.forEach((c) => c.close(1001, 'Сервер перезапускается'));
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
