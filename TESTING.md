# Bot regression test plan

Цель: подтвердить что после extract бота из `business-sites` ничего не сломалось.
Тестируем на проде (`@ShebovichSitesBot`) с **маркированными** issues — никаких
реальных клиентов на пути.

**Перед началом** убедись:
- Последний production deploy = после extract-коммита (`vercel ls` показывает свежий URL)
- Никто из ассистентов сейчас не работает с ботом (или предупреди их)
- Готов "тестовый slug" — папка, которую не страшно затронуть. Рекомендую сделать
  отдельную dummy-папку `test-bot-sandbox/` в `business-sites`, или использовать
  `u-fontana` (эталон) с пониманием что мы откатим коммит после теста.

## Sandbox setup (один раз)

```bash
# Issue, на котором будем тестировать. Marker [bot-test] в title — чтобы было видно
# что это не реальный клиент.
gh issue create -R Shebovich/business-sites \
  --title "[bot-test] regression check $(date +%Y-%m-%d)" \
  --body "slug: u-fontana

Тестовый issue для проверки бота после extract. Удалить после прохода чеклиста." \
  --label needs-visual-review
```

Запиши номер issue (`#N`) — он понадобится дальше.

---

## Flow A — Auth & onboarding (3 минуты)

Цель: убедиться что role-routing работает (owner / assistant / unknown).

### A.1 Owner identifies correctly
| Step | Send | Expect |
|---|---|---|
| 1 | `/whoami` с твоего основного TG | Ответ содержит `Роль: owner` и твой chat_id |
| 2 | `/help` | Видишь команды `/done_all`, `/approve_all`, `/sold` (owner-only) |
| 3 | `/playbook` | Рендерится owner-playbook (упоминает `/owner_review`) |

### A.2 Assistant whitelist (требует второй chat)
Используй второй TG-аккаунт (другой телефон / TG Web в incognito) **или**
попроси реального ассистента из `TG_ASSISTANT_CHAT_IDS`.

| Step | Send | Expect |
|---|---|---|
| 1 | `/whoami` с ассистент-чата | `Роль: assistant` |
| 2 | `/help` | Видны `/submit`, `/scout`, но **нет** `/done_all`, `/approve` |
| 3 | `/done_all` | Бот игнорит (команда не зарегистрирована для assistant scope) |

### A.3 Unknown chat onboarding
Используй чистый TG-аккаунт, которого нет в whitelist'е (или временно убери
себя/ассистента из env vars — не рекомендую, лучше третий аккаунт).

| Step | Send | Expect |
|---|---|---|
| 1 | `/start` | Бот отвечает: "Привет. Я бот ревью сайтов Shebovich. Твой chat_id: `XXXXX`. Перешли этот id Pavel..." |
| 2 | (на owner-чат) | Push: "🔔 Новый chat_id хочет доступ: ... id `XXXXX`" |

**Если A.3 не сработала** → возможно `onboardingPinged` Set не пустит повтор —
проверь Vercel logs для cold-start (`vercel logs business-sites-bot.vercel.app`).

---

## Flow B — Happy path: сбор фото и /done_all (10 минут)

Цель: убедиться что центральный сценарий работает целиком.

### B.1 List & current
| Step | Send | Expect |
|---|---|---|
| 1 | `/list` | Видишь свой test-issue с маркером `[bot-test]` |
| 2 | Тап на issue (inline keyboard) → `/current` | Бот показывает 9 секций, активная не выбрана |
| 3 | Тап `🎬 Hero` | "Выбрана секция: Hero. Жду фото/видео или URL." |

### B.2 Photo / URL submission

| Step | Send | Expect | Verify |
|---|---|---|---|
| 1 | Отправь фото с подписью или без | "✅ Hero: 1 файл" | `/preview` показывает 1 файл |
| 2 | Отправь direct URL (`https://example.com/img.jpg`) на `above_fold_thumbs` | "✅ above_fold_thumbs: 1 файл" | `/preview` показывает |
| 3 | Отправь IG post URL (`https://instagram.com/p/ABC123/`) на `menu_full` | "✅ menu_full: 1 файл" | URL сохранён в Redis как тип `ig_post` |
| 4 | `/rm 1` (удалить 1-е фото активной секции) | "Удалено 1 фото из ..." | `/preview` показывает на 1 меньше |
| 5 | `/skip private_dining` | "Секция private_dining пропущена" | `/preview` помечает skip |
| 6 | `/unskip private_dining` | "Skip снят" | `/preview` снова показывает 0 |

### B.3 Notes
| Step | Send | Expect |
|---|---|---|
| 1 | `/note Тестовая заметка раз` | "Заметка 1 добавлена" |
| 2 | `/note Тестовая заметка два` | "Заметка 2 добавлена" |
| 3 | `/notes` | Список из 2 заметок |
| 4 | `/rm_note 1` | "Заметка 1 удалена" |
| 5 | `/clear_notes` | "Все заметки очищены" |

### B.4 Preview & cancel
| Step | Send | Expect |
|---|---|---|
| 1 | `/preview` | Сводка: фото по секциям, заметки, нет блокирующих min_count |
| 2 | `/cancel` | "Текущая задача сброшена" |
| 3 | `/current` | "Нет текущей задачи. Выбери через /list" |

### B.5 /done_all — ТОЛЬКО НА ТЕСТОВОМ ISSUE
**Важно:** /done_all коммитит `_data/{slug}/visual_review_input.json` в репо
сайтов и меняет лейбл. Сделай это только на test-issue.

| Step | Send | Expect | Verify |
|---|---|---|---|
| 1 | Заново `/list` → выбрать test-issue → `/current` → собрать минимум по required-секциям (hero ≥1, above_fold_thumbs ≥3, menu_full ≥4) | | `/preview` зелёный |
| 2 | `/done_all` | "Input закоммичен. Лейбл → awaiting-claude-process" | На issue новый комментарий + лейбл изменён |
| 3 | (GH webhook → push) | TG-push: "Issue #N перешёл в awaiting-claude-process" | |
| 4 | `git pull` в `business-sites` локально | Видишь файл `_data/u-fontana/visual_review_input.json` | Содержимое = ожидаемая схема |

**Cleanup после B.5:**
```bash
cd /Users/p.urbanovich/business-sites
git pull  # подтянуть автокоммит бота
git revert <commit_hash> --no-edit  # откатить
git push
gh issue close <N> -R Shebovich/business-sites --comment "test passed"
node scripts/bot/clear-task.mjs --issue <N>  # очистить Redis state
```

---

## Flow C — Assistant submit → owner approve (5 минут)

Цель: убедиться что multi-user развилка работает.

### Prep
Создай второй test-issue (можно с тем же slug):
```bash
gh issue create -R Shebovich/business-sites \
  --title "[bot-test] assistant flow $(date +%Y-%m-%d)" \
  --body "slug: u-fontana" \
  --label needs-visual-review
```

### C.1 Assistant collects + submits
**С ассистент-чата:**
| Step | Send | Expect |
|---|---|---|
| 1 | `/list` | Видишь test-issue |
| 2 | Выбрать → собрать 1-2 фото в секциях | `/preview` ОК |
| 3 | `/submit` | "Передано на ревью owner'у" |
| 4 | (на owner-чат прилетает push) | "🔵 Ассистент submitted issue #N" |

### C.2 Owner reviews
**С owner-чата:**
| Step | Send | Expect |
|---|---|---|
| 1 | `/owner_review` | Список submit'ов (минимум этот) |
| 2 | Тап issue → видишь собранные фото | Inline keyboard: 👁 / ✅ Approve / 💬 |
| 3 | Тап `✅ Approve` | "Approved. Запускаю сборку." Лейбл → `awaiting-claude-process` |

### C.3 /approve_all (batch)
Если есть несколько submit'ов в очереди:
| Step | Send | Expect |
|---|---|---|
| 1 | `/approve_all` | "Approved N submits, dispatched workflows" |

**Cleanup**: revert коммит, закрыть issue, clear-task.

---

## Flow D — Error paths (5 минут)

Цель: убедиться что бот gracefully падает а не молчит/крашится.

### D.1 No active task
| Step | Send | Expect |
|---|---|---|
| 1 | `/current` без выбранного issue | "Нет активной задачи. Выбери через /list" — не падение |
| 2 | Отправь фото без выбранной задачи/секции | "Сначала /current и выбери секцию" |
| 3 | `/done_all` без активной задачи | "Сначала /current" — не 500 |

### D.2 Bad URLs
| Step | Send | Expect |
|---|---|---|
| 1 | Активируй секцию, пришли `https://instagram.com/p/INVALID/` | Сохраняется как ig_post (валидация URL'а — на этапе download-refs, не бот) |
| 2 | Пришли `not_a_url` | Бот не должен крашиться — либо игнор, либо "не похоже на URL/инструкцию" |
| 3 | Пришли `замени hero на blue` (text edit) | Бот регистрирует как text_edit (если активна секция с text-полем) |

### D.3 Empty state
| Step | Send | Expect |
|---|---|---|
| 1 | `/notes` без заметок | "Нет заметок" |
| 2 | `/rm_note 99` (несуществующая) | "Нет такой заметки" |
| 3 | `/preview` пустого issue | Все секции 0, нет блокеров |

### D.4 Long input
| Step | Send | Expect |
|---|---|---|
| 1 | `/note ` + 500 символов | Сохраняется без обрезки |
| 2 | `/scout ` + 200 символов произвольного текста | Создаётся issue с `awaiting-scout` |

---

## Sign-off

Каждый flow прошёл → отметь и продвигайся дальше. Если что-то ломается:

1. **Скриншот ответа бота** + **Vercel logs**:
   `vercel logs business-sites-bot.vercel.app | grep -E "(error|warn)" | tail -50`
2. **Найди соответствующий handler** в `scripts/bot/lib/commands.mjs` и проверь
   что код не зависит от удалённого пути
3. **Rollback бот'а** к предыдущему deploy если регресс:
   `vercel rollback business-sites-bot.vercel.app`

## Что НЕ покрывает этот план

- Полный пайплайн visual-review (`process-tg-tasks` skill + apply-fix + deploy)
  — это уже sites-side, тестируется отдельно
- Workflow `visual-review.yml` (dormant fallback) — тестируется только через
  ручной `gh workflow run`
- Производительность под нагрузкой — бот single-tenant, не релевантно
- Восстановление после Upstash outage — не тестируется (но мы видим в Vercel
  логах если падает)
