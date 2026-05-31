// Градуированное доверие ассистентам (Ф7). Цель owner: «меньше участвовать в ревью,
// но чтоб не творили фигни». Новичок — каждый прототип на ревью. После N одобрений
// подряд — «доверенный»: его прототипы, прошедшие авто-QA, идут сразу (owner видит в сводке).
//
// Ключ: trust:{chatId} = { level:'new'|'trusted', approvals, fixes, since }

import { getRedis } from './state.mjs';

const r = () => getRedis();
const K = (id) => `trust:${id}`;
export const TRUST_THRESHOLD = 3; // одобрений подряд для повышения

export async function getTrust(id) {
  return (await r().get(K(id))) || { level: 'new', approvals: 0, fixes: 0 };
}

// Owner одобрил прототип → засчитываем. На 3-м подряд — повышение.
export async function recordApproval(id) {
  const t = await getTrust(id);
  t.approvals = (t.approvals || 0) + 1;
  t.streak = (t.streak || 0) + 1;
  let promoted = false;
  if (t.level !== 'trusted' && t.streak >= TRUST_THRESHOLD) { t.level = 'trusted'; t.since = Date.now(); promoted = true; }
  await r().set(K(id), t);
  return { trust: t, promoted };
}

// Owner отправил в правки → streak сбрасывается (не идеально → доверие не растёт).
export async function recordFix(id) {
  const t = await getTrust(id);
  t.fixes = (t.fixes || 0) + 1;
  t.streak = 0;
  await r().set(K(id), t);
  return t;
}

export async function setLevel(id, level) {
  const t = await getTrust(id);
  t.level = level;
  if (level === 'new') t.streak = 0;
  await r().set(K(id), t);
  return t;
}

export const isTrusted = async (id) => (await getTrust(id)).level === 'trusted';
