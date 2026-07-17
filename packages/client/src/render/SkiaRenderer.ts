import type { CanvasKit, Surface, Canvas as SkCanvas, Image as SkImage } from 'canvaskit-wasm';
import { MAP_WIDTH, MAP_HEIGHT, WATER, NEUTRAL, PLAYER_COLORS } from '@game/shared';
import { buildContours, chaikin } from './contours';

/**
 * Рендер карты через Skia (CanvasKit).
 *
 * Каждый кадр-перестройку:
 *   1. из сетки владения строим контуры территорий (marching-squares);
 *   2. сглаживаем Chaikin-алгоритмом;
 *   3. рисуем настоящими путями Skia: фон-градиент → нейтральная суша →
 *      для каждого игрока glow (размытие) → заливка с градиентом → обводка.
 *
 * Всё сглаживание, свечение и градиенты — родные примитивы Skia, а не
 * костыли поверх текстуры. Отсюда «сочность», недостижимая на Pixi.
 *
 * Перестройка по изменению карты, не каждый кадр (contour tracing тяжёлый).
 */

const SKIP_PLAYERS = new Set<number>([WATER, NEUTRAL]); // территории игроков
const CHAIKIN = 3;
const MIN_LOOP_POINTS = 12;

export class SkiaRenderer {
  private readonly surface: Surface;
  private readonly canvas: SkCanvas;
  private grid: Uint16Array | null = null;
  private width: number;
  private height: number;

  /** Фон — картинка мира; crop — какой её кусок показывать (доли 0..1). */
  private worldBg: SkImage | null = null;
  private crop: { x: number; y: number; size: number; sizeY: number } | null = null;

  /** Имена игроков (id → имя) для подписей на территориях. */
  private readonly names = new Map<number, string>();
  /** Армия каждого игрока (id→troops) для очков под ником. */
  private armies = new Map<number, number>();
  /** Шрифт для подписей (грузится асинхронно). */
  private font: import('canvaskit-wasm').Font | null = null;
  /** Корабли в полёте (обновляются с сервера) для отрисовки мигающих точек. */
  private ships: { id: number; owner: number; x: number; y: number }[] = [];

  constructor(
    private readonly ck: CanvasKit,
    private readonly htmlCanvas: HTMLCanvasElement,
  ) {
    this.width = htmlCanvas.width;
    this.height = htmlCanvas.height;
    const surface = ck.MakeWebGLCanvasSurface(htmlCanvas);
    if (!surface) throw new Error('Не удалось создать Skia WebGL surface');
    this.surface = surface;
    this.canvas = this.surface.getCanvas();
  }

  /** Загружает фон-картинку мира из байтов (JPEG/PNG). */
  loadBackground(bytes: ArrayBuffer): void {
    const img = this.ck.MakeImageFromEncoded(new Uint8Array(bytes));
    if (img) this.worldBg = img;
  }

  /** Обновляет список кораблей в полёте. */
  setShips(ships: { id: number; owner: number; x: number; y: number }[]): void {
    this.ships = ships;
  }

  /** Запоминает имя игрока для подписи на его территории. */
  setPlayerName(id: number, name: string): void {
    this.names.set(id, name);
  }

  /** Обновляет армии игроков (для очков под ником). */
  setArmies(armies: Map<number, number>): void {
    this.armies = armies;
  }

  /** Загружает шрифт для подписей из байтов (TTF). */
  loadFont(bytes: ArrayBuffer): void {
    const tf = this.ck.Typeface.MakeFreeTypeFaceFromData(bytes);
    if (tf) this.font = new this.ck.Font(tf, 13);
  }

  /** Устанавливает вырез мировой карты для показа фона. */
  setCrop(crop: { x: number; y: number; size: number; sizeY: number }): void {
    this.crop = crop;
  }

  setGrid(grid: Uint16Array): void {
    this.grid = grid;
  }

  /** Перерисовывает всю сцену. Вызывать при изменении карты. */
  render(): void {
    if (!this.grid) return;
    const ck = this.ck;
    const canvas = this.canvas;

    // Масштаб: вписываем карту в холст с сохранением пропорций.
    const scale = Math.min(this.width / MAP_WIDTH, this.height / MAP_HEIGHT);
    const offX = (this.width - MAP_WIDTH * scale) / 2;
    const offY = (this.height - MAP_HEIGHT * scale) / 2;

    // Фон: вырез мировой карты-картинки. Тот же кусок мира, что в симуляции,
    // поэтому континенты фона точно под территориями игроков.
    if (this.worldBg && this.crop) {
      const imgW = this.worldBg.width();
      const imgH = this.worldBg.height();
      // Вырез: X и ширина — в долях ширины фона; Y и высота — в долях высоты.
      const srcX = this.crop.x * imgW;
      const srcY = this.crop.y * imgH;
      const srcW = this.crop.size * imgW;
      const srcH = this.crop.sizeY * imgH;
      const src = ck.LTRBRect(srcX, srcY, srcX + srcW, srcY + srcH);
      // Куда рисуем: вписанная в холст квадратная область карты.
      const scale = Math.min(this.width / MAP_WIDTH, this.height / MAP_HEIGHT);
      const dstX = (this.width - MAP_WIDTH * scale) / 2;
      const dstY = (this.height - MAP_HEIGHT * scale) / 2;
      const dst = ck.LTRBRect(dstX, dstY, dstX + MAP_WIDTH * scale, dstY + MAP_HEIGHT * scale);
      // Фон за пределами карты — тёмный.
      canvas.clear(ck.Color(12, 14, 22, 1));
      const imgPaint = new ck.Paint();
      canvas.drawImageRect(this.worldBg, src, dst, imgPaint);
      imgPaint.delete();
    } else {
      // Пока фон не загружен — тёмная заливка.
      canvas.clear(ck.Color(12, 14, 22, 1));
    }

    const toPath = (loop: number[]) => {
      const s = chaikin(loop, CHAIKIN);
      const cmds = [ck.MOVE_VERB, s[0]! * scale + offX, s[1]! * scale + offY];
      for (let i = 1; i < s.length / 2; i++) {
        cmds.push(ck.LINE_VERB, s[i * 2]! * scale + offX, s[i * 2 + 1]! * scale + offY);
      }
      cmds.push(ck.CLOSE_VERB);
      return ck.Path.MakeFromCmds(cmds);
    };

    // Нейтральную сушу НЕ заливаем — её показывает фон-картинка мира.
    // Рисуем только территории игроков поверх.

    // Территории игроков: glow → заливка-градиент → обводка.
    for (const { owner, loops } of buildContours(this.grid, SKIP_PLAYERS)) {
      const c = PLAYER_COLORS[(owner - 1) % PLAYER_COLORS.length]!;
      const cr = (c >> 16) & 0xff, cg = (c >> 8) & 0xff, cb = c & 0xff;
      const col = ck.Color(cr, cg, cb, 1);

      for (const loop of loops) {
        if (loop.length / 2 < MIN_LOOP_POINTS) continue;
        const path = toPath(loop);
        if (!path) continue;

        // Свечение — размытая копия того же цвета.
        const glow = new ck.Paint();
        glow.setAntiAlias(true);
        glow.setColor(col);
        glow.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, 10 * scale / 3, false));
        canvas.drawPath(path, glow);

        // Заливка с вертикальным градиентом (светлее сверху).
        const b = path.getBounds();
        const top = b[1] ?? 0;
        const bottom = b[3] ?? 0;
        const grad = ck.Shader.MakeLinearGradient(
          [0, top], [0, bottom],
          [ck.Color(Math.min(255, cr + 30), Math.min(255, cg + 30), Math.min(255, cb + 30), 1), col],
          [0, 1], ck.TileMode.Clamp,
        );
        const fill = new ck.Paint();
        fill.setAntiAlias(true);
        fill.setShader(grad);
        canvas.drawPath(path, fill);

        // Тонкая яркая обводка.
        const stroke = new ck.Paint();
        stroke.setAntiAlias(true);
        stroke.setStyle(ck.PaintStyle.Stroke);
        stroke.setStrokeWidth(1.5);
        stroke.setColor(ck.Color(Math.min(255, cr + 60), Math.min(255, cg + 60), Math.min(255, cb + 60), 0.9));
        canvas.drawPath(path, stroke);

        path.delete();
        glow.delete();
        fill.delete();
        stroke.delete();
      }
    }

    // ── Подписи с никами в центре территории каждого игрока ──
    if (this.font) {
      // Центроид (среднее клеток) и размер территории каждого владельца.
      const sumX = new Map<number, number>();
      const sumY = new Map<number, number>();
      const count = new Map<number, number>();
      for (let i = 0; i < this.grid.length; i++) {
        const o = this.grid[i]!;
        if (o === WATER || o === NEUTRAL) continue;
        const x = i % MAP_WIDTH;
        const y = (i - x) / MAP_WIDTH;
        sumX.set(o, (sumX.get(o) ?? 0) + x);
        sumY.set(o, (sumY.get(o) ?? 0) + y);
        count.set(o, (count.get(o) ?? 0) + 1);
      }

      const textPaint = new ck.Paint();
      textPaint.setColor(ck.Color(255, 255, 255, 0.95));
      textPaint.setAntiAlias(true);
      const shadowPaint = new ck.Paint();
      shadowPaint.setColor(ck.Color(0, 0, 0, 0.6));
      shadowPaint.setAntiAlias(true);

      for (const [owner, n] of count) {
        if (n < 40) continue; // мелким территориям подпись не рисуем
        const name = this.names.get(owner);
        if (!name) continue;
        const cx = (sumX.get(owner)! / n) * scale + offX;
        const cy = (sumY.get(owner)! / n) * scale + offY;
        // Центрируем текст по ширине.
        const ids = this.font.getGlyphIDs(name);
        const widths = this.font.getGlyphWidths(ids, textPaint);
        let w = 0;
        for (const gw of widths) w += gw;
        const tx = cx - w / 2;
        // Тень под текстом + сам текст (имя).
        canvas.drawText(name, tx + 1, cy + 1, shadowPaint, this.font);
        canvas.drawText(name, tx, cy, textPaint, this.font);

        // Очки (армия) под именем — строкой ниже, по центру.
        const army = this.armies.get(owner);
        if (army !== undefined) {
          const armyStr = String(army);
          const aids = this.font.getGlyphIDs(armyStr);
          const awidths = this.font.getGlyphWidths(aids, textPaint);
          let aw = 0;
          for (const gw of awidths) aw += gw;
          const atx = cx - aw / 2;
          const aty = cy + 14; // строка ниже имени
          canvas.drawText(armyStr, atx + 1, aty + 1, shadowPaint, this.font);
          canvas.drawText(armyStr, atx, aty, textPaint, this.font);
        }
      }
      textPaint.delete();
      shadowPaint.delete();
    }

    // ── Корабли: мигающие точки с цветом владельца ──
    if (this.ships.length > 0) {
      // Мигание: прозрачность колеблется по синусоиде от времени.
      const blink = 0.5 + 0.5 * Math.sin(Date.now() / 200);
      for (const ship of this.ships) {
        const c = PLAYER_COLORS[(ship.owner - 1) % PLAYER_COLORS.length]!;
        const cr = (c >> 16) & 0xff, cg = (c >> 8) & 0xff, cb = c & 0xff;
        const px = ship.x * scale + offX;
        const py = ship.y * scale + offY;
        const r = Math.max(3, scale * 0.7);

        // Свечение (размытая точка), пульсирует ярче на пике мигания.
        const glow = new ck.Paint();
        glow.setColor(ck.Color(cr, cg, cb, 0.5 + 0.4 * blink));
        glow.setAntiAlias(true);
        glow.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, r * 1.5, false));
        canvas.drawCircle(px, py, r, glow);

        // Ядро точки — ярче, с тем же миганием.
        const core = new ck.Paint();
        core.setColor(ck.Color(Math.min(255, cr + 40), Math.min(255, cg + 40), Math.min(255, cb + 40), 0.6 + 0.4 * blink));
        core.setAntiAlias(true);
        canvas.drawCircle(px, py, r * 0.6, core);

        glow.delete();
        core.delete();
      }
    }

    this.surface.flush();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** Экранные координаты → индекс клетки (для кликов). */
  screenToCell(screenX: number, screenY: number): number | null {
    const scale = Math.min(this.width / MAP_WIDTH, this.height / MAP_HEIGHT);
    const offX = (this.width - MAP_WIDTH * scale) / 2;
    const offY = (this.height - MAP_HEIGHT * scale) / 2;
    const cx = Math.floor((screenX - offX) / scale);
    const cy = Math.floor((screenY - offY) / scale);
    if (cx < 0 || cy < 0 || cx >= MAP_WIDTH || cy >= MAP_HEIGHT) return null;
    return cy * MAP_WIDTH + cx;
  }
}
