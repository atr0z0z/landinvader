import type { PlayerInfo } from './types';
import type { RoomPhase } from './constants';

/**
 * Сетевой протокол.
 *
 * Сейчас это JSON — его можно читать глазами во вкладке Network в DevTools,
 * что бесценно на этапе обучения и отладки. Когда ядро заработает,
 * заменим на бинарный формат (это отдельная итерация; типы останутся те же,
 * поменяется только слой кодирования).
 *
 * Каждое сообщение — объект с полем `type` (discriminated union):
 * TypeScript автоматически сужает тип внутри switch/case по этому полю.
 */

// ─────────────────────────── Сервер → Клиент ───────────────────────────

/** Первое сообщение после подключения: кто ты и полное состояние мира. */
export interface InitMessage {
  type: 'init';
  /** ID, выданный этому клиенту. */
  playerId: number;
  players: PlayerInfo[];
  /** Снапшот карты: Uint16Array владельцев, закодированный в base64. */
  map: string;
  /** Вырез мировой карты (в долях 0..1) — для показа фона-картинки:
   *  x, size — по ширине; y, sizeY — по высоте. */
  crop: { x: number; y: number; size: number; sizeY: number };
}

/** Изменившиеся за тик клетки.
 *  Плоский массив пар: [индекс, владелец, индекс, владелец, ...] */
export interface DiffMessage {
  type: 'diff';
  cells: number[];
}

export interface PlayerJoinedMessage {
  type: 'playerJoined';
  player: PlayerInfo;
}

export interface PlayerLeftMessage {
  type: 'playerLeft';
  playerId: number;
}

/** Персональная статистика — отправляется каждому клиенту раз в тик. */
export interface StatsMessage {
  type: 'stats';
  troops: number;
  territory: number;
}

/** Состояние лобби (фаза ожидания/отсчёта). Обновляется при изменениях. */
export interface LobbyMessage {
  type: 'lobby';
  phase: RoomPhase;
  /** Сколько игроков (люди + боты) в комнате и вместимость. */
  players: number;
  capacity: number;
  /** Сколько именно людей (для интереса). */
  humans: number;
  /** Если phase === 'countdown' — сколько мс осталось до старта. */
  countdownMs?: number;
}

/** Игра началась — клиент переключается из лобби в игровой экран.
 *  Следом придёт init со снапшотом карты. */
export interface GameStartMessage {
  type: 'gameStart';
}

/** Состояние одного корабля в полёте (для анимации на клиенте). */
export interface ShipState {
  id: number;
  owner: number;
  /** Текущая позиция в координатах клеток (дробная — для плавности). */
  x: number;
  y: number;
}

/** Активные корабли — шлётся каждый тик, пока есть хоть один в полёте. */
export interface ShipsMessage {
  type: 'ships';
  ships: ShipState[];
}

/** Ответ на попытку запуска корабля. ok=false → клиент покажет причину. */
export interface ShipResultMessage {
  type: 'shipResult';
  ok: boolean;
  /** Причина отказа для показа игроку (если ok=false). */
  reason?: string;
}

export type ServerMessage =
  | InitMessage
  | DiffMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | StatsMessage
  | LobbyMessage
  | GameStartMessage
  | ShipsMessage
  | ShipResultMessage;

// ─────────────────────────── Клиент → Сервер ───────────────────────────

export type AttackMessage = {
  type: 'attack';
  /** Индекс клетки-цели (y * MAP_WIDTH + x). */
  target: number;
  /** Доля баланса, отправляемая в атаку (0..1). Сервер валидирует. */
  ratio: number;
};

/** Вход в игру: игрок нажал Play. name пустой → сервер выдаст Player#. */
export interface JoinMessage {
  type: 'join';
  name: string;
}

/** Запуск корабля (флоу Territorial): игрок кликает цель `to`, сервер сам
 *  находит ближайший берег игрока для старта. */
export interface LaunchShipMessage {
  type: 'launchShip';
  to: number;
  ratio: number;
}

export type ClientMessage = AttackMessage | JoinMessage | LaunchShipMessage;
