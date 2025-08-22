# Мониторинг линий

Простой сервер и веб-интерфейс для отслеживания 13 производственных линий.

## Запуск
```
npm install
npm start
```
Сайт доступен на http://localhost:3000

## Вход

Перейдите на `/login.html`. Логин: `admin`, пароль: `admin`.

## Отправка данных от ESP32
Пример запроса:
```
curl -X POST http://localhost:3000/data \
  -H "Content-Type: application/json" \
  -d '{"lineId":"line1","pulses":20,"duration":10000,"ts":1692922200000}'
```
## API
- `POST /data` — приём пакетов.
- `GET /status` — статус линий (требует аутентификацию).

Настройки по умолчанию хранятся в `config.json`.
