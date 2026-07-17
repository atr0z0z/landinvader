import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@game/shared';
import { RoomManager } from './RoomManager';
import type { Room } from './Room';

/**
 * Сетевой слой. Тонкий транспорт поверх RoomManager:
 *  - принимает WebSocket-соединения;
 *  - ждёт от клиента 'join' (с ником), затем помещает его в комнату;
 *  - роутит атаки в комнату игрока;
 *  - сериализует сообщения.
 *
 * Всю игровую логику и лобби держат Room / RoomManager. GameServer не знает
 * правил игры и не гоняет тик — тики внутри комнат. Благодаря тому, что
 * комнаты общаются через колбэк send(), эта же архитектура работает и для
 * локального теста, и для реального мультиплеера.
 */

interface Connection {
  socket: WebSocket;
  /** Комната и ID игрока — появляются после успешного join. */
  room: Room | null;
  playerId: number | null;
}

export class GameServer {
  private readonly manager = new RoomManager();
  private readonly connections = new Set<Connection>();

  constructor(wss: WebSocketServer) {
    wss.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: WebSocket): void {
    const conn: Connection = { socket, room: null, playerId: null };
    this.connections.add(conn);

    socket.on('message', (data) => this.onMessage(conn, data.toString()));
    socket.on('close', () => this.onClose(conn));
    socket.on('error', (err) => console.error('[!] Ошибка сокета:', err.message));
  }

  private onMessage(conn: Connection, raw: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      return; // битый JSON молча игнорируем
    }

    switch (message.type) {
      case 'join':
        this.handleJoin(conn, typeof message.name === 'string' ? message.name : '');
        break;

      case 'attack':
        if (
          conn.room &&
          conn.playerId !== null &&
          typeof message.target === 'number' &&
          typeof message.ratio === 'number'
        ) {
          conn.room.handleAttack(conn.playerId, message.target, message.ratio);
        }
        break;

      case 'launchShip':
        if (
          conn.room &&
          conn.playerId !== null &&
          typeof message.to === 'number' &&
          typeof message.ratio === 'number'
        ) {
          conn.room.handleLaunchShip(conn.playerId, message.to, message.ratio);
        }
        break;
    }
  }

  /** Клиент нажал Play — помещаем его в открытую комнату. */
  private handleJoin(conn: Connection, name: string): void {
    if (conn.room) return; // уже в игре — повторный join игнорируем

    const send = (msg: ServerMessage): void => this.send(conn.socket, msg);
    const result = this.manager.join(name, send);
    if (!result) {
      conn.socket.close(1013, 'Не удалось войти, попробуйте снова');
      return;
    }
    conn.room = result.room;
    conn.playerId = result.id;
    console.log(`[+] игрок ${result.id} вошёл в комнату ${result.room.id}`);
  }

  private onClose(conn: Connection): void {
    this.connections.delete(conn);
    if (conn.room && conn.playerId !== null) {
      conn.room.removeHuman(conn.playerId);
      console.log(`[-] игрок ${conn.playerId} покинул комнату ${conn.room.id}`);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
