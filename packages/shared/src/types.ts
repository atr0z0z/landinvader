/** Публичная информация об игроке, известная всем клиентам. */
export interface PlayerInfo {
  /** Уникальный ID. Он же записывается в клетки карты как «владелец». */
  id: number;
  name: string;
  /** Цвет в формате 0xRRGGBB. */
  color: number;
}
