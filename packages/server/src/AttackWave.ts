import {
  MAP_WIDTH,
  WATER,
  WAVE_SPEED_CELLS_PER_TICK,
  WAVE_DIRECTION_BIAS,
} from '@game/shared';
import { MinHeap } from './MinHeap';

/**
 * Интерфейс мира с точки зрения волны. Волна не владеет картой —
 * она просит Simulation читать клетки, узнавать стоимость и захватывать.
 * Это разрывает циклическую зависимость и позволяет тестировать волну
 * на фейковом мире.
 */
export interface WaveContext {
  ownerOf(index: number): number;
  /** Стоимость захвата клетки в войсках (зависит от обороны защитника).
   *  Считает Simulation, т.к. только она знает балансы игроков. */
  costOf(index: number): number;
  /** Передать клетку атакующему (со всей бухгалтерией территорий).
   *  holdStrength — войска, оставляемые в клетке как её новая оборона. */
  captureCell(index: number, attackerId: number, holdStrength: number): void;
  neighborsOf(index: number): Iterable<number>;
  /** Примыкает ли клетка к территории игрока (есть сосед этого владельца).
   *  Нужно, чтобы фронт наступал сплошной линией, не прыгая вглубь врага. */
  touchesOwner(index: number, ownerId: number): boolean;
}

/**
 * Направленная волна атаки.
 *
 * Идея: заливка (flood fill), где кандидаты на захват лежат
 * в приоритетной очереди по расстоянию до точки клика. За тик волна
 * забирает до WAVE_SPEED ближайших к цели клеток — поэтому фронт
 * «течёт» в сторону клика и естественно огибает чужую территорию,
 * если на неё не хватает войск.
 *
 * Жизненный цикл: создаётся с бюджетом войск (уже списанным с баланса),
 * тикает, пока есть войска и досягаемые клетки, затем возвращает
 * неизрасходованный остаток обратно в баланс (см. Simulation).
 */
export class AttackWave {
  /** Оставшийся бюджет войск. */
  troops: number;

  private readonly frontier = new MinHeap();
  /** depth[index] = номер кольца от исходной границы; undefined = не в очереди. */
  private readonly depth = new Map<number, number>();
  /** Клетка высадки десанта (для корабельной волны): ей разрешён захват
   *  без примыкания к своей территории — это первый плацдарм. */
  private beachhead = -1;
  private readonly targetX: number;
  private readonly targetY: number;

  constructor(
    readonly playerId: number,
    troops: number,
    targetIndex: number,
    /** Кого атакуем: конкретный вражеский ID или NEUTRAL (экспансия).
     *  Волна захватывает ТОЛЬКО клетки этого владельца. */
    private readonly targetOwner: number,
  ) {
    this.troops = troops;
    this.targetX = targetIndex % MAP_WIDTH;
    this.targetY = Math.floor(targetIndex / MAP_WIDTH);
  }

  /** Засеивает очередь клетками цели, примыкающими к границе атакующего. */
  seed(ctx: WaveContext, ownedCells: Iterable<number>): void {
    for (const cell of ownedCells) {
      for (const neighbor of ctx.neighborsOf(cell)) {
        this.enqueue(ctx, neighbor, 0);
      }
    }
  }

  /**
   * Посев волны от клетки высадки десанта (для кораблей).
   *
   * У игрока ещё нет территории на дальнем берегу, поэтому обычный seed
   * (от своих клеток) не сработал бы. Здесь мы засеиваем саму клетку-цель:
   * десант образует «плацдарм». Клетка высадки принудительно ставится в
   * очередь с нулевой глубиной, а дальше волна растекается обычным образом.
   */
  seedFromBeach(ctx: WaveContext, beachCell: number): void {
    // Клетка высадки — цель того же владельца, что и targetOwner.
    // Ставим её напрямую (в обход проверки примыкания к своей территории:
    // это первый плацдарм, примыкать ещё не к чему).
    this.beachhead = beachCell;
    this.enqueue(ctx, beachCell, 0);
  }

  /**
   * Один тик волны. Возвращает true, если волна ещё жива.
   *
   * Владелец клетки перепроверяется В МОМЕНТ захвата: пока клетка ждала
   * в очереди, её мог занять или отбить кто-то другой.
   */
  tick(ctx: WaveContext): boolean {
    let budget = WAVE_SPEED_CELLS_PER_TICK;
    const deferred: number[] = [];
    // Предохранитель: за один тик достаём из очереди не больше, чем в ней
    // есть на входе. Иначе отложенные клетки, которые мы возвращаем, могли
    // бы бесконечно крутиться в этом же цикле.
    let guard = this.frontier.size;

    while (budget > 0 && this.troops > 0 && guard-- > 0) {
      const index = this.frontier.pop();
      if (index === undefined) break; // в очереди пусто

      if (ctx.ownerOf(index) !== this.targetOwner) continue;

      if (!ctx.touchesOwner(index, this.playerId) && index !== this.beachhead) {
        deferred.push(index);
        continue;
      }

      const cost = ctx.costOf(index);
      // Клетка временно неприступна (Infinity) — пропускаем, не умирая.
      if (!Number.isFinite(cost)) {
        continue;
      }
      // Не хватает войск на захват — волна выдохлась, останавливаемся.
      if (this.troops < cost) {
        this.frontier.push(index, this.priorityOf(index));
        this.requeue(deferred);
        return false;
      }

      // Армия тратится 1:1 на стоимость клетки. Преобладающая армия сносит
      // территорию полностью, слабая — выдыхается. Захват отнимает войска и
      // у защитника (внутри captureCell) — это истощает обе стороны в бою,
      // и граница не мерцает: чтобы отбить, нужна армия, а не «бесплатный» откат.
      this.troops -= cost;
      ctx.captureCell(index, this.playerId, 0);
      budget--;

      const childDepth = this.depth.get(index)! + 1;
      for (const neighbor of ctx.neighborsOf(index)) {
        this.enqueue(ctx, neighbor, childDepth);
      }
    }

    this.requeue(deferred);
    return this.frontier.size > 0 && this.troops > 0;
  }

  /** Возвращает отложенные клетки обратно в очередь с их приоритетом. */
  private requeue(cells: number[]): void {
    for (const index of cells) {
      this.frontier.push(index, this.priorityOf(index));
    }
  }

  /** Приоритет клетки = её глубина + направленность к точке клика. */
  private priorityOf(index: number): number {
    const depth = this.depth.get(index) ?? 0;
    const dx = (index % MAP_WIDTH) - this.targetX;
    const dy = Math.floor(index / MAP_WIDTH) - this.targetY;
    return depth + WAVE_DIRECTION_BIAS * Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Ставит клетку в очередь, если она принадлежит цели и ещё не в очереди.
   * Приоритет = глубина + bias × расстояние до точки клика (гибрид:
   * направленность сохранена, но захват ограничен владельцем-целью).
   */
  private enqueue(ctx: WaveContext, index: number, depth: number): void {
    if (this.depth.has(index)) return;
    const owner = ctx.ownerOf(index);
    if (owner === WATER) return;          // вода непроходима
    if (owner !== this.targetOwner) return; // чужой цели не трогаем

    this.depth.set(index, depth);
    const dx = (index % MAP_WIDTH) - this.targetX;
    const dy = Math.floor(index / MAP_WIDTH) - this.targetY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    this.frontier.push(index, depth + WAVE_DIRECTION_BIAS * distance);
  }
}
