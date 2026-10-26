# Тест на аудиофила

Слепой квиз: пользователь слушает два 30-секундных отрывка одного трека и выбирает
верное утверждение — lossless первый, второй, оба или ни одного (оба AAC).

Перед началом теста пользователь выбирает уровень сложности — битрейт пережатых отрывков:
**лёгкий** — AAC 32 kbps, **средний** — 128 kbps, **сложный** — 320 kbps. Лимит попыток общий
для всех уровней; незавершённая попытка продолжается на своём уровне.

- **API** — Go (`net/http`, pgx), фронтенд встроен в бинарник (`web/static`, без сборки).
- **БД** — PostgreSQL: пользователи, сессии, треки, попытки и ответы.
- **Аудио** — ffmpeg внутри контейнера; готовые FLAC лежат в volume `/data`.
- **Вход** — через Google. Без входа можно пройти только лёгкий уровень как гость: гостя узнают по
  сессионной cookie (в БД — запись в `users` без `google_sub` и с пустым email). При входе через
  Google завершённые попытки гостя переносятся в аккаунт.
- **Лимит** — 10 попыток за скользящие 24 часа (`ATTEMPTS_PER_DAY`), на попытку — 5 случайных треков на лёгком уровне и 12 на среднем и сложном (`store.Difficulties`; если треков меньше — берутся все активные).
  Игрокам лимит не показывается: они узнают о нём, только когда попытки закончились.

## Аудио-пайплайн

При загрузке в админке (`/admin`):

```
исходник (FLAC/WAV/ALAC/AIFF/WavPack) ──cut──▶ lossless.flac
                                       ├──▶ AAC 32k  (.m4a) ──decode──▶ encoded_32k.flac
                                       ├──▶ AAC 128k (.m4a) ──decode──▶ encoded_128k.flac
                                       └──▶ AAC 320k (.m4a) ──decode──▶ encoded_320k.flac
```

- Нарезка по сэмплам (`atrim`), AAC кодируется из **того же** отрезка, задержка энкодера
  компенсируется edit list в MP4 — версии выровнены сэмпл-в-сэмпл.
- Все FLAC: исходные sample rate, число каналов и разрядность (16/24 бит), ровно
  `30 × sample_rate` сэмплов, метаданные вычищены (`-bitexact`), одинаковые заголовки.
  Lossless-отрывок пережимается во FLAC без потерь — сэмплы бит-в-бит как в исходнике.
- Битрейт FLAC зависит от содержимого, поэтому после AAC файл выходит другого размера.
  Все четыре файла дополняются блоком PADDING до байта одного размера, а плеер скачивает
  оба отрывка целиком (общий индикатор загрузки) и только потом даёт их слушать — по
  размеру, времени загрузки и скорости буферизации версии не различить.
- Float-исходники и разрядность больше 24 бит отклоняются (FLAC/браузеры их не держат).
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
| `ATTEMPTS_PER_DAY` | `10` | скрыт от игроков |
| `CLIP_SECONDS` | `30` | |
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
- Аудио: volume `audio` (`/data/audio/<id>/lossless.flac`, `encoded_{32k,128k,320k}.flac`)

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
