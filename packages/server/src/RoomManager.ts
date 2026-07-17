import type { PlayerInfo, ServerMessage } from '@game/shared';
import { Room } from './Room';

/**
 * Менеджер комнат.
 *
 * Держит одну «активную» (открытую) комнату, куда попадают новые игроки.
 * Когда активная комната стартует игру (переходит в playing), менеджер
 * создаёт свежую открытую комнату — так поддерживается «одна постоянно
 * работающая комната приёма», как в задаче.
 *
 * Уже игравшие комнаты продолжают жить в playing, пока в них есть люди;
 * когда последний человек уходит — комната утилизируется.
 *
 * Аллокатор ID — глобальный на весь сервер, общий для людей и ботов всех
 * комнат: ID игрока уникален в пределах процесса. (Для настоящего
 * распределённого мультиплеера позже это станет ID с префиксом узла, но
 * интерфейс останется тем же.)
 *
 * RoomManager не знает про WebSocket: комнаты общаются через колбэки,
 * поэтому та же архитектура годится и для локального теста, и для сети.
 */
export class RoomManager {
  private readonly rooms = new Map<number, Room>();
  private activeRoom: Room;
  private nextRoomId = 1;
  private nextPlayerId = 1; // 0 зарезервирован под NEUTRAL

  constructor() {
    this.activeRoom = this.createRoom();
  }

  /**
   * Добавляет человека в текущую открытую комнату.
   * Возвращает комнату и ID игрока (или null, если по какой-то причине
   * не удалось — например, комната мгновенно закрылась).
   */
  join(
    name: string,
    send: (msg: ServerMessage) => void,
  ): { room: Room; id: number } | null {
    // Если активная комната вдруг закрыта (заполнилась/стартовала между
    // тиками) — гарантируем новую открытую.
    if (!this.activeRoom.isOpen) {
      this.activeRoom = this.createRoom();
    }
    const human = this.activeRoom.addHuman(name, send);
    if (!human) return null;
    return { room: this.activeRoom, id: human.id };
  }

  private createRoom(): Room {
    const room = new Room(
      this.nextRoomId++,
      () => this.nextPlayerId++,
      (started) => this.onRoomStarted(started),
    );
    this.rooms.set(room.id, room);
    return room;
  }

  /** Комната стартовала игру → нужна новая открытая для приёма новичков. */
  private onRoomStarted(started: Room): void {
    if (this.activeRoom === started) {
      this.activeRoom = this.createRoom();
    }
  }

  /** Утилизирует пустую сыгранную комнату (вызывать, когда ушёл последний). */
  disposeRoom(room: Room): void {
    if (room === this.activeRoom) return; // активную не трогаем
    room.dispose();
    this.rooms.delete(room.id);
  }
}
