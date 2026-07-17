# Деплой LandInvader.io на VPS — пошагово

Инструкция для новичка. Каждый шаг — команды можно копировать. Если что-то
непонятно или выдаёт ошибку — присылай вывод, разберёмся вместе.

---

## Что нам понадобится

1. **VPS** (виртуальный сервер) — арендуем.
2. **Домен** (адрес сайта) — покупаем/привязываем.
3. **~30-40 минут** на настройку.

Итоговая стоимость: VPS ~5$/мес + домен ~1-15$/год.

---

## ШАГ 1. Арендовать VPS

Рекомендую **Hetzner** (дёшево, надёжно) или **Timeweb** (на русском, проще оплата из РФ).

Параметры минимальной машины (хватит на сотни игроков):
- **ОС:** Ubuntu 24.04 LTS
- **RAM:** 2 ГБ (можно 1 ГБ для старта)
- **CPU:** 1-2 ядра
- **Диск:** 20+ ГБ

После оплаты хостинг пришлёт:
- **IP-адрес** сервера (например, `203.0.113.45`)
- **root-пароль** (или ты задашь свой SSH-ключ)

Запиши IP — он нужен дальше.

---

## ШАГ 2. Купить домен и направить на сервер

1. Купи домен у регистратора (Namecheap, reg.ru, Porkbun).
2. В настройках DNS домена создай **A-запись**:
   - Тип: `A`
   - Имя: `@` (или `www`)
   - Значение: **IP твоего VPS**
   - TTL: оставь по умолчанию

DNS обновляется от 5 минут до нескольких часов. Проверить можно так (с
своего компьютера):
```
ping твойдомен.com
```
Если отвечает IP твоего сервера — DNS готов.

---

## ШАГ 3. Подключиться к серверу по SSH

С своего компьютера (Windows — через PowerShell или PuTTY; Mac/Linux — терминал):
```
ssh root@203.0.113.45
```
(подставь свой IP). Введи пароль. Ты внутри сервера.

---

## ШАГ 4. Установить нужные программы

Скопируй и выполни по очереди:

```bash
# Обновить систему
apt update && apt upgrade -y

# Установить Node.js 20 (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Проверить, что установилось
node --version   # должно показать v20.x

# Установить Caddy (reverse-proxy с авто-HTTPS)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy

# Установить git
apt install -y git
```

---

## ШАГ 5. Загрузить проект на сервер

Есть два пути. Проще — через git (если зальёшь проект на GitHub). Или
напрямую скопировать архив.

**Вариант через архив** (если проект у тебя локально zip-ом):
С своего компьютера (не из SSH!):
```
scp territory.zip root@203.0.113.45:/root/
```
Потом в SSH на сервере:
```bash
cd /root
apt install -y unzip
unzip territory.zip
cd territory
```

**Вариант через git** (если проект на GitHub):
```bash
cd /root
git clone https://github.com/твой-аккаунт/territory.git
cd territory
```

---

## ШАГ 6. Собрать и запустить

```bash
# Установить зависимости
npm install

# Собрать клиент
npm run build

# Проверить, что сервер запускается (тестовый запуск)
PORT=8080 npm run start
```

Если увидел `Сервер запущен на порту 8080` — всё работает. Нажми `Ctrl+C`,
чтобы остановить (сейчас настроим постоянный запуск).

---

## ШАГ 7. Сделать так, чтобы сервер работал всегда (systemd)

Создай файл службы:
```bash
nano /etc/systemd/system/landinvader.service
```
Вставь (Ctrl+Shift+V), подставив свой путь если отличается:
```ini
[Unit]
Description=LandInvader game server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/territory
Environment=PORT=8080
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```
Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`.

Запусти службу:
```bash
systemctl daemon-reload
systemctl enable landinvader
systemctl start landinvader

# Проверить статус
systemctl status landinvader
```
Должно быть `active (running)`. Сервер теперь работает и сам перезапустится
при сбое или перезагрузке.

---

## ШАГ 8. Настроить Caddy (HTTPS + домен)

Открой конфиг Caddy:
```bash
nano /etc/caddy/Caddyfile
```
Удали всё, что там есть, и вставь (подставь свой домен):
```
твойдомен.com {
    reverse_proxy localhost:8080
}
```
Сохрани (`Ctrl+O`, `Enter`, `Ctrl+X`) и перезапусти Caddy:
```bash
systemctl restart caddy
```

Caddy **сам** получит HTTPS-сертификат от Let's Encrypt (это занимает ~30
секунд при первом запросе). Проверить:
```bash
systemctl status caddy
```

---

## ШАГ 9. Открыть в браузере

Зайди на `https://твойдомен.com` — должно открыться меню игры, работать
подключение и мультиплеер.

Проверь мультиплеер: открой сайт с двух устройств/вкладок, введи разные
ники — вы должны попасть в одну комнату.

---

## Обновление игры в будущем

Когда я пришлю новую версию:
```bash
cd /root/territory
# (заменить файлы: git pull, или залить новый архив)
npm install
npm run build
systemctl restart landinvader
```

---

## Если что-то не работает — диагностика

```bash
# Логи игрового сервера
journalctl -u landinvader -n 50 --no-pager

# Логи Caddy (HTTPS/домен)
journalctl -u caddy -n 50 --no-pager

# Проверить, слушает ли сервер порт
ss -tlnp | grep 8080
```
Присылай вывод этих команд, если застрянешь — помогу разобраться.

---

## Безопасность (базовое, después первого запуска)

```bash
# Файрвол: разрешить только SSH, HTTP, HTTPS
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable
```
