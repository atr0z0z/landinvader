import {
  BOT_COUNT,
  BOT_DECISION_INTERVAL,
  BOT_DECISION_JITTER,
  BOT_MIN_TROOPS_TO_ACT,
  BOT_RATIO_NEUTRAL,
  BOT_RATIO_ENEMY,
  BOT_NAMES,
  PLAYER_COLORS,
  type PlayerInfo,
} from '@game/shared';
import type { Simulation } from './Simulation';

/**
 * Контроллер ботов.
 *
 * Бот для симуляции — обычный игрок: спавнится, растёт и атакует через тот
 * же Simulation.attack(), что и человек. Разница лишь в том, что решения за
 * него принимает этот «мозг». Для клиента бот неотличим от игрока — ещё одна
 * цветная территория с именем.
 *
 * Поведение (средний уровень): раз в ~1.5 сек бот осматривается и решает —
 * добить слабого соседа, расшириться в нейтраль, или копить войска.
 */

interface Bot {
  id: number;
  info: PlayerInfo;
  /** Через сколько тиков примет следующее решение (счётчик). */
  cooldown: number;
}

export class BotController {
  private readonly bots = new Map<number, Bot>();

  constructor(
    private readonly simulation: Simulation,
    /** Выдаёт следующий свободный ID игрока (общий счётчик с людьми). */
    private readonly allocateId: () => number,
    /** Сообщить серверу о новом боте, чтобы он разослал его как игрока. */
    private readonly onBotSpawned: (info: PlayerInfo) => void,
    /** Сообщить об уходе бота (для рассылки playerLeft). */
    private readonly onBotRemoved: (id: number) => void,
  ) {}

  /** Число живых ботов. */
  get count(): number {
    return this.bots.size;
  }

  /** Вызывается каждый тик: боты думают по своим таймерам. */
  tick(): void {
    for (const bot of this.bots.values()) {
      if (!this.simulation.isAlive(bot.id)) continue;
      if (--bot.cooldown > 0) continue;
      bot.cooldown = this.nextCooldown();
      this.decide(bot);
    }
  }

  isBot(id: number): boolean {
    return this.bots.has(id);
  }

  infos(): PlayerInfo[] {
    return [...this.bots.values()].map((b) => b.info);
  }

  /** Спавнит одного бота (для постепенной досадки в лобби). */
  spawnOne(): void {
    const id = this.allocateId();
    if (!this.simulation.addPlayer(id)) return; // карта переполнена

    const info: PlayerInfo = {
      id,
      name: BOT_NAMES[this.nameCounter++ % BOT_NAMES.length]!,
      color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]!,
    };
    this.bots.set(id, { id, info, cooldown: this.nextCooldown() });
    this.onBotSpawned(info);
  }

  // ─────────────────────────── Внутренности ───────────────────────────

  private nameCounter = 0;

  private nextCooldown(): number {
    const jitter = Math.floor((Math.random() * 2 - 1) * BOT_DECISION_JITTER);
    return Math.max(1, BOT_DECISION_INTERVAL + jitter);
  }

  /**
   * Одно решение бота.
   * Приоритет: добить выгодного соседа → расшириться в нейтраль → копить.
   */
  private decide(bot: Bot): void {
    const troops = this.simulation.troopsOf(bot.id);
    if (troops < BOT_MIN_TROOPS_TO_ACT) return; // копим

    const { neutral, enemies } = this.simulation.scout(bot.id);

    // 1. ПРИОРИТЕТ — расширение в нейтраль. Захватывать пустую землю
    //    существенно дешевле, чем воевать, поэтому пока рядом есть
    //    нейтраль, бот расширяется в неё (как игрок в Territorial.io).
    //    Атака на соседей — только когда расширяться уже некуда.
    if (neutral.length > 0) {
      const target = neutral[Math.floor(Math.random() * neutral.length)]!;
      this.simulation.attack(bot.id, target, BOT_RATIO_NEUTRAL);
      return;
    }

    // 2. Нейтрали рядом нет — territory зажата соседями. Теперь ищем
    //    самого выгодного (слабого) вражеского соседа для атаки.
    let bestEnemy: { cell: number; score: number } | null = null;
    for (const e of enemies.values()) {
      const density = e.territory > 0 ? e.troops / e.territory : 0;
      const score = troops - density * 40;
      if (score > 0 && (!bestEnemy || score > bestEnemy.score)) {
        bestEnemy = { cell: e.sampleCell, score };
      }
    }

    if (bestEnemy) {
      this.simulation.attack(bot.id, bestEnemy.cell, BOT_RATIO_ENEMY);
      return;
    }

    // 3. Совсем некуда идти — копим до следующего раза.
  }
}
