// M3c — Q32: role-aware + категориальный /help.
//
// Uses TG HTML parse_mode (Markdown v1 breaks on bare `_` in command names).

// Each entry: title line + что делает + примеры (если есть) + когда юзать.
// Examples wrapped in <code>...</code> so user can long-press to copy.
export const HELP_TEXTS = {
  // ============ INTENT ROUTER (assistant free-form UX, INTENT_ROUTER_ENABLED) ============
  intent: `<b>Свободный ввод</b> (для ассистентов)

Если ты ассистент и НЕ в active task — просто пиши боту что хочешь. Я разберусь и отправлю Pavel'у на одобрение.

<i>Сценарии:</i>
• <b>Новое заведение</b>: «Нашёл бар Зыбкое на Победителях, сайта нет» (или просто ссылка 2GIS / IG handle)
• <b>Баг</b>: «На сайте Лес меню не открывается на мобиле» + screenshot
• <b>Идея/задача</b>: «Сделай чтобы tester проверял contrast ratio»
• <b>Правка секции</b>: «Лес, hero — поменяй tagline на 'Кофе в лесу'»
• <b>Загрузка фото</b>: «Лес, интерьер — вот 3 фото» + файлы

<i>Что происходит:</i>
1. Я принимаю text/фото (если фото без подписи — спрошу слаг)
2. Через ~60 сек создаётся issue → Claude Code классифицирует
3. Pavel получает draft с кнопками [✅] [✏️ Правка] [❌]
4. После approve — реальная задача в pipeline

<i>Если я не понял:</i> я задам уточняющий вопрос, просто ответь свободным текстом.

Slash-команды (<code>/scout</code>, <code>/bug</code>, <code>/prompt</code>) тоже работают если хочется напрямую без routing.`,

  // ============ ОБЩИЕ ============
  start: `<b>/start</b> — приветствие + счётчик активных задач.

Просто открывает бота, ничего не меняет.

<i>Пример:</i>
<code>/start</code>`,

  whoami: `<b>/whoami</b> — твоя роль (owner / assistant) + chat_id.

Полезно когда бот молчит — проверишь что в whitelist'е.

<i>Пример:</i>
<code>/whoami</code>

<i>Что увидишь:</i>
Ты: @pavel
chat_id: <code>123456789</code>
Роль: owner`,

  list: `<b>/list</b> — все активные задачи.

Иконки в списке:
📋 — нужен visual review (новая или после правок)
🔵 — submit от ассистента, ждёт твоего ревью (видит только owner)

<i>Пример:</i>
<code>/list</code>

Затем тапни задачу → откроется секционная клавиатура.`,

  current: `<b>/current</b> — открыть текущую задачу.

Показывает preview-ссылку + inline-клавиатуру с секциями (Hero / Menu / Interior / …). Каждая секция показывает сколько фото уже загружено vs нужно.

<i>Пример:</i>
<code>/current</code>

Затем тапни секцию → бот будет принимать фото/URL для неё.`,

  preview: `<b>/preview</b> — что сейчас собрано для текущей задачи.

Та же сводка, что owner получает на /submit: фото-счётчики, тексты, URLs. Используй чтобы проверить себя перед /submit.

<i>Пример:</i>
<code>/preview</code>

Под каждой секцией будет кнопка [🔍 Открыть] — пришлёт сами фото media group'ом.`,

  skip: `<b>/skip &lt;section_id&gt;</b> — пропустить секцию.

Используй если для секции реально нет контента (нет банкетного зала, нет шефа-звезды). После /skip эта секция не блокирует /submit и не появится на сайте.

<i>Примеры:</i>
<code>/skip private_dining</code>
<code>/skip chef_or_bartender</code>
<code>/skip family_celebrations</code>

<i>Список section_id:</i>
hero, above_fold_thumbs, menu_full, interior_unique, private_dining, signature_dishes, family_celebrations, chef_or_bartender, about_atmospheric`,

  unskip: `<b>/unskip &lt;section_id&gt;</b> — отменить /skip.

Если передумал и хочешь всё-таки добавить фото в секцию.

<i>Пример:</i>
<code>/unskip private_dining</code>`,

  rm: `<b>/rm &lt;section_id&gt; &lt;N&gt;</b> — удалить N-ое фото из секции.

Индекс 1-based — посмотри номера в /preview (бот пишет [hero] 1/3, [hero] 2/3, …).

<i>Примеры:</i>
<code>/rm hero 1</code> — удалить первое фото из hero
<code>/rm menu_full 4</code> — удалить 4-ое фото меню
<code>/rm interior_unique 2</code>

После удаления — снова /preview чтобы проверить.`,

  note: `<b>/note &lt;текст&gt;</b> — оставить заметку/комментарий к задаче.

Если активна секция — заметка привяжется к ней. Если нет — будет общей заметкой задачи.

⚡ <b>Альтернатива:</b> просто пиши в чат любой текст — он сам сохранится как заметка к текущей секции / задаче. /note нужен в основном для написания через слэш.

<i>Примеры:</i>
<code>/note приоритет hero и menu, остальное по возможности</code>
<code>/note hero должно быть видео процесса готовки</code>
<code>/note клиент хочет тёмный фон</code>`,

  notes: `<b>/notes</b> — показать все заметки текущей задачи.

Покажет нумерованный список с указанием секции для каждой заметки.

<i>Пример:</i>
<code>/notes</code>

Удалить одну — /rm_note &lt;N&gt;. Очистить все — /clear_notes.`,

  rm_note: `<b>/rm_note &lt;N&gt;</b> — удалить заметку по номеру.

Индекс из /notes (1-based).

<i>Пример:</i>
<code>/rm_note 3</code>`,

  clear_notes: `<b>/clear_notes</b> — снести все заметки задачи.

Фото и тексты не трогает.

<i>Пример:</i>
<code>/clear_notes</code>`,

  cancel: `<b>/cancel</b> — сбросить текущую сессию.

Сбрасывает: выбранную задачу, активную секцию, pending feedback (если ты owner и тапнул 💬, но не отправил замечание). Фото и тексты в Redis НЕ удаляет — продолжишь с того же места при следующем /current.

<i>Пример:</i>
<code>/cancel</code>`,

  help: `<b>/help</b> — список команд для твоей роли.

<b>/help &lt;команда&gt;</b> — детали по конкретной команде (с примерами).

<i>Примеры:</i>
<code>/help</code> — общий список
<code>/help submit</code> — детали по /submit
<code>/help scout</code> — детали по /scout
<code>/help sold</code> — детали по /sold`,

  playbook: `<b>/playbook</b> — типовые сценарии для твоей роли.

Owner видит: как ревьюить submit, как обрабатывать pitch, как добавлять лиды.
Assistant видит: как собирать фото, как присылать инструкции, как реагировать на замечания.

<i>Пример:</i>
<code>/playbook</code>`,

  // ============ ASSISTANT ============
  submit: `<b>/submit</b> — передать задачу owner на ревью.

Что происходит:
1. Лейбл <code>needs-visual-review → awaiting-owner-review</code>
2. Owner получает push с твоей сводкой (фото + тексты + URLs)
3. У каждого submit'а свой round counter — видно сколько раундов прошло

⚠️ <b>Защита от noop:</b> повторный /submit без изменений отклоняется (SHA1 hash check). Получил замечания → внеси правки → снова /submit.

<i>Пример:</i>
<code>/submit</code>`,

  // ============ OWNER — WORKFLOW ============
  done_all: `<b>/done_all</b> — финализировать solo (owner без ассистента).

Что делает:
1. Коммит <code>_data/{slug}/visual_review_input.json</code> в репо
2. Лейбл <code>needs-visual-review → awaiting-claude-process</code>
3. Дальше на ноуте: <code>/process-tg-tasks</code> в Claude Code

<i>Когда использовать:</i> когда ты сам собрал фото через /current без ассистента.

<i>Пример:</i>
<code>/done_all</code>`,

  auto_photos: `<b>/auto_photos</b> — fallback на Q14/Q15 auto-curation.

Запускает builder в режиме автоматического подбора фото (caption-classification + visual analysis). Используй когда у заведения нет фотографа и ты готов на mediocre автовыбор.

<i>Пример:</i>
<code>/auto_photos</code>

Сейчас Actions просто логирует "not implemented" — мы пока на human-in-loop main path'е.`,

  owner_review: `<b>/owner_review</b> — очередь submit'ов от ассистентов.

Read-only список задач с лейблом <code>awaiting-owner-review</code>. Когда ассистент сделал /submit — оно появится здесь.

<i>Пример:</i>
<code>/owner_review</code>

Альтернатива: просто /list — submit'ы будут с иконкой 🔵.`,

  approve: `<b>/approve &lt;N&gt;</b> — одобрить один submit, запустить GH Actions rebuild.

Эквивалент тапу [✅ Approve] в push-сообщении после /submit. Сбрасывает Redis-стейт задачи + автоматически запускает GitHub Actions workflow для сборки и деплоя.

<i>Примеры:</i>
<code>/approve 12</code>
<code>/approve #15</code>

Дальше — ничего не делать. Когда GH Actions соберёт сайт, бот пришлёт push «обновлено».

Прогресс: https://github.com/Shebovich/business-sites/actions/workflows/visual-review.yml`,

  approve_all: `<b>/approve_all</b> — batch-approve все submit'ы + автоматический rebuild.

Прохожусь по всем задачам с лейблом <code>awaiting-owner-review</code>:
1. Коммит input.json для каждой
2. Лейбл → <code>awaiting-claude-process</code>
3. Сброс Redis
4. Push ассистенту «одобрено»
5. <b>Автозапуск GH Actions workflow</b> — Claude Code на ноуте не нужен

В конце получишь сводку: сколько отправлено в Actions, сколько провалилось.

<i>Пример:</i>
<code>/approve_all</code>

Каждая задача собирается параллельно в Actions, по готовности приходит push «обновлено» с label <code>built</code>.

Прогресс: https://github.com/Shebovich/business-sites/actions/workflows/visual-review.yml`,

  pitch_review: `<b>/pitch_review</b> — батч-ревью готовых сайтов.

Показывает все задачи с лейблом <code>ready-for-pitch</code>. По каждой 3 кнопки:
• [✅ Pitched] — отправил клиенту → лейбл pitched
• [🔄 Revise] — нужно переделать → откат в needs-visual-review
• [⏭ Skip] — не сейчас, оставить как есть

<i>Пример:</i>
<code>/pitch_review</code>

Используй утром одним прогоном.`,

  sold: `<b>/sold &lt;N&gt; [notes]</b> — продано.

Лейбл <code>pitched → sold</code> + comment + push ассистенту (если был).

<i>Примеры:</i>
<code>/sold 12</code>
<code>/sold 12 оплатил 70 BYN, домен skif.by</code>
<code>/sold #15 ждёт оплату до 15-го</code>

После /sold — настрой клиентский домен вместо vercel namespace.`,

  lost: `<b>/lost &lt;N&gt; [reason]</b> — не сложилось.

Лейбл <code>pitched → lost</code>, issue закрыт, comment с reason, push ассистенту.

<i>Примеры:</i>
<code>/lost 12</code>
<code>/lost 12 дорого, не подошло</code>
<code>/lost #15 уже есть сайт, не нужно</code>

История остаётся в closed issues — можно вернуться через год.`,

  ghosted: `<b>/ghosted &lt;N&gt;</b> — клиент молчит.

Алиас на /lost с reason="ghosted, no response". Используй если клиент не отвечал 3+ дня после питча.

<i>Пример:</i>
<code>/ghosted 12</code>`,

  scout: `<b>/scout</b> — поиск/добавление новых лидов.

Варианты:
• <code>/scout</code> — следующий из очереди <code>_data/scout_queue.json</code>
• <code>/scout queue</code> — топ 5 в очереди (read-only)
• <code>/scout refresh</code> — напоминание запустить scrape-venues локально
• <code>/scout &lt;input&gt;</code> — ad-hoc лид

Универсальный input понимает:
✓ 2GIS URL: <code>/scout https://2gis.by/minsk/firm/70000001234567890</code>
✓ Google Maps URL: <code>/scout https://maps.app.goo.gl/abc123</code>
✓ Yandex Maps URL: <code>/scout https://yandex.by/maps/-/CDABc123</code>
✓ Instagram URL: <code>/scout https://instagram.com/skifcafe</code>
✓ Instagram handle: <code>/scout @skifcafe</code>
✓ Свой сайт заведения: <code>/scout https://kafe-skif.by</code> (флаг existing-site-replace)
✓ Просто название: <code>/scout Cafe Скиф на Немиге</code>

Дальше: лид появится с лейблом <code>awaiting-scout</code>. Запусти <code>/process-tg-tasks</code> на ноуте — skill дорабатывает.`,

  scout_review: `<b>/scout_review</b> — inbox новых лидов.

Показывает задачи с лейблом <code>scouted</code> — те что scout-агент уже исследовал. По каждой:
• [✅ Approve и начать] — лейбл → needs-visual-review, появляется в /list
• [⏭ Skip] — пока пропустить
• [👁 Открыть issue] — посмотреть чек-лист на GitHub

<i>Пример:</i>
<code>/scout_review</code>`,
};

const OWNER_OVERVIEW = `📋 <b>Активные задачи</b>
/list — все task'и в работе (📋 / 🔵)
/current — открыть, фото-секции
/preview — что сейчас собрано
/skip {section} • /unskip {section}
/rm {section} {N} — удалить фото

📝 <b>Заметки</b>
Просто пиши текст — сохраняется как заметка
/note {текст} — явный вариант (без активной секции)
/notes — список • /rm_note {N} • /clear_notes

👥 <b>Ревью ассистентов</b>
/owner_review — submit'ы на проверке
/approve {N} — одобрить → GH Actions rebuild
/approve_all — batch-approve всех → автосборка

🔍 <b>Поиск заведений</b>
/scout — следующий из очереди
/scout {input} — ad-hoc лид
/scout_review — новые scouted

🎉 <b>Готовые сайты</b>
/pitch_review — батч-ревью
/sold {N} [notes] — продано
/lost {N} [reason] — не сложилось
/ghosted {N} — клиент молчит

⚙️ <b>Утилиты</b>
/done_all — собрать solo
/auto_photos — Q14/Q15 fallback
/cancel — сбросить сессию
/whoami — моя роль + id
/playbook — типовые сценарии

💡 <b>Детали с примерами:</b>
<code>/help submit</code>, <code>/help scout</code>, <code>/help sold</code> и т.д. — по любой команде из списка выше.`;

const ASSISTANT_OVERVIEW = `📋 <b>Сбор контента</b>
/list — task'и в работе
/current — открыть, фото-секции
/preview — что сейчас собрано
/skip {section} • /unskip {section}
/rm {section} {N} — удалить фото

📝 <b>Заметки и инструкции</b>
Просто пиши текст — сохраняется как заметка
/note {текст} — явный вариант
/notes — список • /rm_note {N} • /clear_notes

📤 <b>Передача owner'у</b>
/submit — передать на ревью

🔍 <b>Лиды</b> (опционально)
/scout {input} — предложить заведение

⚙️ <b>Утилиты</b>
/cancel — сбросить сессию
/whoami — моя роль + id
/playbook — типовые сценарии

💡 <b>Детали с примерами:</b>
<code>/help submit</code>, <code>/help current</code>, <code>/help rm</code> и т.д. — по любой команде из списка выше.

<b>Как собирать фото:</b> /current → тапни секцию → шли IG-ссылку, фото, видео, или прямой URL. Подробнее: /playbook.`;

const INTENT_INTRO = `✨ <b>Новое: просто пиши что хочешь</b>
Не помнишь команды? Шли свободный текст / фото / видео — я разберусь и спрошу Pavel'a.
• «Нашёл бар Зыбкое на Победителях» → scout заявка
• «На сайте Лес меню не открывается» → bug
• «Лес, hero — вот видео» (+ файл) → правка секции
Pavel получит draft с кнопками [OK] [Правка] [Reject]. Слэш-команды ниже тоже работают.

`;

export function renderHelp(role) {
  const header = '🤖 <b>Shebovich Sites Bot</b>\n';
  if (role === 'owner') return header + '\n' + OWNER_OVERVIEW;
  const intentEnabled = (process.env.INTENT_ROUTER_ENABLED || '').trim() === 'true';
  const intro = intentEnabled ? INTENT_INTRO : '';
  return header + '\n' + intro + ASSISTANT_OVERVIEW;
}

// `topic` is a slash-stripped command name. Returns the detailed text or
// null if no such topic exists.
export function renderTopicHelp(topic) {
  if (!topic) return null;
  const key = topic.replace(/^\//, '').toLowerCase();
  return HELP_TEXTS[key] || null;
}
