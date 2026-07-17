import {
  ROOM_CAPACITY,
  ROOM_START_THRESHOLD,
  COUNTDOWN_MS,
  BOT_FILL_INTERVAL_MS,
  TICK_INTERVAL_MS,
  PLAYER_COLORS,
  type PlayerInfo,
  type RoomPhase,
  type ServerMessage,
} from '@game/shared';
import { Simulation } from './Simulation';
import { BotController } from './BotController';

/**
 * Одна игровая комната с машиной состояний: waiting → countdown → playing.
 *
 * Room НЕ знает про WebSocket — она общается с внешним миром через колбэки
 * (send/broadcast). Благодаря этому одна и та же логика работает и в
 * локальном тесте, и в реальном мультиплеере: сетевой слой лишь
 * подключает транспорт. RoomManager создаёт комнаты и роутит в них игроков.
 *
 * Лобби-логика (по согласованному дизайну):
 *  - в waiting каждые BOT_FILL_INTERVAL досаживается бот, пока игроков
 *    (люди+боты) меньше порога старта (ROOM_START_THRESHOLD от вместимости);
 *  - как только игроков ≥ порога → переход в countdown (COUNTDOWN_MS);
 *  - если за отсчёт лобби заполнилось до 100% → старт немедленно;
 *  - по истечении отсчёта → playing; после этого комната закрыта для новых.
 */

interface Human {
  id: number;
  info: PlayerInfo;
  /** Транспорт-специфичная отправка (сеть/локально). */
  send: (msg: ServerMessage) => void;
}

const START_THRESHOLD_COUNT = Math.ceil(ROOM_CAPACITY * ROOM_START_THRESHOLD);

export class Room {
  readonly id: number;
  phase: RoomPhase = 'waiting';

  private readonly simulation = new Simulation();
  private readonly bots: BotController;
  private readonly humans = new Map<number, Human>();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private botFillAccum = 0;   // мс с последней досадки бота
  private countdownRemaining = 0; // мс до старта (в countdown)

  constructor(
    id: number,
    /** Общий аллокатор ID игроков (людей и ботов) на весь сервер. */
    private readonly allocateId: () => number,
    /** Вызывается, когда комната перешла в playing (менеджер откроет новую). */
    private readonly onStarted: (room: Room) => void,
  ) {
    this.id = id;
    this.bots = new BotController(
      this.simulation,
      allocateId,
      (info) => this.broadcast({ type: 'playerJoined', player: info }),
      (botId) => this.broadcast({ type: 'playerLeft', playerId: botId }),
    );
    // Комната сразу «живёт»: тикаем таймер, обрабатываем лобби и симуляцию.
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Принимает ли комната новых людей (только в фазе ожидания/отсчёта). */
  get isOpen(): boolean {
    return this.phase !== 'playing' && this.playerCount < ROOM_CAPACITY;
  }

  get playerCount(): number {
    return this.humans.size + this.bots.count;
  }

  // ─────────────────────── Жизненный цикл игрока ───────────────────────

  /**
   * Добавляет человека. Возвращает его игровую сущность или null, если
   * комната закрыта/полна. name пустой → сервер присвоит Player#id.
   */
  addHuman(name: string, send: (msg: ServerMessage) => void): Human | null {
    if (!this.isOpen) return null;
    const id = this.allocateId();
    if (!this.simulation.addPlayer(id)) return null;

    const info: PlayerInfo = {
      id,
      name: name.trim() || `Player ${id}`,
      color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]!,
    };
    const human: Human = { id, info, send };
    this.humans.set(id, human);

    // Новичку — снапшот и все игроки; остальным — факт появления.
    send({
      type: 'init',
      playerId: id,
      players: this.allPlayerInfos(),
      map: Buffer.from(this.simulation.grid.buffer).toString('base64'),
      crop: this.simulation.crop,
    });
    this.broadcast({ type: 'playerJoined', player: info }, id);

    this.broadcastLobby();
    return human;
  }

  removeHuman(id: number): void {
    if (!this.humans.delete(id)) return;
    this.simulation.removePlayer(id);
    this.broadcast({ type: 'playerLeft', playerId: id });
    this.broadcastLobby();
  }

  handleAttack(id: number, target: number, ratio: number): void {
    // Атаки принимаем только в игре.
    if (this.phase !== 'playing') return;
    if (!this.humans.has(id)) return;
    this.simulation.attack(id, target, ratio);
  }

  handleLaunchShip(id: number, to: number, ratio: number): void {
    if (this.phase !== 'playing') return;
    const human = this.humans.get(id);
    if (!human) return;
    const result = this.simulation.launchShip(id, to, ratio);
    human.send({ type: 'shipResult', ok: result.ok, reason: result.reason });
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  // ─────────────────────────── Игровой цикл ───────────────────────────

  private tick(): void {
    switch (this.phase) {
      case 'waiting':
        this.tickWaiting();
        break;
      case 'countdown':
        this.tickCountdown();
        break;
      case 'playing':
        this.tickPlaying();
        break;
    }
  }

  private tickWaiting(): void {
    // Досаживаем ботов по таймеру, пока не достигнут порог старта.
    this.botFillAccum += TICK_INTERVAL_MS;
    if (this.botFillAccum >= BOT_FILL_INTERVAL_MS) {
      this.botFillAccum = 0;
      if (this.playerCount < START_THRESHOLD_COUNT) {
        this.bots.spawnOne();
        this.broadcastLobby();
      }
    }
    // Достигли порога → запускаем отсчёт.
    if (this.playerCount >= START_THRESHOLD_COUNT) {
      this.phase = 'countdown';
      this.countdownRemaining = COUNTDOWN_MS;
      this.broadcastLobby();
    }
    // Симуляция в ожидании тоже идёт (боты растут, карта живёт).
    this.stepSimulation();
  }

  private tickCountdown(): void {
    this.countdownRemaining -= TICK_INTERVAL_MS;
    // Лобби заполнилось полностью — старт немедленно.
    if (this.playerCount >= ROOM_CAPACITY || this.countdownRemaining <= 0) {
      this.startGame();
      return;
    }
    // Во время отсчёта продолжаем досаживать ботов до полного заполнения,
    // чтобы к старту комната была живой (по желанию — можно убрать).
    this.botFillAccum += TICK_INTERVAL_MS;
    if (this.botFillAccum >= BOT_FILL_INTERVAL_MS) {
      this.botFillAccum = 0;
      if (this.playerCount < ROOM_CAPACITY) {
        this.bots.spawnOne();
        this.broadcastLobby();
      }
    }
    this.stepSimulation();
    // Раз в ~секунду обновляем клиентам оставшееся время.
    if (Math.round(this.countdownRemaining / TICK_INTERVAL_MS) % 10 === 0) {
      this.broadcastLobby();
    }
  }

  private tickPlaying(): void {
    this.bots.tick();
    this.stepSimulation();
    // Состояние кораблей в полёте — для анимации на клиенте.
    if (this.simulation.hasShips()) {
      this.broadcast({ type: 'ships', ships: this.simulation.shipStates() });
    }
    // Персональная статистика людям.
    for (const human of this.humans.values()) {
      human.send({ type: 'stats', ...this.simulation.getStats(human.id) });
    }
  }

  /** Общий шаг симуляции + рассылка диффов карты. */
  private stepSimulation(): void {
    this.simulation.tick();
    const cells = this.simulation.consumeChanges();
    if (cells.length > 0) this.broadcast({ type: 'diff', cells });
  }

  private startGame(): void {
    this.phase = 'playing';
    this.broadcast({ type: 'gameStart' });
    this.broadcastLobby();
    this.onStarted(this); // менеджер откроет новую комнату для новичков
  }

  // ─────────────────────────── Рассылка ───────────────────────────

  private allPlayerInfos(): PlayerInfo[] {
    return [...this.humans.values()].map((h) => h.info).concat(this.bots.infos());
  }

  private broadcast(msg: ServerMessage, excludeId?: number): void {
    for (const [id, human] of this.humans) {
      if (id !== excludeId) human.send(msg);
    }
  }

  private broadcastLobby(): void {
    const msg: ServerMessage = {
      type: 'lobby',
      phase: this.phase,
      players: this.playerCount,
      capacity: ROOM_CAPACITY,
      humans: this.humans.size,
      countdownMs: this.phase === 'countdown' ? Math.max(0, this.countdownRemaining) : undefined,
    };
    this.broadcast(msg);
  }
}
