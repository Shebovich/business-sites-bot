// M3c — Q32: role-aware + категориальный /help.
//
// Two surfaces:
//   - renderHelp(role) — overview grouped by phase
//   - renderTopicHelp(topic) — detail for one command (e.g. /help scout)
//
// HELP_TEXTS is a flat map of slash-command-without-/ → multi-line help text.
// Owner/assistant variants are in separate constants and concatenated by role.

export const HELP_TEXTS = {
  // ---- общие
  start: '/start — приветствие + счётчик активных задач.',
  whoami: '/whoami — твоя роль (owner / assistant) + chat_id (на случай если бот молчит).',
  list: '/list — все активные задачи.\nOwner также видит submit\'ы ассистентов с иконкой 🔵.',
  current: '/current — открыть текущую задачу: preview-ссылка + inline-клавиатура секций.',
  preview: '/preview — что сейчас собрано: фото-счётчики, тексты, URLs. Полный snapshot без отправки.',
  skip: '/skip <section_id> — пометить секцию как пропущенную (например `/skip private_dining` если зала нет).',
  unskip: '/unskip <section_id> — отменить /skip.',
  rm: '/rm <section_id> <N> — удалить N-ое фото из секции (1-based, индексы из /preview).',
  cancel: '/cancel — сбросить текущую задачу + любые pending-операции (например незавершённое замечание).',
  help: '/help — список команд для твоей роли.\n/help <команда> — детали по конкретной команде.',
  playbook: '/playbook — типовые сценарии для твоей роли (как обработать новый сабмит, как закинуть лид, и т.д.).',

  // ---- assistant
  submit: '/submit — передать задачу owner на ревью.\nЛейбл переходит `needs-visual-review → awaiting-owner-review`, owner получает push с фото/текстами/URLs.\nЗащита от noop: повторный /submit без изменений отклоняется.',

  // ---- owner — workflow
  done_all: '/done_all — финализировать задачу solo (owner без ассистента).\nКоммит input.json + label `awaiting-claude-process`. Запусти /process-tg-tasks на ноуте после.',
  auto_photos: '/auto_photos — fallback на Q14/Q15 auto-curation. Сейчас Actions просто логирует «not implemented».',
  owner_review: '/owner_review — очередь submit\'ов от ассистентов (label `awaiting-owner-review`). Read-only список.',
  approve: '/approve <N> — одобрить submit, запустить rebuild (label `awaiting-claude-process`).\nЭквивалент тапу ✅ Approve в push-сообщении. Сбрасывает Redis-стейт задачи.',
  pitch_review: '/pitch_review — батч-ревью готовых сайтов (`ready-for-pitch`).\nПо каждому: [✅ Pitched] (отправил клиенту), [🔄 Revise] (откатить в работу), [⏭ Skip] (не сейчас).',
  sold: '/sold <N> [notes] — продано.\nЛейбл `pitched → sold` + comment + push ассистенту. Не забудь после: настроить домен клиента вместо `*.vercel.app`.',
  lost: '/lost <N> [reason] — не сложилось.\nЛейбл `pitched → lost`, issue закрыт, comment с reason.',
  ghosted: '/ghosted <N> — алиас на /lost N "ghosted, no response". Для случая «клиент молчит >3 дней».',
  scout: '/scout — следующий лид из очереди.\n/scout <input> — ad-hoc по 2GIS / Google / Yandex / IG / имени / своему сайту.\n/scout queue — топ 5 в очереди.\n/scout refresh — перезапустить scrape-venues локально.',
  scout_review: '/scout_review — inbox новых лидов (label `scouted`). Тапни ✅ Approve и начать → задача в работе.',
};

const OWNER_OVERVIEW = `📋 *Активные задачи*
/list — все task'и в работе
/current — текущая задача, фото-секции
/preview — что сейчас собрано
/skip {section} — пометить секцию пропущенной
/unskip {section} — отменить skip
/rm {section} {N} — удалить N-ое фото

👥 *Ревью ассистентов*
/owner_review — задачи на проверку
/approve {N} — одобрить и запустить rebuild

🔍 *Поиск заведений*
/scout — следующий лид из очереди
/scout {input} — ad-hoc лид
/scout_review — inbox новых лидов

🎉 *Готовые сайты*
/pitch_review — батч-ревью ready-for-pitch
/sold {N} [notes] — продано
/lost {N} [reason] — не сложилось
/ghosted {N} — клиент молчит

⚙️ *Утилиты*
/done_all — собрать сайт (solo mode)
/auto_photos — Q14/Q15 fallback
/cancel — сбросить текущую сессию
/whoami — кто я для бота
/playbook — типовые сценарии
/help {команда} — подробнее`;

const ASSISTANT_OVERVIEW = `📋 *Сбор контента*
/list — все task'и в работе
/current — открыть задачу, фото-секции
/preview — что сейчас собрано
/skip {section} — пометить секцию пропущенной
/unskip {section} — отменить skip
/rm {section} {N} — удалить N-ое фото

📤 *Передача owner'у*
/submit — передать задачу на ревью

🔍 *Лиды* (опционально)
/scout {input} — предложить заведение
   (approve остаётся за owner'ом)

⚙️ *Утилиты*
/cancel — сбросить текущую сессию
/whoami — кто я для бота
/playbook — типовые сценарии
/help {команда} — подробнее`;

export function renderHelp(role) {
  const header = '🤖 Shebovich Sites Bot\n';
  if (role === 'owner') return header + '\n' + OWNER_OVERVIEW;
  return header + '\n' + ASSISTANT_OVERVIEW;
}

// `topic` is a slash-stripped command name. Returns the detailed text or
// null if no such topic exists.
export function renderTopicHelp(topic) {
  if (!topic) return null;
  const key = topic.replace(/^\//, '').toLowerCase();
  return HELP_TEXTS[key] || null;
}
