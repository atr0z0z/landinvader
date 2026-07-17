import { MAP_WIDTH, MAP_HEIGHT } from '@game/shared';

/**
 * Построение контуров территорий из сетки владения (contour tracing).
 * Даёт замкнутые полигоны в координатах клеток — их рисует Skia гладкими
 * путями.
 *
 * ОПТИМИЗАЦИЯ (было ~110мс на 384², цель — единицы мс):
 *  - visited — типизированный Uint8Array вместо Set (нет хеширования);
 *  - один проход по карте, старты только у клеток на границе;
 *  - без аллокаций Set на каждого игрока.
 */

export type Contour = number[]; // [x0,y0, x1,y1, ...] в клетках
export interface OwnerContours {
  owner: number;
  loops: Contour[];
}

const W = MAP_WIDTH;
const H = MAP_HEIGHT;
const NODES_W = W + 1;

const enum Dir { Right = 0, Down = 1, Left = 2, Up = 3 }
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

function cellOwner(grid: Uint16Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= W || y >= H) return -1;
  return grid[y * W + x]!;
}

export function buildContours(grid: Uint16Array, skip: Set<number>): OwnerContours[] {
  const leftRight = (nx: number, ny: number, d: Dir): [number, number] => {
    switch (d) {
      case Dir.Right: return [cellOwner(grid, nx, ny - 1), cellOwner(grid, nx, ny)];
      case Dir.Down:  return [cellOwner(grid, nx, ny),     cellOwner(grid, nx - 1, ny)];
      case Dir.Left:  return [cellOwner(grid, nx - 1, ny), cellOwner(grid, nx - 1, ny - 1)];
      case Dir.Up:    return [cellOwner(grid, nx - 1, ny - 1), cellOwner(grid, nx, ny - 1)];
    }
  };
  const isBoundaryEdge = (nx: number, ny: number, d: Dir, owner: number): boolean => {
    const [left, right] = leftRight(nx, ny, d);
    return left === owner && right !== owner;
  };
  const edgeKey = (nx: number, ny: number, d: Dir): number => (ny * NODES_W + nx) * 4 + d;

  const visited = new Uint8Array(NODES_W * (H + 1) * 4);
  const byOwner = new Map<number, Contour[]>();

  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const owner = grid[cy * W + cx]!;
      if (skip.has(owner)) continue;

      for (let d = 0 as Dir; d < 4; d++) {
        const nx = cx;
        const ny = cy;
        if (!isBoundaryEdge(nx, ny, d, owner)) continue;
        if (visited[edgeKey(nx, ny, d)]) continue;

        const loop: number[] = [];
        let px = nx, py = ny, pd = d;
        do {
          visited[edgeKey(px, py, pd)] = 1;
          loop.push(px, py);
          px += DX[pd]!;
          py += DY[pd]!;
          const o0 = ((pd + 3) & 3) as Dir, o1 = pd, o2 = ((pd + 1) & 3) as Dir, o3 = ((pd + 2) & 3) as Dir;
          let next: Dir | -1 = -1;
          if (isBoundaryEdge(px, py, o0, owner) && !visited[edgeKey(px, py, o0)]) next = o0;
          else if (isBoundaryEdge(px, py, o1, owner) && !visited[edgeKey(px, py, o1)]) next = o1;
          else if (isBoundaryEdge(px, py, o2, owner) && !visited[edgeKey(px, py, o2)]) next = o2;
          else if (isBoundaryEdge(px, py, o3, owner) && !visited[edgeKey(px, py, o3)]) next = o3;
          if (next === -1) break;
          pd = next;
        } while (!(px === nx && py === ny && pd === d));

        if (loop.length >= 6) {
          let loops = byOwner.get(owner);
          if (!loops) { loops = []; byOwner.set(owner, loops); }
          loops.push(loop);
        }
      }
    }
  }

  const result: OwnerContours[] = [];
  for (const [owner, loops] of byOwner) result.push({ owner, loops });
  return result;
}

/** Chaikin-сглаживание замкнутого контура. */
export function chaikin(loop: Contour, iterations = 3): Contour {
  let pts = loop;
  for (let it = 0; it < iterations; it++) {
    const out: number[] = [];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = pts[i * 2]!, ay = pts[i * 2 + 1]!;
      const j = (i + 1) % n;
      const bx = pts[j * 2]!, by = pts[j * 2 + 1]!;
      out.push(ax + (bx - ax) * 0.25, ay + (by - ay) * 0.25);
      out.push(ax + (bx - ax) * 0.75, ay + (by - ay) * 0.75);
    }
    pts = out;
  }
  return pts;
}
