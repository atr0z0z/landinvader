import { MAP_WIDTH, MAP_HEIGHT, NEUTRAL, WATER } from '@game/shared';

/**
 * Процедурная генерация карты континентов.
 *
 * Подход — value noise + fractal Brownian motion (наложение октав шума
 * разной частоты). Без внешних зависимостей: сетка случайных значений,
 * между узлами — сглаженная интерполяция. Классический способ получить
 * органичные, «природные» очертания суши.
 *
 * Результат пишется прямо в grid: клетка = WATER или NEUTRAL (свободная суша).
 * Владельцы (игроки) появятся поверх позже, при спавне.
 */

/** Детерминированный ГПСЧ (mulberry32): один seed → одна и та же карта.
 *  Пригодится для «сыграть на той же карте» и для отладки. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Сетка value-noise: случайные значения в узлах + косинусная интерполяция. */
class ValueNoise {
  private readonly gridSize: number;
  private readonly values: Float32Array;
  private readonly cols: number;

  constructor(cellSize: number, rng: () => number) {
    this.gridSize = cellSize;
    this.cols = Math.ceil(MAP_WIDTH / cellSize) + 2;
    const rows = Math.ceil(MAP_HEIGHT / cellSize) + 2;
    this.values = new Float32Array(this.cols * rows);
    for (let i = 0; i < this.values.length; i++) this.values[i] = rng();
  }

  private node(gx: number, gy: number): number {
    return this.values[gy * this.cols + gx]!;
  }

  /** Значение шума в точке (x, y) карты, диапазон 0..1. */
  sample(x: number, y: number): number {
    const gx = Math.floor(x / this.gridSize);
    const gy = Math.floor(y / this.gridSize);
    const fx = (x / this.gridSize) - gx;
    const fy = (y / this.gridSize) - gy;

    // Косинусное сглаживание вместо линейного — мягче переходы, нет углов.
    const sx = (1 - Math.cos(fx * Math.PI)) / 2;
    const sy = (1 - Math.cos(fy * Math.PI)) / 2;

    const top = this.lerp(this.node(gx, gy), this.node(gx + 1, gy), sx);
    const bottom = this.lerp(this.node(gx, gy + 1), this.node(gx + 1, gy + 1), sx);
    return this.lerp(top, bottom, sy);
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }
}

export interface MapGenOptions {
  seed?: number;
  /** Доля суши 0..1: выше порог → меньше суши. ~0.5 даёт «архипелаг+материки». */
  seaLevel?: number;
  /** Минимальный размер материка (в клетках), где разрешён спавн. */
  minLandmassSize?: number;
}

export interface GeneratedMap {
  /** WATER или NEUTRAL для каждой клетки. */
  grid: Uint16Array;
  /** Индексы клеток, пригодных под спавн (суша в крупных материках). */
  spawnable: number[];
}

/**
 * Генерирует карту. FBM: складываем несколько октав шума —
 * крупные задают форму материков, мелкие добавляют изрезанность берега.
 */
export function generateMap(options: MapGenOptions = {}): GeneratedMap {
  const seed = options.seed ?? (Math.random() * 2 ** 32) >>> 0;
  const seaLevel = options.seaLevel ?? 0.42;
  const minLandmassSize = options.minLandmassSize ?? 150;

  const rng = mulberry32(seed);

  // Октавы: (размер клетки шума, вес). Крупные важнее — задают континенты.
  const octaves = [
    new ValueNoise(96, rng),
    new ValueNoise(48, rng),
    new ValueNoise(24, rng),
    new ValueNoise(12, rng),
  ];
  const weights = [1.0, 0.5, 0.25, 0.125];
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const grid = new Uint16Array(MAP_WIDTH * MAP_HEIGHT);

  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      let noise = 0;
      for (let o = 0; o < octaves.length; o++) {
        noise += octaves[o]!.sample(x, y) * weights[o]!;
      }
      noise /= weightSum;

      // Радиальный спад к краям: суша тяготеет к центру, карту опоясывает
      // океан. Мягкий коэффициент — материки заполняют карту, но у самых
      // краёв гарантированно вода.
      const nx = (x / MAP_WIDTH) * 2 - 1;
      const ny = (y / MAP_HEIGHT) * 2 - 1;
      const edgeFalloff = 1 - Math.min(1, Math.pow(Math.max(Math.abs(nx), Math.abs(ny)), 3) * 0.9);
      noise *= edgeFalloff;

      grid[y * MAP_WIDTH + x] = noise > seaLevel ? NEUTRAL : WATER;
    }
  }

  const spawnable = collectSpawnable(grid, minLandmassSize);
  return { grid, spawnable };
}

/**
 * Находит связные материки (заливка по 4 соседям) и возвращает клетки
 * только тех, что не меньше minSize. Отсекает острова-крошки, где игрок
 * родился бы запертым.
 */
function collectSpawnable(grid: Uint16Array, minSize: number): number[] {
  const visited = new Uint8Array(grid.length);
  const spawnable: number[] = [];
  const stack: number[] = [];

  for (let start = 0; start < grid.length; start++) {
    if (visited[start] || grid[start] !== NEUTRAL) continue;

    // Заливка одного материка; клетки копим, чтобы принять их скопом.
    const landmass: number[] = [];
    stack.push(start);
    visited[start] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      landmass.push(index);

      const x = index % MAP_WIDTH;
      const y = (index - x) / MAP_WIDTH;
      if (x > 0) tryVisit(index - 1);
      if (x < MAP_WIDTH - 1) tryVisit(index + 1);
      if (y > 0) tryVisit(index - MAP_WIDTH);
      if (y < MAP_HEIGHT - 1) tryVisit(index + MAP_WIDTH);
    }

    if (landmass.length >= minSize) {
      for (const cell of landmass) spawnable.push(cell);
    }

    function tryVisit(neighbor: number): void {
      if (!visited[neighbor] && grid[neighbor] === NEUTRAL) {
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }
  }

  return spawnable;
}
