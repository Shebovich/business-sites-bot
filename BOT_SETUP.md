# TG Visual-Review Bot — Setup

M1 foundation готова: webhook handler, state machine, command stubs. Чтобы
поднять бот в живую — выполни шаги ниже. После env-vars + webhook URL весь
запуск занимает <10 минут.

## 1. Получить токены

### TG Bot Token
1. Открой https://t.me/BotFather в Telegram
2. `/newbot` → имя (например `Visual Review Bot`) → username (например `your_review_bot`)
3. Скопируй токен — это `TG_BOT_TOKEN`

### Твой chat_id (TG_OWNER_CHAT_ID)
1. Открой https://t.me/userinfobot в Telegram
2. `/start` → бот пришлёт твой `Id` (целое число)
3. Это `TG_OWNER_CHAT_ID`. Все остальные id бот игнорирует (Q16.5).

### Upstash Redis (для state machine)
1. Регистрация: https://console.upstash.com
2. Create Database → Region `eu-west-1` или ближайший → free tier
3. Вкладка REST → копируй `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`
4. Free tier: 10000 commands/day — нам с запасом.

### GitHub webhook secret
1. Сгенерируй случайную строку: `openssl rand -hex 32` (или любой генератор)
2. Сохрани как `GH_WEBHOOK_SECRET` (понадобится в Vercel env + GitHub Settings)

## 2. Добавить env vars в Vercel

```powershell
# в корне проекта
vercel env add TG_BOT_TOKEN production
vercel env add TG_OWNER_CHAT_ID production
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel env add GH_WEBHOOK_SECRET production
```

При деплое `vercel --prod` подхватит их автоматически.

## 3. Задеплоить webhook handlers

```powershell
vercel --prod --yes
```

После деплоя в логах будет URL типа `https://business-sites-xyz.vercel.app`.
Это твой webhook base URL.

## 4. Зарегистрировать TG webhook

```powershell
$env:TG_BOT_TOKEN = "...твой токен..."
npm run bot:set-webhook -- https://<your-app>.vercel.app/api/bot/webhook
```

Или curl-ом напрямую:
```powershell
curl -X POST "https://api.telegram.org/bot$env:TG_BOT_TOKEN/setWebhook?url=https://<your-app>.vercel.app/api/bot/webhook"
```

Проверь что webhook поставился:
```powershell
curl "https://api.telegram.org/bot$env:TG_BOT_TOKEN/getWebhookInfo"
```

## 5. Зарегистрировать GitHub webhook

1. Repo `Shebovich/business-sites` → Settings → Webhooks → Add webhook
2. Payload URL: `https://<your-app>.vercel.app/api/github-webhook`
3. Content type: `application/json`
4. Secret: `GH_WEBHOOK_SECRET` (та же строка что в Vercel env)
5. Events: `Let me select individual events` → отметить только **Issues**
6. Active → Add webhook

После сохранения GitHub отправит ping event — проверь что в Recent Deliveries
есть `200 OK`. Если 401 — secret не совпадает.

## 6. Тест локально (long polling, без деплоя)

Для итераций по коду:

```powershell
# заполни .env (см. .env.example)
# затем:
npm install
npm run bot:dev
```

Пиши боту в TG → видишь логи в терминале. Long polling работает параллельно
с webhook'ом, но в production оставь только webhook (отзывы быстрее).

## 7. Что сейчас работает (M1)

- `/start` — приветствие + счётчик активных задач
- `/help` — список команд
- `/list` — задачи в `needs-visual-review` (если GitHub webhook прислал хотя бы одну)
- `/current` — открыть текущую задачу + inline keyboard секций
- `/skip <section>` — пометить секцию как пропущенную
- `/cancel` — сбросить текущую задачу
- Приём IG URL / прямых image|video URL / TG photo|video uploads — сохраняются в Redis с привязкой к секции
- GitHub webhook на `needs-visual-review` / `built` / `ready-for-pitch` — push-уведомление в TG

## 8. Что в стабе (M2)

**Реализовано в M2:**
- `/done_all` — собирает state из Redis, коммитит `_data/{slug}/visual_review_input.json`, триггерит workflow `visual-review.yml` (см. ниже)
- `/auto_photos` — то же самое, но с `mode: "auto"` в input.json (Actions сейчас просто логирует "not implemented" и выходит — Q14/Q15 пайплайн ещё не подключён)
- `[✅ Готово, собирать]` callback → `handleDoneAll`
- TG file_id → реальный download через `getFile` API (выполняется в Actions, не в webhook'е)
- IG Reel URL → yt-dlp в Actions
- IG post URL → best-effort yt-dlp (без login)
- IG highlight URL → требует session, в CI пропускается с warning'ом
- Прямые image/video URL → curl

**Остаётся на M3+:**
- `[📝 Тексты]` режим редактирования (Q16.7)
- Placeholder generation в builder skeleton (M2.5 — сейчас apply-fix.mjs работает с existing `<img>` тегами через `data-section` атрибут)
- Полный Q14/Q15 auto-curation в Actions

## 9. M2 — GitHub Actions workflow

После `/done_all` бот делает:
1. `PUT /repos/.../contents/_data/{slug}/visual_review_input.json` через GH REST API
2. Comment на issue с snippet'ом input.json
3. `POST /repos/.../actions/workflows/visual-review.yml/dispatches` — запуск workflow с inputs `{ issue_number, slug }`

Workflow `.github/workflows/visual-review.yml`:
1. Checkout main
2. Setup Node 20 + Python 3.11 + yt-dlp + instaloader + Vercel CLI
3. Verify `_data/{slug}/visual_review_input.json` exists
4. Detect mode (`manual` vs `auto`). Если `auto` — early exit с warning'ом
5. `node scripts/visual-review/download-refs.mjs --slug <slug>` — скачивает все ссылки в `_data/{slug}/visual_review_files/{section}/`
6. `node scripts/visual-review/apply-fix.mjs --slug <slug> --issue <num>` — копирует файлы в `{slug}/images/` + заменяет placeholder'ы / `<img data-section>` теги в `index.html`
7. `git commit + push` (если есть diff)
8. `vercel --prod --yes` (если есть VERCEL_TOKEN и .vercel link)
9. Removes label `needs-visual-review`, adds `built`, comments preview URL

### Требуемые repo secrets

```powershell
gh secret set TG_BOT_TOKEN -R Shebovich/business-sites
gh secret set VERCEL_TOKEN -R Shebovich/business-sites  # уже стоит (используется deploy.yml)
# VERCEL_ORG_ID берётся из .vercel/project.json — не требуется как secret
```

### Тестирование `/done_all` без поломки реального сайта

1. Сделай тестовый issue с лейблом `needs-visual-review`:
   ```powershell
   gh issue create -R Shebovich/business-sites `
     --title "[test] visual-review test" `
     --body "slug: u-fontana" `
     --label needs-visual-review
   ```
2. Через TG: `/list` → выбери задачу → пройди по секциям, отправь 1-2 фото
3. Жми `[✅ Готово, собирать]`
4. Логи workflow: `gh run list -R Shebovich/business-sites --workflow visual-review.yml`
5. Конкретный run: `gh run view <run_id> -R Shebovich/business-sites --log`

Если что-то сломалось — input.json остаётся в репо, можно запустить workflow вручную из Actions tab.

## 10. M2.5 — Claude Code executor + multi-user

### Зачем

Раньше `/done_all` триггерил GitHub Actions workflow `visual-review.yml` (Q16.4).
Слабые места: задержка ~2-3 минуты на cold-start runner'а, fix-loop'ы через
git push, нет интерактивной видимости. Решение (Q18.1) — **Claude Code на
ноуте** = primary executor. Actions yaml сохранён как dormant fallback.

После `/done_all`:
1. Бот коммитит `_data/{slug}/visual_review_input.json` в репо
2. Бот меняет лейбл `needs-visual-review` → `awaiting-claude-process`
3. Юзер открывает Claude Code и пишет `обработай задачи из бота`
4. Skill `process-tg-tasks` забирает все issues с этим лейблом, скачивает
   фото, применяет `apply-fix`, деплоит, ставит `built`, шлёт TG

### Multi-user (owner + assistants)

Бот теперь поддерживает несколько whitelist'ов с разными ролями (Q16.5 v2):

- **owner** — Pavel, может всё (`/done_all`, `/auto_photos`, `/owner_review`)
- **assistant** — друг/коллега, может только собирать input (`/submit`)

#### Добавить ассистента

1. Друг открывает https://t.me/userinfobot → `/start` → копирует свой `Id`
2. Он пишет тебе этот Id (в Telegram / любым каналом)
3. Ты добавляешь в env var (comma-separated):
   ```powershell
   echo "FRIEND_CHAT_ID,ANOTHER_FRIEND_ID" | vercel env add TG_ASSISTANT_CHAT_IDS production
   vercel --prod --yes  # redeploy чтобы новый env подтянулся
   ```
4. Можно несколько ассистентов через запятую. Пустое значение / отсутствие
   переменной = ассистентов нет (только owner).

#### Daily workflow

1. **Assistant** работает в боте: тапает секцию, шлёт фото/URL/тексты.
2. Когда собрал — жмёт `/submit`. Лейбл issue меняется на `awaiting-owner-review`.
3. **Owner** получает push (через GitHub webhook → TG) что задача на ревью.
4. Owner смотрит очередь: `/owner_review` (или `/list` — задачи с иконкой 🔵).
5. Тапает задачу → видит секции с собранными фото. Может добавить своё или
   сразу `/done_all`.
6. `/done_all` коммитит input + ставит `awaiting-claude-process`.
7. Owner на ноуте: открывает Claude Code → пишет `обработай задачи из бота`
   → skill `process-tg-tasks` отрабатывает всё в очереди.

### Перед запуском skill'а на новом ноуте

```powershell
node scripts/bot/pull-env.mjs   # тянет .env с Vercel
# теперь можно вызывать /process-tg-tasks из Claude Code
```

### Лейблы (новые в M2.5)

- `awaiting-claude-process` — input.json готов, ждёт локального запуска skill'а
- `awaiting-owner-review` — ассистент сделал /submit, ждёт owner'а

Регистрация через gh CLI (выполнить один раз):
```powershell
gh label create awaiting-claude-process -R Shebovich/business-sites `
  --color "FFA500" --description "Bot input ready, waiting for Claude Code local processing"
gh label create awaiting-owner-review -R Shebovich/business-sites `
  --color "1D76DB" --description "Assistant submitted, owner needs to review/finalize"
```

### Откат к GitHub Actions

Если Claude Code executor не зайдёт — флипнуть обратно:
1. В `scripts/bot/lib/commands.mjs:runRebuild` восстановить вызов
   `dispatchWorkflow({ workflow: 'visual-review.yml', ... })` вместо
   `setLabel(..., AWAITING_CLAUDE_PROCESS, ...)`.
2. Обновить текст reply в `/done_all` обратно на "Workflow запущен".
3. Передеплоить.

Workflow yaml остаётся в `.github/workflows/visual-review.yml` без изменений.

## Troubleshooting

- **Бот молчит:** проверь `TG_OWNER_CHAT_ID` (или, если ты ассистент —
  что Pavel добавил твой id в `TG_ASSISTANT_CHAT_IDS`).
- **`getWebhookInfo` показывает last_error:** обычно проблема с env vars в Vercel. Глянь логи `vercel logs` для `/api/bot/webhook`.
- **GitHub webhook 401:** secret не совпадает между Vercel env и GitHub Settings.
- **Upstash connection error:** REST URL должен начинаться с `https://`, токен — длинная base64-строка.
- **`/process-tg-tasks` не находит задачи:** проверь лейбл `awaiting-claude-process` на issue (а не `needs-visual-review` — это до `/done_all`).
- **Skill падает на gh CLI:** перед запуском в PowerShell подтяни PATH:
  `$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")`.
