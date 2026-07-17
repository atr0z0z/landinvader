import { MAP_WIDTH, MAP_HEIGHT, WATER } from '@game/shared';

/**
 * Поиск морского пути для кораблей.
 *
 * Корабль плывёт ТОЛЬКО по воде и должен огибать сушу. Игрок кликает клетки
 * суши (старт — свой берег, цель — чужой берег), но путь прокладывается по
 * воде между ними. Поэтому алгоритм:
 *   1. находит водную клетку, примыкающую к стартовому берегу;
 *   2. находит водную клетку, примыкающую к берегу цели;
 *   3. BFS по воде от старта к цели — кратчайший путь по клеткам.
 *
 * BFS (а не A*) выбран намеренно: на сетке с единичной стоимостью он даёт
 * тот же кратчайший путь, проще и без эвристических багов. Для карты 384²
 * худший случай — обойти всю воду один раз, это дёшево и делается редко
 * (только в момент запуска корабля, не каждый тик).
 *
 * Если пути нет (цель за сушей, изолированное озеро) — возвращаем null,
 * и сервер отклоняет корабль. Никаких зависаний.
 */

const W = MAP_WIDTH;
const H = MAP_HEIGHT;

function isWater(grid: Uint16Array, index: number): boolean {
  return grid[index] === WATER;
}

/** Водная клетка, примыкающая к берегу `landIndex` (или сам, если это вода).
 *  Берёт ближайшего водного соседа — точку, откуда корабль отчаливает/куда
 *  причаливает. null, если у берега нет воды рядом (внутренняя клетка). */
function adjacentWater(grid: Uint16Array, landIndex: number): number | null {
  if (isWater(grid, landIndex)) return landIndex;
  const x = landIndex % W;
  const y = (landIndex - x) / W;
  // 8 соседей (включая диагонали) — берег может касаться воды по углу.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (isWater(grid, ni)) return ni;
    }
  }
  return null;
}

/**
 * Прокладывает морской путь от берега `fromLand` к берегу `toLand`.
 * Возвращает массив индексов клеток (по воде) от старта до цели включительно,
 * либо null, если доплыть нельзя.
 *
 * Результат — координаты для анимации корабля на клиенте; сам захват при
 * прибытии делает обычная боевая механика.
 */
export function findSeaPath(
  grid: Uint16Array,
  fromLand: number,
  toLand: number,
): number[] | null {
  const start = adjacentWater(grid, fromLand);
  const goal = adjacentWater(grid, toLand);
  if (start === null || goal === null) return null;
  if (start === goal) return [start];

  // BFS по воде. prev[i] хранит предшественника для восстановления пути.
  const prev = new Int32Array(W * H).fill(-1);
  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H); // кольцевой буфер как очередь
  let head = 0, tail = 0;

  queue[tail++] = start;
  visited[start] = 1;

  while (head < tail) {
    const cur = queue[head++]!;
    if (cur === goal) return reconstruct(prev, start, goal);

    const x = cur % W;
    const y = (cur - x) / W;
    // 4-связность по воде (корабли не режут углы суши).
    const tryStep = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
      const ni = ny * W + nx;
      if (visited[ni] || !isWater(grid, ni)) return;
      visited[ni] = 1;
      prev[ni] = cur;
      queue[tail++] = ni;
    };
    tryStep(x + 1, y);
    tryStep(x - 1, y);
    tryStep(x, y + 1);
    tryStep(x, y - 1);
  }

  return null; // цель недостижима по воде
}

/** Восстанавливает путь start→goal по массиву предшественников. */
function reconstruct(prev: Int32Array, start: number, goal: number): number[] {
  const path: number[] = [];
  let cur = goal;
  while (cur !== start) {
    path.push(cur);
    cur = prev[cur]!;
    if (cur === -1) break; // страховка от разрыва
  }
  path.push(start);
  path.reverse();
  return path;
}

/**
 * Флоу Territorial: игрок кликает ЦЕЛЬ, а корабль сам стартует от ближайшего
 * (по морю) берега игрока. Здесь один BFS по воде расходится от цели и ищет
 * первую водную клетку, примыкающую к территории игрока — это и есть
 * ближайшая точка отправления, а путь до неё уже построен.
 *
 * Возвращает { path, fromLand } — путь по воде ОТ берега игрока К цели
 * (уже развёрнут в нужную сторону) и клетку берега игрока (старт десанта).
 * null, если от цели по воде не достичь ни одной клетки игрока.
 *
 * @param ownerId владелец, чей берег ищем (игрок, отправляющий корабль).
 */
export function findSeaPathToNearestShore(
  grid: Uint16Array,
  toLand: number,
  ownerId: number,
): { path: number[]; fromLand: number } | null {
  const goalWater = adjacentWater(grid, toLand);
  if (goalWater === null) return null;

  const prev = new Int32Array(W * H).fill(-1);
  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;

  queue[tail++] = goalWater;
  visited[goalWater] = 1;

  while (head < tail) {
    const cur = queue[head++]!;
    const cx = cur % W;
    const cy = (cur - cx) / W;

    // Примыкает ли текущая ВОДНАЯ клетка к территории игрока? (8 соседей —
    // берег может касаться по диагонали). Если да — нашли ближайший берег.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (grid[ni] === ownerId) {
          // Путь: goalWater → ... → cur (вода у берега игрока).
          // Разворачиваем в сторону ОТ игрока К цели.
          const waterPath = reconstruct(prev, goalWater, cur);
          waterPath.reverse(); // теперь от берега игрока к цели
          return { path: waterPath, fromLand: ni };
        }
      }
    }

    // Расширяем BFS по воде (4-связность).
    const tryStep = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
      const idx = ny * W + nx;
      if (visited[idx] || !isWater(grid, idx)) return;
      visited[idx] = 1;
      prev[idx] = cur;
      queue[tail++] = idx;
    };
    tryStep(cx + 1, cy);
    tryStep(cx - 1, cy);
    tryStep(cx, cy + 1);
    tryStep(cx, cy - 1);
  }

  return null; // от цели не доплыть ни до какого берега игрока
}
