# business-sites-bot

Telegram bot для visual-review пайплайна [Shebovich/business-sites](https://github.com/Shebovich/business-sites).

Вынесен из основного репозитория сайтов: бот = оркестратор, репо сайтов = artifacts.
Связь между ними — через GitHub REST API (issues / contents / workflow_dispatch)
и GitHub webhook (Issues events → push в TG).

## Структура

```
api/
├── bot/
│   ├── webhook.mjs       — TG webhook entrypoint (Vercel function)
│   └── diag.mjs          — диагностика
└── github-webhook.mjs    — приёмник GH events (issues → push в TG)

scripts/bot/
├── config.mjs            — shared constants (GITHUB_REPO, LABELS, SECTIONS, env)
├── dev.mjs               — long-polling dev runner
├── set-webhook.mjs       — регистрация TG webhook
├── set-commands.mjs      — setMyCommands
├── pull-env.mjs          — vercel env pull → .env
├── clear-task.mjs        — Redis state cleanup
├── backfill-issue-meta.mjs
└── lib/                  — handlers, state, github/tg API, etc.
```

## Запуск

См. [BOT_SETUP.md](./BOT_SETUP.md) — полный гайд с токенами, env vars,
регистрацией webhooks и тестированием локально.

Коротко:

```bash
npm install
cp .env.example .env   # заполнить токены
npm run dev            # long-polling, без деплоя
```

## Деплой

Бот — Vercel-проект, два serverless function'а:

- `POST /api/bot/webhook` — TG updates
- `POST /api/github-webhook` — GH Issues events

```bash
vercel --prod --yes
```

## Связь с репо сайтов

Целевой репо настраивается через env `GITHUB_REPO` (дефолт `Shebovich/business-sites`).
Что бот делает с репо сайтов:

1. Читает issues с лейблами `needs-visual-review` / `awaiting-claude-process` / etc.
2. Пишет `_data/{slug}/visual_review_input.json` через `PUT /repos/.../contents`.
3. Меняет лейблы (`needs-visual-review` → `awaiting-claude-process` → `built`).
4. Опционально триггерит workflow `visual-review.yml` (dormant fallback —
   primary executor сейчас — локальный skill `process-tg-tasks` в репо сайтов).

State пользователя (выбранная задача, собранные фото, тексты) — Upstash Redis,
владелец схемы — этот репо. Помощники чтения state (`clear-task.mjs`,
`pull-env.mjs`) дублируются в репо сайтов для использования из skill'а — если
будут расходиться, вынесем в общий npm-пакет.
