# Тест на аудиофила

Слепой квиз: пользователь слушает два 30-секундных отрывка одного трека и выбирает
верное утверждение — lossless первый, второй, оба или ни одного (оба AAC 128 kbps).

- **API** — Go (`net/http`, pgx), фронтенд встроен в бинарник (`web/static`, без сборки).
- **БД** — PostgreSQL: пользователи, сессии, треки, попытки и ответы.
- **Аудио** — ffmpeg внутри контейнера; готовые WAV лежат в volume `/data`.
- **Вход** — только через Google; без входа квиз недоступен.
- **Лимит** — 3 попытки за скользящие 7 дней (`ATTEMPTS_PER_WEEK`), 12 случайных треков на попытку.

## Аудио-пайплайн

При загрузке в админке (`/admin`):

```
исходник (FLAC/WAV/ALAC/AIFF/WavPack) ──cut──▶ lossless.wav
                                       └──▶ AAC 128k (.m4a) ──decode──▶ encoded.wav
```

- Нарезка по сэмплам (`atrim`), AAC кодируется из **того же** отрезка, задержка энкодера
  компенсируется edit list в MP4 — версии выровнены сэмпл-в-сэмпл.
- Оба WAV: исходные sample rate, число каналов и разрядность (16/24/32 бит), ровно
  `30 × sample_rate` сэмплов, метаданные вычищены (`-bitexact`) → файлы одного размера с
  одинаковыми заголовками. Если размеры не совпали, загрузка отклоняется.
- Источники выше 96 кГц кодируются в AAC на 48 кГц (предел AAC-энкодера) и
  ресемплируются обратно в исходную частоту.
- Lossy-исходники (MP3, AAC, Opus…) отклоняются: «lossless»-эталон из них был бы фальшивым.
- Исходник удаляется сразу после обработки (и при ошибке тоже).

Пользователь получает аудио по одноразовым непрозрачным токенам `/api/audio/{token}`:
по URL, размеру и заголовкам ответа нельзя понять, какая версия играет. Правильные ответы
отдаются только после завершения попытки.

## Запуск

1. Скопируйте `.env.example` в `.env` и заполните.
2. В [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → ваш OAuth
   client → **Authorized redirect URIs** добавьте `BASE_URL/auth/google/callback`
   (например `https://audiophile.example.com/auth/google/callback`, для локального запуска —
   `http://localhost:8080/auth/google/callback`). Пока приложение в статусе *Testing*,
   войти смогут только тестовые пользователи из OAuth consent screen — для публичного
   запуска переведите его в *Production*.
3. `docker compose up -d --build`
4. Откройте `BASE_URL/admin`, войдите аккаунтом из `ADMIN_EMAILS`, загрузите треки.

Вместо `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` можно смонтировать JSON из Google
Console и указать путь в `GOOGLE_CREDENTIALS_FILE`.

### Переменные окружения

| Переменная | По умолчанию | |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | публичный адрес; при `https://` cookie ставятся с `Secure` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | OAuth client |
| `ADMIN_EMAILS` | — | через запятую; доступ в `/admin` |
| `POSTGRES_PASSWORD` | — | пароль БД для compose |
| `DATABASE_URL` | задаётся в compose | если используете внешний Postgres |
| `APP_PORT` | `8080` | порт на хосте |
| `DB_PORT` | `5432` | порт Postgres на хосте, только `127.0.0.1` (для DBeaver/psql) |
| `ATTEMPTS_PER_WEEK` | `3` | |
| `QUESTIONS_PER_QUIZ` | `12` | если треков меньше — берутся все активные |
| `CLIP_SECONDS` | `30` | |
| `AAC_BITRATE` | `128k` | |
| `MAX_UPLOAD_MB` | `1024` | |

### Развёртывание на сервере

Скопируйте каталог проекта (без `data/`) и `.env` на сервер и выполните
`docker compose up -d --build`. Либо соберите образ локально и перенесите:

```sh
docker build -t audiophile-quiz:latest .
docker save audiophile-quiz:latest | ssh server docker load
```

За обратным прокси (nginx, Caddy) терминируйте HTTPS и увеличьте лимит тела запроса
для загрузки исходников, например в nginx: `client_max_body_size 1g;` и
`proxy_read_timeout 600s;` (обработка идёт синхронно в запросе).

### Доступ к базе (DBeaver, psql)

Postgres слушает `127.0.0.1:${DB_PORT:-5432}`: база `audiophile`, пользователь `audiophile`,
пароль — `POSTGRES_PASSWORD` из `.env`. Снаружи порт закрыт; на сервере подключайтесь
через SSH-туннель (в DBeaver: вкладка SSH в настройках соединения, или
`ssh -L 5432:127.0.0.1:5432 server`).

### Бэкапы

- База: `docker compose exec db pg_dump -U audiophile audiophile > backup.sql`
- Аудио: volume `audio` (`/data/audio/<id>/lossless.wav`, `encoded.wav`)

## Разработка

```sh
go test ./...        # тесты аудио-пайплайна (нужен ffmpeg)
go run ./cmd/server  # нужны DATABASE_URL, Google-переменные, ADMIN_EMAILS, DATA_DIR
```

```
cmd/server         точка входа
internal/audio     ffprobe/ffmpeg: нарезка, AAC, декодирование
internal/store     PostgreSQL + миграции (internal/store/migrations)
internal/httpapi   маршруты, Google OAuth, сессии, квиз, админка
web/static         HTML/CSS/JS
```

## Персональные данные

Хранятся: Google ID (`sub`), email, имя и URL аватара, а также результаты попыток.
Опубликуйте политику конфиденциальности и укажите её в OAuth consent screen. Если
аудитория — граждане РФ, учтите 152-ФЗ (локализация хранения и уведомление РКН).
