// M3c — Q33: role-aware /playbook.
//
// Uses TG HTML parse_mode (same reason as help.mjs — bare `_` in command
// names breaks Markdown v1). Canonical human-readable source is
// docs/playbooks/{owner,assistant}.md — kept in sync manually.

export const OWNER_PLAYBOOK = `📘 <b>Owner playbook</b>

<b>1. Утренний digest</b>
• /list → 🔵 = submit'ы ассистентов, 📋 = свежие задачи
• /pitch_review → батч-ревью готовых сайтов

<b>2. Ревью submit'а ассистента</b>
• Получаешь push 🔔 — фото-счётчики + тексты + URLs
• [👁 Открыть фото] — глянуть медиа лениво
• [✅ Approve] — окей → коммит input.json + label awaiting-claude-process
• [💬 Замечания] — твой следующий месседж → коммент в issue + push ассистенту, лейбл откатывается на needs-visual-review

<b>3. После approve</b>
• На ноуте: открой Claude Code, напиши /process-tg-tasks
• Skill применяет фото, деплоит, ставит built → потом ready-for-pitch

<b>4. Готовый сайт — pitch</b>
• /pitch_review показывает все ready-for-pitch
• [✅ Pitched] = отправил клиенту → лейбл pitched
• [🔄 Revise] = нужно переделать → откат в needs-visual-review
• [⏭ Skip] = не сейчас

<b>5. После pitch</b>
• Клиент сказал да → /sold {N} [optional notes] → label sold
• Сказал нет → /lost {N} [reason] → label lost, issue closed
• Молчит >3 дней → /ghosted {N}

<b>6. Свежие лиды</b>
• /scout — следующий из очереди
• /scout {2GIS/IG/имя} — ad-hoc
• /scout_review — inbox новых scouted, [✅ Approve и начать]

<b>7. Если что-то сломалось</b>
• /cancel — сбросить текущую сессию
• Прямой gh CLI на репо — fallback на bot label changes`;

export const ASSISTANT_PLAYBOOK = `📘 <b>Assistant playbook</b>

<b>1. Открыть задачу</b>
• /list → 📋 = задачи в работе
• Тапни задачу → выберешь секцию

<b>2. Собрать фото</b>
В контексте секции принимается:
• IG post URL (instagram.com/p/…)
• IG Reel URL (instagram.com/reel/…)
• IG Highlight URL (instagram.com/stories/highlights/…)
• Прямой image/video URL
• Загрузка фото/видео прямо в TG
• Текстовая инструкция вместе с URL ("crop сверху", "первым в menu")

<b>3. Проверить перед отправкой</b>
• /preview → увидишь свою же сводку: фото-счётчики, тексты, URLs
• Хочешь удалить — /rm {section} {N}
• Хочешь отменить skip — /unskip {section}

<b>4. Передать на ревью</b>
• /submit
• Owner получит push с твоей сводкой
• Если ничего не поменял после feedback'а — /submit отклонит

<b>5. Получил замечания</b>
• 💬 в TG: что переделать
• Лейбл откатился на needs-visual-review — задача снова в /list
• Внеси правки → опять /submit (раунд увеличится)

<b>6. Предложить новое заведение</b>
• /scout {2GIS URL / IG URL / название / @handle}
• Owner получит push для approve
• Дальше задача идёт обычным путём — ты можешь тапнуть её в /list`;

export function renderPlaybook(role) {
  return role === 'owner' ? OWNER_PLAYBOOK : ASSISTANT_PLAYBOOK;
}
