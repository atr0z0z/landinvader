import CanvasKitInit, { type CanvasKit } from 'canvaskit-wasm';
// Vite отдаёт правильный URL для .wasm файла из node_modules.
import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';

/**
 * Загрузка CanvasKit (Skia в WebAssembly) в браузере.
 *
 * CanvasKit — это движок Skia (тот, что рисует Chrome и Android),
 * скомпилированный в WASM. Даёт настоящую векторную графику: сглаженные
 * заливки, градиенты, тени, свечение — как первоклассные примитивы.
 *
 * wasm-бинарник (~3 МБ gzip) грузится асинхронно один раз при старте.
 * Vite подставляет корректный URL через `?url`-импорт.
 */
let cachedKit: CanvasKit | null = null;

export async function loadCanvasKit(): Promise<CanvasKit> {
  if (cachedKit) return cachedKit;
  cachedKit = await CanvasKitInit({ locateFile: () => wasmUrl });
  return cachedKit;
}
