import {
  SERVER_PORT,
  ROOM_CAPACITY,
  MAP_WIDTH,
  MAP_HEIGHT,
  WATER,
  isSeaReachable,
  type PlayerInfo,
  type ServerMessage,
} from '@game/shared';
import { Connection, decodeMapSnapshot } from './network/Connection';
import { loadCanvasKit } from './render/canvaskit';
import { SkiaRenderer } from './render/SkiaRenderer';
import worldBgUrl from './world_bg.jpg?url';
import logoUrl from './logo.png?url';
import fontUrl from './font.ttf?url';

/**
 * Точка входа клиента. Три экрана: меню → лобби (ожидание) → игра.
 * Отрисовка карты — Skia (CanvasKit).
 */
async function main(): Promise<void> {
  // ── Элементы UI ──
  const menu = document.getElementById('menu')!;
  const logo = document.getElementById('logo') as HTMLImageElement;
  logo.src = logoUrl;
  const lobby = document.getElementById('lobby')!;
  const nickname = document.getElementById('nickname') as HTMLInputElement;
  const playBtn = document.getElementById('playBtn')!;

  const lobbyPhase = document.getElementById('lobbyPhase')!;
  const lobbyBar = document.getElementById('lobbyBar')!;
  const lobbyCount = document.getElementById('lobbyCount')!;
  const countdownEl = document.getElementById('countdown')!;

  const status = document.getElementById('status')!;
  const panel = document.getElementById('panel')!;
  const troopsLabel = document.getElementById('troops')!;
  const ratioSlider = document.getElementById('ratio') as HTMLInputElement;
  const ratioLabel = document.getElementById('ratioLabel')!;

  const updateRatioLabel = (): void => {
    ratioLabel.textContent = `${ratioSlider.value}%`;
  };
  ratioSlider.addEventListener('input', updateRatioLabel);
  ratioSlider.addEventListener('change', updateRatioLabel);
  updateRatioLabel(); // начальное значение

  // ── 1. Skia + холст ──
  const ck = await loadCanvasKit();
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  document.body.insertBefore(canvas, document.body.firstChild);

  function sizeCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }
  sizeCanvas();

  const renderer = new SkiaRenderer(ck, canvas);

  fetch(worldBgUrl)
    .then((r) => r.arrayBuffer())
    .then((buf) => { renderer.loadBackground(buf); dirty = true; })
    .catch(() => {/* фон не критичен */});

  // Шрифт для подписей с никами.
  fetch(fontUrl)
    .then((r) => r.arrayBuffer())
    .then((buf) => { renderer.loadFont(buf); dirty = true; })
    .catch(() => {/* без шрифта просто не будет подписей */});

  // ── 2. Состояние ──
  let grid: Uint16Array | null = null;
  let dirty = false;
  let inGame = false;
  let hasShips = false;
  const players = new Map<number, PlayerInfo>();
  let myId = -1;

  window.addEventListener('resize', () => {
    sizeCanvas();
    renderer.resize(canvas.width, canvas.height);
    dirty = true;
  });

  function frame(): void {
    // Пока летят корабли — рисуем каждый кадр (мигание/движение).
    if ((dirty || hasShips) && grid) {
      renderer.render();
      dirty = false;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Лидерборд ──
  const leaderboard = document.getElementById('leaderboard')!;
  const lbList = document.getElementById('lbList')!;

  function playerColorHex(id: number): string {
    // Та же формула, что на сервере и в рендере (owner-1)%N.
    const colors = ['#4ade80', '#22d3ee', '#a78bfa', '#f472b6', '#facc15',
      '#fb923c', '#38bdf8', '#c084fc', '#34d399', '#f87171'];
    return colors[(id - 1) % colors.length]!;
  }

  function updateLeaderboard(entries: { id: number; territory: number }[]): void {
    // Топ-10 по территории.
    const top = [...entries].sort((a, b) => b.territory - a.territory).slice(0, 10);
    lbList.innerHTML = '';
    top.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row' + (e.id === myId ? ' me' : '');
      const name = players.get(e.id)?.name ?? `Player ${e.id}`;
      row.innerHTML =
        `<span class="lb-rank">${i + 1}</span>` +
        `<span class="lb-dot" style="background:${playerColorHex(e.id)}"></span>` +
        `<span class="lb-name">${escapeHtml(name)}</span>` +
        `<span class="lb-terr">${e.territory}</span>`;
      lbList.appendChild(row);
    });
  }

  function escapeHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── 3. Экраны ──
  function showMenu(): void {
    menu.classList.remove('hidden');
    lobby.classList.add('hidden');
    status.classList.add('hidden');
    panel.classList.add('hidden');
    leaderboard.classList.add('hidden');
  }
  function showLobby(): void {
    menu.classList.add('hidden');
    lobby.classList.remove('hidden');
  }
  function showGame(): void {
    lobby.classList.add('hidden');
    status.classList.remove('hidden');
    panel.classList.remove('hidden');
    leaderboard.classList.remove('hidden');
    inGame = true;
  }

  // ── 4. Сеть ──
  const connection = new Connection();

  connection.onMessage = (message: ServerMessage) => {
    switch (message.type) {
      case 'lobby': {
        // Пока идёт лобби — показываем экран ожидания.
        if (!inGame) showLobby();
        const pct = Math.round((message.players / message.capacity) * 100);
        lobbyBar.style.width = `${pct}%`;
        lobbyCount.textContent = `${message.players} / ${message.capacity} игроков`;
        if (message.phase === 'countdown' && message.countdownMs !== undefined) {
          lobbyPhase.textContent = 'Игра начинается';
          countdownEl.style.display = 'block';
          countdownEl.textContent = `${Math.ceil(message.countdownMs / 1000)}`;
        } else {
          lobbyPhase.textContent = 'Ожидание игроков…';
          countdownEl.style.display = 'none';
        }
        break;
      }

      case 'gameStart':
        showGame();
        break;

      case 'init': {
        myId = message.playerId;
        for (const player of message.players) {
          players.set(player.id, player);
          renderer.setPlayerName(player.id, player.name);
        }
        grid = decodeMapSnapshot(message.map);
        renderer.setGrid(grid);
        renderer.setCrop(message.crop);
        dirty = true;
        status.textContent = `Вы — ${players.get(myId)?.name ?? 'Player'} · игроков: ${players.size}`;
        break;
      }

      case 'diff':
        if (!grid) break;
        for (let i = 0; i < message.cells.length; i += 2) {
          grid[message.cells[i]!] = message.cells[i + 1]!;
        }
        dirty = true;
        break;

      case 'playerJoined':
        players.set(message.player.id, message.player);
        renderer.setPlayerName(message.player.id, message.player.name);
        break;

      case 'playerLeft':
        players.delete(message.playerId);
        break;

      case 'stats':
        troopsLabel.textContent = `\u2694 ${message.troops}`;
        break;

      case 'ships':
        renderer.setShips(message.ships);
        hasShips = message.ships.length > 0;
        dirty = true;
        break;

      case 'shipResult':
        if (message.ok) {
          status.textContent = 'Корабль отправлен! ⛵';
        } else {
          status.textContent = `Не удалось: ${message.reason ?? 'нельзя отправить'}`;
        }
        // Через 2.5 сек вернуть обычный статус.
        setTimeout(() => {
          status.textContent = `Вы — ${players.get(myId)?.name ?? 'Player'} · игроков: ${players.size}`;
        }, 2500);
        break;

      case 'scoreboard': {
        // Армия под ником: отдаём рендеру карту id→армия.
        const armies = new Map<number, number>();
        for (const e of message.entries) armies.set(e.id, e.troops);
        renderer.setArmies(armies);
        dirty = true;
        // Лидерборд: топ-10 по территории.
        updateLeaderboard(message.entries);
        break;
      }
    }
  };

  connection.onClose = () => {
    status.textContent = 'Соединение потеряно. Обновите страницу.';
  };

  // Адрес WebSocket. В проде — тот же хост, что и страница, но по wss://
  // (браузер на HTTPS требует защищённый сокет). Локально — ws://localhost.
  // import.meta.env.DEV даёт Vite: true при dev-сервере, false в сборке.
  const wsUrl = import.meta.env.DEV
    ? `ws://localhost:${SERVER_PORT}`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  connection.connect(wsUrl);

  // ── 5. Кнопка Play: входим в игру ──
  function play(): void {
    connection.send({ type: 'join', name: nickname.value });
    // Сразу переключаемся на лобби; сервер пришлёт lobby-состояние.
    showLobby();
    lobbyPhase.textContent = 'Подключение…';
    lobbyCount.textContent = `0 / ${ROOM_CAPACITY} игроков`;
  }
  playBtn.addEventListener('click', play);
  nickname.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') play();
  });

  // ── 6. Клик по карте ──
  // Флоу Territorial: клик по ЛЮБОЙ клетке-цели → меню действий. Кнопка
  // корабля отправляет десант к этой цели (сервер сам найдёт ближайший
  // берег игрока). Обычный клик по врагу/нейтрали без меню — атака.
  const radialMenu = document.getElementById('radialMenu')!;
  const shipBtn = radialMenu.querySelector('[data-action="ship"]') as HTMLButtonElement;

  /** Клетка-цель, выбранная последним кликом (для действий меню). */
  let menuTarget = -1;

  function hideRadial(): void {
    radialMenu.classList.add('hidden');
  }
  function showRadialAt(screenX: number, screenY: number): void {
    radialMenu.style.left = `${screenX}px`;
    radialMenu.style.top = `${screenY}px`;
    radialMenu.classList.remove('hidden');
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!inGame || !grid) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cell = renderer.screenToCell(e.clientX * dpr, e.clientY * dpr);
    if (cell === null) { hideRadial(); return; }

    const owner = grid[cell]!;
    // Клик по своей территории или воде — ничего не делаем, закрываем меню.
    if (owner === myId || owner === WATER) { hideRadial(); return; }

    hideRadial();

    // Если цель за морем (по суше не примыкает к нам, но доплыть можно) —
    // показываем меню с кораблём. Иначе — обычная сухопутная атака.
    // ВАЖНО: обычная атака шлётся на ЛЮБУЮ достижимую по суше цель, включая
    // дальнюю нейтраль — волна сама тянется к точке клика (основная механика).
    const seaOnly = !touchesMyLand(grid, cell, myId) && isSeaReachable(grid, cell, myId);
    if (seaOnly) {
      // Заморская цель: только корабль. Меню у точки клика.
      menuTarget = cell;
      showRadialAt(e.clientX, e.clientY);
    } else {
      // Обычная атака — на любой клик по не-своей клетке (как раньше).
      connection.send({
        type: 'attack',
        target: cell,
        ratio: Number(ratioSlider.value) / 100,
      });
    }
  });

  // Кнопка «Кораблик»: отправляем десант к выбранной цели.
  shipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideRadial();
    if (menuTarget < 0) return;
    connection.send({
      type: 'launchShip',
      to: menuTarget,
      ratio: Number(ratioSlider.value) / 100,
    });
    menuTarget = -1;
  });

  showMenu();
}

void main();

/** Примыкает ли клетка к территории игрока (достижима по суше). */
function touchesMyLand(grid: Uint16Array, cell: number, myId: number): boolean {
  const x = cell % MAP_WIDTH;
  const y = (cell - x) / MAP_WIDTH;
  if (x > 0 && grid[cell - 1] === myId) return true;
  if (x < MAP_WIDTH - 1 && grid[cell + 1] === myId) return true;
  if (y > 0 && grid[cell - MAP_WIDTH] === myId) return true;
  if (y < MAP_HEIGHT - 1 && grid[cell + MAP_WIDTH] === myId) return true;
  return false;
}
