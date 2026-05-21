// M3c — Q33: role-aware /playbook.
//
// Short howto-scenarios sent inline in TG. The canonical source for humans
// is docs/playbooks/{owner,assistant}.md — those files are easier to read
// and edit. The constants below are a compact restatement. Keep them in sync
// when the MD files change (no build step yet — manual mirror).

export const OWNER_PLAYBOOK = `📘 *Owner playbook*

*1. Утренний digest*
• /list → 🔵 = submit'ы ассистентов, 📋 = свежие задачи
• /pitch_review → батч-ревью готовых сайтов

*2. Ревью submit'а ассистента*
• Получаешь push 🔔 — фото-счётчики + тексты + URLs
• [👁 Открыть фото] — глянуть медиа лениво
• [✅ Approve] — окей → коммит input.json + label awaiting-claude-process
• [💬 Замечания] — твой следующий месседж → коммент в issue + push ассистенту, лейбл откатывается на needs-visual-review

*3. После approve*
• На ноуте: открой Claude Code, напиши /process-tg-tasks
• Skill применяет фото, деплоит, ставит built → потом ready-for-pitch

*4. Готовый сайт — pitch*
• /pitch_review показывает все ready-for-pitch
• [✅ Pitched] = отправил клиенту → лейбл pitched
• [🔄 Revise] = нужно переделать → откат в needs-visual-review
• [⏭ Skip] = не сейчас

*5. После pitch*
• Клиент сказал да → /sold {N} [optional notes] → label sold
• Сказал нет → /lost {N} [reason] → label lost, issue closed
• Молчит >3 дней → /ghosted {N}

*6. Свежие лиды*
• /scout — следующий из очереди
• /scout {2GIS/IG/имя} — ad-hoc
• /scout_review — inbox новых scouted, [✅ Approve и начать]

*7. Если что-то сломалось*
• /cancel — сбросить текущую сессию
• Прямой gh CLI на репо — fallback на bot label changes`;

export const ASSISTANT_PLAYBOOK = `📘 *Assistant playbook*

*1. Открыть задачу*
• /list → 📋 = задачи в работе
• Тапни задачу → выберешь секцию

*2. Собрать фото*
В контексте секции принимается:
• IG post URL (instagram.com/p/…)
• IG Reel URL (instagram.com/reel/…)
• IG Highlight URL (instagram.com/stories/highlights/…)
• Прямой image/video URL
• Загрузка фото/видео прямо в TG
• Текстовая инструкция вместе с URL ("crop сверху", "первым в menu")

*3. Проверить перед отправкой*
• /preview → увидишь свою же сводку: фото-счётчики, тексты, URLs
• Хочешь удалить — /rm {section} {N}
• Хочешь отменить skip — /unskip {section}

*4. Передать на ревью*
• /submit
• Owner получит push с твоей сводкой
• Если ничего не поменял после feedback'а — /submit отклонит

*5. Получил замечания*
• 💬 в TG: что переделать
• Лейбл откатился на needs-visual-review — задача снова в /list
• Внеси правки → опять /submit (раунд увеличится)

*6. Предложить новое заведение*
• /scout {2GIS URL / IG URL / название / @handle}
• Owner получит push для approve
• Дальше задача идёт обычным путём — ты можешь тапнуть её в /list`;

export function renderPlaybook(role) {
  return role === 'owner' ? OWNER_PLAYBOOK : ASSISTANT_PLAYBOOK;
}
