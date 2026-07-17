import { MAP_WIDTH, MAP_HEIGHT, WATER } from './constants';

/**
 * Проверка морской достижимости — общая для клиента и сервера.
 *
 * Клиент использует её, чтобы решить, показывать ли кнопку «Кораблик»:
 * она появляется только если у территории игрока есть выход к тому же
 * водному бассейну, что и цель. Сервер использует ту же логику при
 * фактическом запуске (см. findSeaPathToNearestShore) — поэтому клиентская
 * проверка и серверное решение всегда согласованы.
 *
 * Алгоритм: BFS по воде от клетки-цели. Если волна достигает воды,
 * примыкающей к территории игрока, — цель достижима, корабль возможен.
 */

const W = MAP_WIDTH;
const H = MAP_HEIGHT;

function adjacentWater(grid: Uint16Array, landIndex: number): number {
  if (grid[landIndex] === WATER) return landIndex;
  const x = landIndex % W;
  const y = (landIndex - x) / W;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (grid[ni] === WATER) return ni;
    }
  }
  return -1;
}

/**
 * Достижима ли цель `toLand` по воде от территории игрока `ownerId`?
 * true → у игрока есть берег в том же водном бассейне, что и цель.
 */
export function isSeaReachable(grid: Uint16Array, toLand: number, ownerId: number): boolean {
  const goalWater = adjacentWater(grid, toLand);
  if (goalWater === -1) return false; // у цели нет воды рядом

  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  queue[tail++] = goalWater;
  visited[goalWater] = 1;

  while (head < tail) {
    const cur = queue[head++]!;
    const cx = cur % W;
    const cy = (cur - cx) / W;

    // Примыкает ли эта вода к территории игрока? (8 соседей)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (grid[ny * W + nx] === ownerId) return true;
      }
    }

    const step = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
      const ni = ny * W + nx;
      if (visited[ni] || grid[ni] !== WATER) return;
      visited[ni] = 1;
      queue[tail++] = ni;
    };
    step(cx + 1, cy);
    step(cx - 1, cy);
    step(cx, cy + 1);
    step(cx, cy - 1);
  }

  return false; // до игрока по воде не добраться
}
