import type { ClientMessage, ServerMessage } from '@game/shared';

/**
 * Тонкая типизированная обёртка над WebSocket.
 *
 * Задача — чтобы остальной код клиента работал с типами протокола,
 * а не с сырыми строками. Когда перейдём на бинарный протокол,
 * поменяется только этот файл.
 */
export class Connection {
  private socket: WebSocket | null = null;

  /** Обработчик входящих сообщений — назначается снаружи. */
  onMessage: (message: ServerMessage) => void = () => {};
  onClose: () => void = () => {};

  connect(url: string): void {
    this.socket = new WebSocket(url);

    this.socket.onmessage = (event) => {
      // Доверяем серверу форму сообщения — он наш. Валидацию по схеме
      // добавим, когда протокол стабилизируется.
      this.onMessage(JSON.parse(event.data as string) as ServerMessage);
    };

    this.socket.onclose = () => this.onClose();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

/** Декодирует base64-снапшот карты обратно в Uint16Array.
 *  Порядок байтов: и сервер, и клиент у нас little-endian (x86/ARM),
 *  поэтому просто накладываем Uint16Array на полученные байты. */
export function decodeMapSnapshot(base64: string): Uint16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Uint16Array(bytes.buffer);
}
