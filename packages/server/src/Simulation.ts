import {
  MAP_WIDTH,
  MAP_HEIGHT,
  NEUTRAL,
  WATER,
  SPAWN_RADIUS,
  START_TROOPS,
  BASE_INCOME_PER_TICK,
  INCOME_PER_CELL,
  TROOPS_CAP_BASE,
  TROOPS_CAP_PER_CELL,
  BASE_CELL_COST,
  ENEMY_DEFENSE_K,
  MIN_ENEMY_CELL_COST,
  SHIP_MIN_TROOPS,
  MIN_ATTACK_RATIO,
  MAX_ACTIVE_WAVES,
} from '@game/shared';
import { AttackWave, type WaveContext } from './AttackWave';
import { Ship } from './Ship';
import { findSeaPathToNearestShore } from './seaPath';
import { generateWorldMap } from './worldMap';

/** Серверное состояние игрока (не путать с публичным PlayerInfo). */
interface PlayerState {
  troops: number;
  territory: number;
}

/**
 * Авторитетная симуляция мира. Единственное место, где меняется карта.
 *
 * Состоит из трёх подсистем:
 *  - карта владения (`grid`, Uint16Array) + бухгалтерия территорий;
 *  - экономика: прирост войск от территории, потолок баланса;
 *  - волны атак (AttackWave) — вся экспансия идёт только через них.
 *
 * `changed` копит изменившиеся клетки между опросами — из них
 * GameServer собирает диффы для рассылки.
 */
export class Simulation implements WaveContext {
  readonly grid: Uint16Array;

  /** Клетки суши крупных материков — кандидаты под спавн (от генератора). */
  private readonly spawnable: number[];

  /** Координаты выреза мировой карты (в долях) — клиент показывает
   *  соответствующий кусок фона-картинки. */
  readonly crop: { x: number; y: number; size: number; sizeY: number };

  private readonly players = new Map<number, PlayerState>();
  private waves: AttackWave[] = [];
  private ships: Ship[] = [];
  private readonly changed = new Map<number, number>(); // индекс → новый владелец

  /** Сила удержания каждой клетки — сколько войск нужно вложить, чтобы её
   *  отбить. Ядро механики линии фронта: клетка переходит к врагу, только
   *  если атака ПРЕВЫШАЕТ эту силу; отбить назад можно лишь снова пробив
   *  установленную оборону. Поэтому граница движется в сторону слабейшего
   *  и НЕ мерцает — обратный захват требует реального превосходства, а не
   *  происходит каждый тик. Для нейтрали/воды = 0. */
  private readonly defense: Float32Array;

  constructor() {
    // Реальная карта мира: случайный квадратный вырез при каждой партии.
    const map = generateWorldMap();
    this.grid = map.grid;
    this.spawnable = map.spawnable;
    this.crop = map.crop;
    this.defense = new Float32Array(this.grid.length);
  }

  // ────────────────────────── Публичный API ──────────────────────────

  /** Пытается заспавнить игрока. Возвращает false, если не нашлось места. */
  addPlayer(playerId: number): boolean {
    this.players.set(playerId, { troops: START_TROOPS, territory: 0 });
    return this.spawn(playerId);
  }

  /** Убирает игрока: территория растворяется, волны отменяются. */
  removePlayer(playerId: number): void {
    this.players.delete(playerId);
    this.waves = this.waves.filter((w) => w.playerId !== playerId);
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === playerId) this.setCell(i, NEUTRAL);
    }
  }

  /**
   * Приказ атаки от игрока. Сервер ничему не верит: клэмпит долю,
   * проверяет цель и лимит волн. Молча игнорирует мусор — читер не должен
   * получать подсказок, что именно отфильтровано.
   *
   * Гибридная модель: клетка клика задаёт И направление (волна тяготеет
   * к ней), И цель — владельца этой клетки. Волна захватывает только
   * клетки того же владельца: клик по врагу = атака на врага,
   * клик по нейтрали = экспансия.
   */
  attack(playerId: number, targetIndex: number, ratio: number): void {
    const player = this.players.get(playerId);
    if (!player || player.territory === 0) return;
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.grid.length) return;

    const targetOwner = this.grid[targetIndex]!;
    if (targetOwner === playerId || targetOwner === WATER) return; // своя земля / вода — не цель
    if (this.waves.filter((w) => w.playerId === playerId).length >= MAX_ACTIVE_WAVES) return;

    const clamped = Math.min(1, Math.max(MIN_ATTACK_RATIO, ratio));
    const committed = Math.floor(player.troops * clamped);
    if (committed < 1) return;

    player.troops -= committed;

    const wave = new AttackWave(playerId, committed, targetIndex, targetOwner);
    wave.seed(this, this.cellsOf(playerId));
    this.waves.push(wave);
  }

  /**
   * Запуск корабля (флоу Territorial): игрок кликает ЦЕЛЬ `to`, корабль сам
   * стартует от ближайшего по морю берега игрока. Единый пул: списываем долю
   * армии, корабль везёт её и высаживает как волну. Возвращает результат.
   */
  launchShip(playerId: number, to: number, ratio: number): { ok: boolean; reason?: string } {
    const player = this.players.get(playerId);
    if (!player || player.territory === 0) return { ok: false, reason: 'Нет территории' };
    if (!this.validIndex(to)) return { ok: false, reason: 'Неверная клетка' };
    const targetOwner = this.grid[to]!;
    if (targetOwner === playerId) return { ok: false, reason: 'Это ваша территория' };
    if (targetOwner === WATER) return { ok: false, reason: 'Цель — вода' };

    // Ищем ближайший по морю берег игрока и путь оттуда к цели.
    const route = findSeaPathToNearestShore(this.grid, to, playerId);
    if (!route || route.path.length < 1) return { ok: false, reason: 'До цели не доплыть по воде' };

    const clamped = Math.min(1, Math.max(MIN_ATTACK_RATIO, ratio));
    const committed = Math.floor(player.troops * clamped);
    if (committed < SHIP_MIN_TROOPS) return { ok: false, reason: 'Мало войск для корабля' };

    player.troops -= committed;
    this.ships.push(new Ship(playerId, committed, route.path, to));
    return { ok: true };
  }

  private validIndex(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.grid.length;
  }

  /** Снимок кораблей в полёте для рассылки клиентам (анимация). */
  shipStates(): { id: number; owner: number; x: number; y: number }[] {
    return this.ships.map((s, idx) => {
      const p = s.position;
      return { id: idx, owner: s.playerId, x: p.x, y: p.y };
    });
  }

  /** Один шаг мира: экономика, затем волны. */
  tick(): void {
    // 1. Экономика: прирост пропорционален территории, с потолком.
    for (const player of this.players.values()) {
      if (player.territory === 0) continue;
      const income = BASE_INCOME_PER_TICK + player.territory * INCOME_PER_CELL;
      const cap = TROOPS_CAP_BASE + player.territory * TROOPS_CAP_PER_CELL;
      player.troops = Math.min(cap, player.troops + income);
    }

    // 2. Волны. Умершая волна возвращает неистраченный остаток в баланс —
    //    прощающая механика: «не дотянулся» не значит «потерял всё».
    this.waves = this.waves.filter((wave) => {
      const alive = wave.tick(this);
      if (!alive && wave.troops > 0) {
        const owner = this.players.get(wave.playerId);
        if (owner) owner.troops += wave.troops;
      }
      return alive;
    });

    // 3. Корабли. Двигаем; прибывший высаживает десант как волну атаки.
    //    Единый пул: везённые войска становятся волной на дальнем берегу,
    //    дальше — обычный захват. Никакой отдельной анклавной экономики.
    this.ships = this.ships.filter((ship) => {
      const stillSailing = ship.advance();
      if (stillSailing) return true;

      // Прибыл: высаживаем волну по цели, если она ещё атакуема.
      const targetOwner = this.grid[ship.targetLand]!;
      if (targetOwner !== ship.playerId && targetOwner !== WATER) {
        const wave = new AttackWave(ship.playerId, ship.troops, ship.targetLand, targetOwner);
        // Десант «плацдарма»: сеем волну от клетки высадки, даже если у
        // игрока там ещё нет территории — иначе первый заморский захват
        // невозможен. Сеем от самой цели и её соседей.
        wave.seedFromBeach(this, ship.targetLand);
        this.waves.push(wave);
      } else {
        // Цель уже наша/стала водой — возвращаем войска владельцу.
        const owner = this.players.get(ship.playerId);
        if (owner) owner.troops += ship.troops;
      }
      return false;
    });
  }

  /** Есть ли активные корабли (для решения, слать ли их состояние). */
  hasShips(): boolean {
    return this.ships.length > 0;
  }

  getStats(playerId: number): { troops: number; territory: number } {
    const player = this.players.get(playerId);
    return player
      ? { troops: Math.floor(player.troops), territory: player.territory }
      : { troops: 0, territory: 0 };
  }

  /** Забирает накопленные изменения как плоский массив [индекс, владелец, ...]. */
  consumeChanges(): number[] {
    if (this.changed.size === 0) return [];
    const flat: number[] = [];
    for (const [index, owner] of this.changed) flat.push(index, owner);
    this.changed.clear();
    return flat;
  }

  // ──────────────────── Реализация WaveContext ────────────────────

  ownerOf(index: number): number {
    return this.grid[index]!;
  }

  /**
   * Стоимость захвата клетки в войсках.
   *   нейтральная суша → BASE (дёшево, это экспансия);
   *   вражеская клетка → BASE + K × плотность_обороны защитника,
   *     где плотность = армия / территория.
   *
   * Итог: плотно обороняющийся игрок дорог в захвате, а большая пустая
   * империя — дёшева. Стоимость считается «на лету», поэтому по мере того
   * как защитник теряет территорию (плотность растёт) или тратит армию
   * на свои атаки (плотность падает), цена его земли динамически меняется.
   */
  costOf(index: number): number {
    const owner = this.grid[index]!;
    if (owner === NEUTRAL) return BASE_CELL_COST;

    // Стоимость захвата вражеской клетки = её сила удержания + база.
    // Клетка перейдёт, только если у волны хватит войск ПРОБИТЬ эту
    // оборону. Обратный захват потребует снова пробить уже новую оборону,
    // поэтому граница не мерцает.
    return BASE_CELL_COST + this.defense[index]!;
  }

  /** Захват клетки волной: смена владельца + бухгалтерия + элиминация.
   *  holdStrength — сколько войск волна «оставляет» в клетке как её новую
   *  силу удержания (оборону). Чем сильнее волна, тем крепче закреплён фронт. */
  captureCell(index: number, attackerId: number, holdStrength = 0): void {
    const previousOwner = this.grid[index]!;
    this.setCell(index, attackerId);
    this.defense[index] = holdStrength; // новая оборона клетки

    const attacker = this.players.get(attackerId);
    if (attacker) attacker.territory++;

    if (previousOwner !== NEUTRAL) {
      const defender = this.players.get(previousOwner);
      if (defender) {
        defender.territory--;
        if (defender.territory <= 0) this.eliminate(previousOwner);
      }
    }
  }

  /** 4 соседа клетки (фон Нейман) с учётом краёв карты. */
  *neighborsOf(index: number): Generator<number> {
    const x = index % MAP_WIDTH;
    const y = (index - x) / MAP_WIDTH;
    if (x > 0) yield index - 1;
    if (x < MAP_WIDTH - 1) yield index + 1;
    if (y > 0) yield index - MAP_WIDTH;
    if (y < MAP_HEIGHT - 1) yield index + MAP_WIDTH;
  }

  /** Примыкает ли клетка к территории игрока (есть сосед этого владельца).
   *  Основа механики сплошного фронта: волна берёт только примыкающие. */
  touchesOwner(index: number, ownerId: number): boolean {
    const x = index % MAP_WIDTH;
    const y = (index - x) / MAP_WIDTH;
    if (x > 0 && this.grid[index - 1] === ownerId) return true;
    if (x < MAP_WIDTH - 1 && this.grid[index + 1] === ownerId) return true;
    if (y > 0 && this.grid[index - MAP_WIDTH] === ownerId) return true;
    if (y < MAP_HEIGHT - 1 && this.grid[index + MAP_WIDTH] === ownerId) return true;
    return false;
  }

  /**
   * «Осмотр» для ИИ бота: находит, с кем граничит территория игрока.
   * Возвращает по одной примыкающей клетке каждого соседа (цель для клика)
   * и признак — нейтраль это или другой игрок с его балансом войск.
   *
   * Один проход по карте: для каждой клетки игрока смотрим 4 соседей;
   * если сосед другого владельца (не вода) — запоминаем как цель.
   */
  scout(playerId: number): {
    neutral: number[];              // индексы примыкающих нейтральных клеток
    enemies: Map<number, { sampleCell: number; troops: number; territory: number }>;
  } {
    const neutral: number[] = [];
    const enemies = new Map<number, { sampleCell: number; troops: number; territory: number }>();
    const seenNeutral = new Set<number>();

    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] !== playerId) continue;
      const x = i % MAP_WIDTH;
      const y = (i - x) / MAP_WIDTH;
      const check = (ni: number): void => {
        const o = this.grid[ni]!;
        if (o === playerId || o === WATER) return;
        if (o === NEUTRAL) {
          if (!seenNeutral.has(ni)) {
            seenNeutral.add(ni);
            neutral.push(ni);
          }
        } else if (!enemies.has(o)) {
          const st = this.players.get(o);
          enemies.set(o, {
            sampleCell: ni,
            troops: st ? Math.floor(st.troops) : 0,
            territory: st ? st.territory : 0,
          });
        }
      };
      if (x > 0) check(i - 1);
      if (x < MAP_WIDTH - 1) check(i + 1);
      if (y > 0) check(i - MAP_WIDTH);
      if (y < MAP_HEIGHT - 1) check(i + MAP_WIDTH);
    }
    return { neutral, enemies };
  }

  /** Баланс войск игрока (для ИИ). */
  troopsOf(playerId: number): number {
    const st = this.players.get(playerId);
    return st ? Math.floor(st.troops) : 0;
  }

  /** Жив ли игрок (есть территория). */
  isAlive(playerId: number): boolean {
    const st = this.players.get(playerId);
    return !!st && st.territory > 0;
  }

  // ─────────────────────────── Внутренности ───────────────────────────

  private setCell(index: number, owner: number): void {
    this.grid[index] = owner;
    this.changed.set(index, owner);
  }

  /** Потеря всей территории: волны отменяются, свежий респавн с базой.
   *  MVP-решение; позже здесь появится экран смерти и выбор точки. */
  private eliminate(playerId: number): void {
    this.waves = this.waves.filter((w) => w.playerId !== playerId);
    const player = this.players.get(playerId);
    if (!player) return;
    player.troops = START_TROOPS;
    player.territory = 0;
    this.spawn(playerId);
  }

  private spawn(playerId: number): boolean {
    const spot = this.findSpawnPoint();
    if (spot === null) return false;
    this.claimDisc(spot.x, spot.y, SPAWN_RADIUS, playerId);
    return true;
  }

  /** Все клетки игрока. O(карта) — вызывается только при старте атаки,
   *  не каждый тик. На 256×256 это мгновенно; на больших картах
   *  заменим на поддерживаемый индекс границы. */
  private *cellsOf(playerId: number): Generator<number> {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === playerId) yield i;
    }
  }

  private claimDisc(cx: number, cy: number, r: number, playerId: number): void {
    const player = this.players.get(playerId);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) continue;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;
        this.setCell(y * MAP_WIDTH + x, playerId);
        if (player) player.territory++;
      }
    }
  }

  private findSpawnPoint(): { x: number; y: number } | null {
    // Пробуем случайные клетки из списка пригодной суши. Кандидат годится,
    // если весь его стартовый диск — свободная суша (не вода, не чужой).
    for (let attempt = 0; attempt < 300; attempt++) {
      const index = this.spawnable[(Math.random() * this.spawnable.length) | 0]!;
      const x = index % MAP_WIDTH;
      const y = (index - x) / MAP_WIDTH;
      if (this.isDiscFreeLand(x, y, SPAWN_RADIUS + 1)) return { x, y };
    }
    return null; // не нашлось свободного места — карта плотно занята
  }

  /** Весь диск — свободная (нейтральная) суша: ни воды, ни чужих клеток. */
  private isDiscFreeLand(cx: number, cy: number, r: number): boolean {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return false;
        if (this.grid[y * MAP_WIDTH + x] !== NEUTRAL) return false;
      }
    }
    return true;
  }
}
