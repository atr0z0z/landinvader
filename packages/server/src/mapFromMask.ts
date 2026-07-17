import { MAP_WIDTH, MAP_HEIGHT, NEUTRAL, WATER } from '@game/shared';
import type { GeneratedMap } from './mapgen';

/**
 * Построение игровой карты из маски суши/воды.
 *
 * Это мост между красивым арт-фоном (реальная карта мира) и симуляцией.
 * Художник/сток даёт две согласованные картинки:
 *   - визуальный фон (его видит игрок, рисуется в клиенте);
 *   - маску суша/вода (чёрно-белую), которую читает эта функция.
 * Территории растекаются только по суше маски и упираются в воду — так
 * эмерджентная механика Territorial ложится на реальную географию.
 *
 * Вход — массив «яркости» каждой клетки (0..255), уже пересэмплированный
 * под размер сетки MAP_WIDTH×MAP_HEIGHT. Клетка светлее порога = суша.
 * Пересэмплинг и декодирование PNG делаются заранее (в загрузчике),
 * чтобы эта функция оставалась чистой и тестируемой.
 */

export interface MaskOptions {
  /** Порог яркости 0..255: клетка светлее — суша, темнее — вода. */
  threshold?: number;
  /** Минимальный размер материка (клеток) для спавна. */
  minLandmassSize?: number;
}

/**
 * @param luminance Uint8Array длиной MAP_WIDTH*MAP_HEIGHT — яркость клеток.
 */
export function mapFromMask(luminance: Uint8Array, options: MaskOptions = {}): GeneratedMap {
  if (luminance.length !== MAP_WIDTH * MAP_HEIGHT) {
    throw new Error(
      `Маска должна быть ${MAP_WIDTH}×${MAP_HEIGHT} = ${MAP_WIDTH * MAP_HEIGHT} клеток, ` +
        `получено ${luminance.length}`,
    );
  }
  const threshold = options.threshold ?? 128;
  const minLandmassSize = options.minLandmassSize ?? 150;

  const grid = new Uint16Array(MAP_WIDTH * MAP_HEIGHT);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = luminance[i]! >= threshold ? NEUTRAL : WATER;
  }

  const spawnable = collectSpawnable(grid, minLandmassSize);
  return { grid, spawnable };
}

/**
 * Находит связные материки (заливка по 4 соседям) и возвращает клетки тех,
 * что не меньше minSize. Идентична отбору в процедурном генераторе —
 * отсекает острова-крошки, где игрок родился бы заперт.
 */
function collectSpawnable(grid: Uint16Array, minSize: number): number[] {
  const visited = new Uint8Array(grid.length);
  const spawnable: number[] = [];
  const stack: number[] = [];

  for (let start = 0; start < grid.length; start++) {
    if (visited[start] || grid[start] !== NEUTRAL) continue;

    const landmass: number[] = [];
    stack.push(start);
    visited[start] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      landmass.push(index);
      const x = index % MAP_WIDTH;
      const y = (index - x) / MAP_WIDTH;
      const tryVisit = (n: number): void => {
        if (!visited[n] && grid[n] === NEUTRAL) {
          visited[n] = 1;
          stack.push(n);
        }
      };
      if (x > 0) tryVisit(index - 1);
      if (x < MAP_WIDTH - 1) tryVisit(index + 1);
      if (y > 0) tryVisit(index - MAP_WIDTH);
      if (y < MAP_HEIGHT - 1) tryVisit(index + MAP_WIDTH);
    }

    if (landmass.length >= minSize) {
      for (const cell of landmass) spawnable.push(cell);
    }
  }
  return spawnable;
}
