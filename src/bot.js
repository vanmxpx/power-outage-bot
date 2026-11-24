/**
 * Telegram update handlers: text messages and inline-button callbacks.
 *
 * Access model: /start sends a request to admins. An admin approves the person as an admin
 * (everything) or a user. A user gets a level per site (none · sees · controls), and a device
 * may be limited below its site's level. The very first /start with ACCESS_KEY creates the first admin.
 * A group chat an admin added the bot to is listed with the people and gets notifications like one.
 *
 * Callback data: g:<days> outages · dl device list · d:<dev> card · h:<dev> history ·
 * dc:<dev>:on|off control · a:<uid>:<role> approve or change role · r:<uid> reject or revoke ·
 * u:… people and access (access.js) · s:… settings (settings.js).
 */

import { GROUP_ASK_GAP_SEC, ROLES, controllable, deviceById, deviceSite } from './config.js';
import { db, getPerm, getUser, kvGet, kvSet, resetPerms, usersBy, viewableSites } from './db.js';
import { DK, setDevicePower } from './devices.js';
import { render } from './messages.js';
import { onAccessCallback, onAccessText, openUserEditor, userCard, userLabel, usersList } from './access.js';
import { onSettingsCallback, onSettingsText, openSettings } from './settings.js';
import { displayName } from './store.js';
import { startUpdate } from './updates.js';
import { deviceCard, deviceHistory, devicesMenu, outagesReport, statusText } from './reports.js';
import { RELEASES_BUTTON, broadcastDevice, edit, isShared, mainKeyboard, seesReleases, send, tg } from './telegram.js';
import { releasesView } from './releases.js';
import { chartMenu, sendChart, toggleSummaries } from './charts.js';
import { NL, now } from './util.js';

const roleButtons = (uid) => [
  [
    { text: '👤 Користувач', callback_data: `a:${uid}:user` },
    { text: '👑 Адмін', callback_data: `a:${uid}:admin` },
  ],
];

/* ---------- messages ---------- */

async function handleStart(env, msg, user) {
  const id = msg.chat.id;
  const D = await db(env);
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ');
  const username = msg.from?.username || '';
  const arg = (msg.text || '').trim().split(' ').filter(Boolean)[1] || '';
  const admins = await usersBy(env, 'admin');

  if (!admins.length && arg && arg === env.ACCESS_KEY) {
    await D.prepare(
      'INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET role=excluded.role, status=excluded.status'
    )
      .bind(id, name, username, 'admin', 'approved', now())
      .run();
    return send(env, id, '✅ Ти адмін. Нові користувачі надсилатимуть запит на доступ, а схвалювати їх будеш ти.', {
      reply_markup: mainKeyboard('admin', env),
    });
  }
  if (user?.status === 'approved') {
    return send(env, id, `Ти вже маєш доступ: ${ROLES[user.role] || ROLES.user}.`, {
      reply_markup: mainKeyboard(user.role, env),
    });
  }
  if (user?.status === 'pending') return send(env, id, 'Запит уже надіслано, чекай на схвалення.');
  if (user?.status === 'rejected') return;

  await D.prepare('INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,?,?,?)')
    .bind(id, name, username, null, 'pending', now())
    .run();
  const created = await getUser(env, id);
  for (const a of admins) {
    await send(env, a.chat_id, `🙋 Запит на доступ: ${userLabel(created)}`, {
      reply_markup: { inline_keyboard: [...roleButtons(id), [{ text: 'Відхилити', callback_data: `r:${id}` }]] },
    });
  }
  return send(env, id, 'Запит на доступ надіслано адміністратору.');
}

/* ---------- group chats ---------- */

/**
 * A group gets notifications the way a person does: it is a row in `users` under the chat's
 * id, with a level per site. Only an admin links one, by adding the bot to the group or, if
 * the bot is already there, with /start@<bot> in it. In a linked group anyone may ask /status
 * and /summary; the bot answers nothing else there.
 */

/** The bot's own Telegram id: the part of the token before the colon. */
const botId = (env) => Number(String(env.TG_BOT_TOKEN).split(':')[0]);

async function linkChat(env, chat, admin) {
  const id = chat.id;
  const was = await getUser(env, id);
  if (was?.status === 'approved') return send(env, id, 'Цей чат уже отримує сповіщення.');
  await (
    await db(env)
  )
    .prepare(
      "INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,'user','approved',?) ON CONFLICT(chat_id) DO UPDATE SET name=excluded.name, username=excluded.username, role='user', status='approved'"
    )
    .bind(id, chat.title || 'Чат', chat.username || '', now())
    .run();
  await resetPerms(env, id);
  await send(
    env,
    id,
    '✅ Сюди надходитимуть сповіщення про світло. Що саме бачить цей чат, адмін налаштовує в «👥 Користувачі».'
  );
  const v = await openUserEditor(env, admin.chat_id, id);
  return send(env, admin.chat_id, `💬 Чат додано, він отримуватиме сповіщення.${NL}${NL}${v.text}`, {
    reply_markup: { inline_keyboard: v.kb },
  });
}

/** The bot left the group, or was removed from it. */
async function unlinkChat(env, id) {
  const D = await db(env);
  await D.prepare('DELETE FROM users WHERE chat_id=?').bind(id).run();
  await D.prepare('DELETE FROM user_devices WHERE chat_id=?').bind(id).run();
  await D.prepare('DELETE FROM kv WHERE k IN (?,?,?,?)')
    .bind(`nosum:${id}`, `status_at:${id}`, `summary_at:${id}`, `cfg.mute@${id}`)
    .run();
}

/** A group that became a supergroup gets a new id; its access follows it. */
async function moveChat(env, from, to) {
  if (!(await getUser(env, from))) return;
  const D = await db(env);
  await unlinkChat(env, to);
  await D.prepare('UPDATE users SET chat_id=? WHERE chat_id=?').bind(to, from).run();
  await D.prepare('UPDATE user_devices SET chat_id=? WHERE chat_id=?').bind(to, from).run();
  await D.prepare('UPDATE kv SET k=? WHERE k=?').bind(`nosum:${to}`, `nosum:${from}`).run();
  await D.prepare('UPDATE kv SET k=? WHERE k=?').bind(`cfg.mute@${to}`, `cfg.mute@${from}`).run();
}

async function onGroupMessage(env, msg) {
  const { chat } = msg;
  if (chat?.type !== 'group' && chat?.type !== 'supergroup') return;
  if (msg.migrate_to_chat_id) return moveChat(env, chat.id, msg.migrate_to_chat_id);
  if (msg.migrate_from_chat_id) return moveChat(env, msg.migrate_from_chat_id, chat.id);
  if (msg.left_chat_member?.id === botId(env)) return unlinkChat(env, chat.id);

  // Added to a group, or the group was created with the bot in it.
  const added = msg.group_chat_created || (msg.new_chat_members || []).some((m) => m.id === botId(env));
  const [, command, to] = /^\/(start|status|summary)(@\w+)?(?:\s|$)/.exec((msg.text || '').trim()) || [];
  if (!added && !command) return;

  if (command === 'status' || command === 'summary') {
    // Anyone in a linked group may ask: the answer shows what the group is notified about anyway.
    const group = await getUser(env, chat.id);
    if (group?.status !== 'approved' || !(await addressed(env, to))) return;
    const at = `${command}_at:${chat.id}`;
    if (now() - Number(await kvGet(env, at)) < GROUP_ASK_GAP_SEC) return;
    await kvSet(env, at, now());
    if (command === 'status') return send(env, chat.id, await statusText(env, group));
    // Today so far, the way "📈 Графік → сьогодні" shows it to a person.
    const sites = await viewableSites(env, group);
    if (!sites.length) return send(env, chat.id, "Цей чат не бачить жодного об'єкта. Доступ відкриває адмін бота.");
    for (const site of sites) await sendChart(env, group, site.id, 'd');
    return;
  }

  if (!msg.from?.id) return;
  const admin = await getUser(env, msg.from.id);
  if (admin?.status !== 'approved' || admin.role !== 'admin' || !(await addressed(env, to))) return;
  return linkChat(env, chat, admin);
}

/** Whether a command with "@name" is for this bot; it sees other bots' commands if it reads the whole group. */
async function addressed(env, to) {
  if (!to) return true;
  const me = await tg(env, 'getMe', {});
  return `@${me.result?.username}`.toLowerCase() === to.toLowerCase();
}

/** @param {import('./config.js').Env} env */
export async function onMessage(env, msg) {
  if (msg.chat?.type !== 'private') return onGroupMessage(env, msg);
  const id = msg.chat.id;
  const text = (msg.text || '').trim();
  const user = await getUser(env, id);

  if (text.startsWith('/start')) return handleStart(env, msg, user);
  if (user?.status !== 'approved') return;

  if (text === '/status' || text === '📊 Статус') {
    return send(env, id, await statusText(env, user), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📈 Графік', callback_data: 'cg' },
            { text: '🔌 Відключення за 7 днів', callback_data: 'g:7' },
          ],
        ],
      },
    });
  }
  if (text === '/devices' || text === '🏠 Пристрої') {
    const m = await devicesMenu(env, user);
    return send(env, id, m.text, m.kb.length ? { reply_markup: { inline_keyboard: m.kb } } : {});
  }
  if (['/on', '/off', '🔥 Бойлер ON', '⛔ Бойлер OFF'].includes(text)) {
    // Buttons from v1.0.0 that may still be on someone's keyboard.
    return send(env, id, 'Керування бойлером переїхало в «🏠 Пристрої».', {
      reply_markup: mainKeyboard(user.role, env),
    });
  }
  if ((text === '/changes' || text === RELEASES_BUTTON) && seesReleases(env, user.role)) {
    const v = releasesView(0);
    return send(env, id, v.text, v.kb.length ? { reply_markup: { inline_keyboard: v.kb } } : {});
  }
  if ((text === '/users' || text === '👥 Користувачі') && user.role === 'admin') {
    const m = await usersList(env);
    return send(env, id, m.text, m.kb.length ? { reply_markup: { inline_keyboard: m.kb } } : {});
  }
  if ((text === '/settings' || text === '⚙️ Налаштування') && user.role === 'admin') return openSettings(env, id);
  if (await onAccessText(env, msg, user)) return;
  if (await onSettingsText(env, msg, user)) return;

  const menu = `Меню внизу: 📊 Статус, 🏠 Пристрої${user.role === 'admin' ? ', 👥 Користувачі, ⚙️ Налаштування' : ''}.`;
  return send(env, id, menu, { reply_markup: mainKeyboard(user.role, env) });
}

/* ---------- callbacks ---------- */

async function handleDevice(env, cq, me, act, dev, arg, done) {
  const device = deviceById(env, dev);
  if (!device) return done('Невідомий пристрій');
  const perm = await getPerm(env, me, dev);
  if (perm === 'none') return done('Немає доступу до пристрою');

  if (act === 'h') {
    const v = await deviceHistory(env, dev);
    await edit(env, cq, v.text, v.kb);
    return done();
  }
  if (act === 'dc') {
    if (perm !== 'control' || !controllable(device)) return done('Лише перегляд');
    const on = arg === 'on';
    const who = displayName(me);
    try {
      await setDevicePower(env, device, on, who);
      // A manual action cancels pending automation in either direction.
      await kvSet(env, DK(device, 'boiler_auto_off'), '0');
      await kvSet(env, DK(device, 'want_off'), '0');
      const vars = { device: device.name, object: deviceSite(env, dev)?.name || '', who };
      const kind = on ? 'manual_on' : 'manual_off';
      await broadcastDevice(env, dev, render(env, kind, vars), kind);
    } catch (e) {
      return done(`Не вдалося: ${e.message}`.slice(0, 190));
    }
  }
  const card = await deviceCard(env, me, dev);
  await edit(env, cq, card.text, card.kb);
  return done();
}

async function handleAdmin(env, cq, me, act, a1, a2, done) {
  if (me.role !== 'admin') return done('Немає прав');
  const tid = Number(a1);
  if (tid === me.chat_id) return done('Себе змінювати не можна');
  const target = await getUser(env, tid);
  if (!target) return done('Користувача не знайдено');
  const D = await db(env);

  // Access screens from older messages open today's editor.
  if (act === 'pd' || act === 'pc') {
    if (target.role === 'admin') return done('Адмін бачить і керує всім');
    const v = await openUserEditor(env, me.chat_id, tid);
    await edit(env, cq, v.text, v.kb);
    return done();
  }

  let result;
  if (act === 'a' && ROLES[a2]) {
    const wasUser = target.status === 'approved' && target.role !== 'admin';
    await D.prepare("UPDATE users SET role=?, status='approved' WHERE chat_id=?").bind(a2, tid).run();
    // A newly approved user, or an admin demoted to user, starts from "sees the first site";
    // an existing user keeps the access the admin already set.
    if (a2 === 'user' && !wasUser) await resetPerms(env, tid);
    if (isShared(tid)) {
      const all = 'Цей чат отримуватиме всі сповіщення, зокрема службові для адмінів.';
      await send(env, tid, a2 === 'admin' ? `🔔 ${all}` : "🔕 Цей чат отримуватиме лише сповіщення про свої об'єкти.");
    } else await send(env, tid, `✅ Доступ надано: ${ROLES[a2]}.`, { reply_markup: mainKeyboard(a2, env) });
    if (a2 === 'user' && !wasUser) {
      const v = await openUserEditor(env, me.chat_id, tid);
      await edit(env, cq, `✅ ${userLabel(target)} → ${ROLES.user}${NL}${NL}${v.text}`, v.kb);
      return done('Готово');
    }
    const card = await userCard(env, me, await getUser(env, tid));
    await edit(env, cq, `✅ ${ROLES[a2]}.${NL}${NL}${card.text}`, card.kb);
    return done('Готово');
  } else if (act === 'r') {
    await D.prepare("UPDATE users SET status='rejected', role=NULL WHERE chat_id=?").bind(tid).run();
    await D.prepare('DELETE FROM user_devices WHERE chat_id=?').bind(tid).run();
    await send(env, tid, 'Доступ закрито.', { reply_markup: { remove_keyboard: true } });
    result = `🚫 ${userLabel(target)}: доступ закрито`;
  } else {
    return done('Невідома дія');
  }
  await edit(env, cq, result, [[{ text: '⬅️ Користувачі', callback_data: 'u:l' }]]);
  return done('Готово');
}

/** @param {import('./config.js').Env} env */
export async function onCallback(env, cq) {
  const me = await getUser(env, cq.from.id);
  const done = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  if (me?.status !== 'approved') return done('Немає доступу');
  const [act, a1, a2] = String(cq.data || '').split(':');

  if (act === 'g') {
    await send(env, me.chat_id, await outagesReport(env, me, Number(a1) || 7));
    return done();
  }
  if (act === 'cg') {
    const v = await chartMenu(env, me);
    await send(env, me.chat_id, v.text, { reply_markup: { inline_keyboard: v.kb } });
    return done();
  }
  if (act === 'ch') {
    await done('Малюю графік…');
    if (!(await sendChart(env, me, a1, a2))) await send(env, me.chat_id, "Немає доступу до цього об'єкта.");
    return;
  }
  if (act === 'ns') {
    // Under a summary in a group the button is about the group, and the admin decides.
    const here = cq.message?.chat?.id;
    if (isShared(here)) {
      if (me.role !== 'admin') return done('У груповому чаті це вирішує адмін');
      const off = await toggleSummaries(env, here);
      return done(
        off ? 'Підсумки дня в цьому чаті вимкнено. Увімкнути: ця ж кнопка.' : 'Підсумки дня в цьому чаті ввімкнено.'
      );
    }
    const off = await toggleSummaries(env, me.chat_id);
    return done(off ? 'Підсумки дня вимкнено. Увімкнути: 📊 Статус → 📈 Графік.' : 'Підсумки дня знову надходитимуть.');
  }
  if (act === 'rl') {
    if (!seesReleases(env, me.role)) return done('Немає доступу');
    const v = releasesView(Number(a1) || 0);
    await edit(env, cq, v.text, v.kb);
    return done();
  }
  if (act === 'dl') {
    const m = await devicesMenu(env, me);
    await edit(env, cq, m.text, m.kb);
    return done();
  }
  if (act === 'd' || act === 'h' || act === 'dc') return handleDevice(env, cq, me, act, a1, a2, done);
  if (act === 'u') return onAccessCallback(env, cq, me, String(cq.data).split(':').slice(1), done);
  if (act === 's') return onSettingsCallback(env, cq, me, String(cq.data).split(':').slice(1), done);
  if (act === 'up') {
    if (me.role !== 'admin') return done('Лише для адміна');
    await send(env, me.chat_id, await startUpdate(env));
    return done();
  }
  return handleAdmin(env, cq, me, act, a1, a2, done);
}
