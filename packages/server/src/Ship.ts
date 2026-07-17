import { MAP_WIDTH, SHIP_SPEED_CELLS_PER_TICK } from '@game/shared';

/**
 * Корабль — переносчик десанта через воду.
 *
 * Единый пул войск: корабль не «хранит» отдельную армию, он лишь ВЕЗЁТ
 * списанные при отправке войска к дальнему берегу. Долетев, он высаживает
 * их как обычную волну атаки (та же боевая механика, что на суше). Поэтому
 * никакой отдельной экономики анклавов нет — захваченная земля просто
 * вливается в общий доход игрока. Это исключает баги с делением армий.
 *
 * Движение — по заранее проложенному морскому пути (см. seaPath). Корабль
 * идёт по нему с постоянной скоростью; позиция интерполируется для плавной
 * анимации на клиенте.
 */
export class Ship {
  /** Прогресс вдоль пути в клетках (дробный). */
  private progress = 0;

  constructor(
    readonly playerId: number,
    readonly troops: number,
    /** Морской путь (индексы клеток по воде) от старта к цели. */
    readonly path: number[],
    /** Клетка-берег назначения (куда высаживать десант). */
    readonly targetLand: number,
  ) {}

  /** Продвигает корабль. Возвращает true, если ещё в пути. */
  advance(): boolean {
    this.progress += SHIP_SPEED_CELLS_PER_TICK;
    return this.progress < this.path.length - 1;
  }

  /** Текущая позиция в координатах клеток (дробная) — для анимации. */
  get position(): { x: number; y: number } {
    const i = Math.min(this.path.length - 1, Math.floor(this.progress));
    const j = Math.min(this.path.length - 1, i + 1);
    const frac = this.progress - i;
    const a = this.path[i]!;
    const b = this.path[j]!;
    const ax = a % MAP_WIDTH, ay = (a - ax) / MAP_WIDTH;
    const bx = b % MAP_WIDTH, by = (b - bx) / MAP_WIDTH;
    return { x: ax + (bx - ax) * frac, y: ay + (by - ay) * frac };
  }
}
