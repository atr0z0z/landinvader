import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAP_WIDTH, MAP_HEIGHT, NEUTRAL, WATER } from '@game/shared';
import type { GeneratedMap } from './mapgen';

/**
 * Мировая карта: загрузка маски суши/воды и нарезка случайного квадратного
 * выреза под конкретную партию.
 *
 * Идея (по решению дизайна): вместо процедурных континентов берём реальную
 * карту мира и при старте партии вырезаем из неё случайный квадратный
 * участок. Каждая игра — новая география (то Европа+Африка, то Азия, то
 * Америки) → реиграбельность, при этом сетка остаётся квадратной.
 *
 * Клиенту, помимо сетки, сообщаются координаты выреза в долях мировой
 * карты (cropX, cropY, cropSize) — чтобы он показал ровно тот же кусок
 * красивого фона-картинки под территориями. Так фон и симуляция совпадают.
 *
 * Формат assets_world_mask.bin: заголовок <uint32 width><uint32 height>,
 * далее width*height байт (1 = суша, 0 = вода).
 */

/** Доля высоты мира, которую занимает сторона квадратного выреза. */
const CROP_FRACTION = 0.6;
/** Требования к сцене: доля суши в вырезе должна попасть в этот диапазон,
 *  иначе выбираем другой участок (не пустой океан, не сплошной материк). */
const MIN_LAND = 0.15;
const MAX_LAND = 0.7;
/** Минимальный размер материка (в клетках сетки) для спавна. */
const MIN_LANDMASS = 150;

interface WorldMask {
  width: number;
  height: number;
  /** 1 = суша, 0 = вода. Длина width*height. */
  data: Uint8Array;
}

let cachedWorld: WorldMask | null = null;

function loadWorldMask(): WorldMask {
  if (cachedWorld) return cachedWorld;
  const here = dirname(fileURLToPath(import.meta.url));
  const buf = readFileSync(join(here, 'assets_world_mask.bin'));
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const data = new Uint8Array(buf.buffer, buf.byteOffset + 8, width * height);
  cachedWorld = { width, height, data };
  return cachedWorld;
}

/** Координаты выреза в ДОЛЯХ мировой карты (0..1) — для синхронизации фона.
 *  x, size — по ширине; y, sizeY — по высоте (пропорции карты не 1:1). */
export interface CropInfo {
  x: number;
  y: number;
  size: number;
  sizeY: number;
}

export interface WorldMapResult extends GeneratedMap {
  crop: CropInfo;
}

/**
 * Выбирает случайный квадратный вырез с достаточной сушей и пересэмплит
 * его в игровую сетку MAP_WIDTH×MAP_HEIGHT.
 */
export function generateWorldMap(): WorldMapResult {
  const world = loadWorldMask();
  const side = Math.floor(world.height * CROP_FRACTION);

  // Пробуем случайные позиции, пока не найдём вырез с приемлемой сушей.
  let cropX = 0;
  let cropY = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = Math.floor(Math.random() * (world.width - side));
    const y = Math.floor(Math.random() * (world.height - side));
    const land = landFraction(world, x, y, side);
    if (land >= MIN_LAND && land <= MAX_LAND) {
      cropX = x;
      cropY = y;
      break;
    }
  }

  // Пересэмплим вырез в сетку. Чтобы тонкие перешейки не рвались при
  // уменьшении, клетка сетки = СУША, если суша есть хотя бы в части
  // соответствующего окна маски (а не только в центре). Это сохраняет
  // узкие сухопутные связи (Панама, Синай, проливы).
  const grid = new Uint16Array(MAP_WIDTH * MAP_HEIGHT);
  const cellW = side / MAP_WIDTH;
  const cellH = side / MAP_HEIGHT;
  for (let gy = 0; gy < MAP_HEIGHT; gy++) {
    for (let gx = 0; gx < MAP_WIDTH; gx++) {
      const wx0 = cropX + Math.floor(gx * cellW);
      const wy0 = cropY + Math.floor(gy * cellH);
      const wx1 = Math.min(world.width - 1, cropX + Math.floor((gx + 1) * cellW));
      const wy1 = Math.min(world.height - 1, cropY + Math.floor((gy + 1) * cellH));
      // Клетка — суша, если в окне [wx0..wx1)×[wy0..wy1) есть хоть одна суша.
      let land = false;
      for (let wy = wy0; wy <= wy1 && !land; wy++) {
        for (let wx = wx0; wx <= wx1 && !land; wx++) {
          if (world.data[wy * world.width + wx] === 1) land = true;
        }
      }
      grid[gy * MAP_WIDTH + gx] = land ? NEUTRAL : WATER;
    }
  }

  const spawnable = collectSpawnable(grid, MIN_LANDMASS);

  return {
    grid,
    spawnable,
    crop: {
      // Доли относительно СВОЕЙ оси: x и sizeX по ширине, y и sizeY по высоте.
      // Так вырез одинаково ложится и на маску, и на фон любой пропорции.
      x: cropX / world.width,
      y: cropY / world.height,
      size: side / world.width,
      sizeY: side / world.height,
    },
  };
}

/** Доля суши в квадратном вырезе (выборочно, для скорости). */
function landFraction(world: WorldMask, x: number, y: number, side: number): number {
  let land = 0;
  let total = 0;
  const step = Math.max(1, Math.floor(side / 64)); // сэмплим ~64×64 точек
  for (let dy = 0; dy < side; dy += step) {
    for (let dx = 0; dx < side; dx += step) {
      if (world.data[(y + dy) * world.width + (x + dx)] === 1) land++;
      total++;
    }
  }
  return total > 0 ? land / total : 0;
}

/** Связные материки ≥ minSize — кандидаты под спавн (как в mapgen). */
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
