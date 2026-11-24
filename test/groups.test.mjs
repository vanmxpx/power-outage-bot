import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, BOT, GUEST, MEMBER, NOTIFY_KEY, createWorld, textsTo } from './helpers/world.mjs';

const CHAT = -1001234567890;
const joined = { new_chat_members: [{ id: BOT, is_bot: true }] };

/** A day with a single reading is summed up in a text, with more in a photo; both count. */
const isSummary = (m, chat) => m.chat === chat && m.text.startsWith('📊 <b>Підсумки дня');

/** A service notice only admins get. */
async function notifyAdmins(w) {
  await w.http(`/notify?k=${NOTIFY_KEY}`, { method: 'POST', body: JSON.stringify({ text: 'service' }) });
  return w.sent.splice(0);
}

test('an admin adds the bot to a group: the group gets light notifications, the admin gets its access screen', async () => {
  const w = createWorld();
  const out = await w.group(CHAT, ADMIN, undefined, joined);
  assert.match(textsTo(out, CHAT)[0], /^✅ Сюди надходитимуть сповіщення про світло\./);
  const screen = out.find((m) => m.chat === ADMIN);
  assert.match(screen.text, /^💬 Чат додано/);
  assert.match(screen.text, /🔐 Доступ: ⁨Сусіди⁩/);
  assert.ok(screen.markup.inline_keyboard.flat().some((b) => b.text === '⚡ Дім: 👁 бачить'));

  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, CHAT).some((t) => t.startsWith('🔌 Світло зникло')));
  assert.ok(textsTo(off, CHAT).includes('⛔ Бойлер вимкнено автоматично.'));

  const service = await notifyAdmins(w);
  assert.equal(textsTo(service, ADMIN).length, 1);
  assert.equal(textsTo(service, CHAT).length, 0, 'service notices stay with the admins');
});

test('only an admin links a group, and the bot answers nothing else there', async () => {
  const w = createWorld();
  assert.deepEqual(await w.group(CHAT, 99, undefined, joined), [], 'a stranger added the bot');
  assert.deepEqual(await w.group(CHAT, MEMBER, '/start@test_bot'), [], 'a user who is not an admin');
  assert.deepEqual(await w.group(CHAT, ADMIN, '/status'), []);
  assert.deepEqual(await w.group(CHAT, ADMIN, '📊 Статус'), []);
  assert.deepEqual(await w.group(CHAT, ADMIN, '/start@other_bot'), [], "another bot's command");
  assert.deepEqual(await w.group(CHAT, ADMIN, undefined, { new_chat_members: [{ id: 5 }] }), [], 'a person joined');

  w.grid = false;
  assert.equal(textsTo(await w.tick(), CHAT).length, 0);

  // A group the admin created together with the bot is linked like one the bot was added to.
  const fresh = await w.group(-55, ADMIN, undefined, { group_chat_created: true });
  assert.match(textsTo(fresh, -55)[0], /^✅ Сюди надходитимуть/);

  // The bot is already a member: the admin links the group with a command.
  const linked = await w.group(CHAT, ADMIN, '/start@test_bot');
  assert.match(textsTo(linked, CHAT)[0], /^✅ Сюди надходитимуть/);
  assert.deepEqual(textsTo(await w.group(CHAT, ADMIN, '/start'), CHAT), ['Цей чат уже отримує сповіщення.']);

  w.step(120);
  w.grid = true;
  assert.ok(textsTo(await w.tick(), CHAT).some((t) => t.startsWith('💡 Світло з')));
});

test('a group is in the people list; the admin widens what it gets, narrows it and removes it', async () => {
  const w = createWorld();
  await w.group(CHAT, ADMIN, undefined, joined);

  const list = (await w.say(ADMIN, '👥 Користувачі'))[0];
  assert.match(list.text, /👤 користувач · 💬 чат · ⏳ чекає/);
  assert.match(list.text, /💬 ⁨Сусіди⁩: Дім 👁/);

  const card = (await w.press(ADMIN, `u:o:${CHAT}`)).find((m) => m.chat === 'edit');
  const buttons = card.markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(buttons.includes('🔔 Усі сповіщення, як адмінам'));
  assert.ok(!buttons.includes('👑 Зробити адміном'));

  const up = await w.press(ADMIN, `a:${CHAT}:admin`);
  assert.match(textsTo(up, CHAT)[0], /^🔔 Цей чат отримуватиме всі сповіщення/);
  assert.equal(textsTo(await notifyAdmins(w), CHAT).length, 1);

  // A release announcement carries the menu keyboard for people, never for the group.
  w.db.exec("UPDATE kv SET v='1.1.0' WHERE k='announced'");
  const news = await w.tick();
  assert.ok(news.find((m) => m.chat === ADMIN).markup.keyboard, 'a person gets the keyboard');
  assert.equal(news.find((m) => m.chat === CHAT).markup, undefined);

  const down = await w.press(ADMIN, `a:${CHAT}:user`);
  assert.match(textsTo(down, CHAT)[0], /^🔕 Цей чат отримуватиме лише/);
  assert.equal(down.find((m) => m.chat === CHAT).markup, undefined);
  assert.equal(textsTo(await notifyAdmins(w), CHAT).length, 0);

  const confirm = (await w.press(ADMIN, `u:r:${CHAT}`)).find((m) => m.chat === 'edit');
  assert.match(confirm.text, /Сповіщення в цей чат більше не надходитимуть\./);
  await w.press(ADMIN, `r:${CHAT}`);
  w.grid = false;
  assert.equal(textsTo(await w.tick(), CHAT).length, 0, 'removed');

  // The admin can link it again; it starts from the default access.
  await w.group(CHAT, ADMIN, '/start@test_bot');
  w.step(120);
  w.grid = true;
  assert.ok(textsTo(await w.tick(), CHAT).some((t) => t.startsWith('💡 Світло з')));
});

test('a group that becomes a supergroup keeps its access; a group the bot left is forgotten', async () => {
  const w = createWorld();
  const NEW = -1009876543210;
  await w.group(CHAT, ADMIN, undefined, joined);
  w.db.exec(`UPDATE user_devices SET perm='control' WHERE chat_id=${CHAT}`);
  w.db.exec(`INSERT INTO kv VALUES ('nosum:${CHAT}','1')`);

  await w.group(CHAT, ADMIN, undefined, { migrate_to_chat_id: NEW });
  await w.group(NEW, ADMIN, undefined, { migrate_from_chat_id: CHAT }); // the other half of the same event
  const rows = w.db.prepare('SELECT chat_id, device, perm FROM user_devices WHERE chat_id<0').all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [{ chat_id: NEW, device: 'site.home', perm: 'control' }]
  );
  assert.equal(w.kv(`nosum:${NEW}`), '1');
  assert.equal(w.kv(`nosum:${CHAT}`), null);

  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, NEW).some((t) => t.startsWith('🔌 Світло зникло')));
  assert.equal(textsTo(off, CHAT).length, 0);

  await w.group(NEW, ADMIN, undefined, { left_chat_member: { id: 5 } }); // a person left, not the bot
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM users WHERE chat_id<0').get().n, 1);

  await w.group(NEW, 99, undefined, { left_chat_member: { id: BOT } });
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM users WHERE chat_id<0').get().n, 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM user_devices WHERE chat_id<0').get().n, 0);
  assert.equal(w.kv(`nosum:${NEW}`), null);
  w.step(120);
  w.grid = true;
  assert.equal(textsTo(await w.tick(), NEW).length, 0);
});

test('the daily summary comes to the group; its off button there is for the group and for an admin', async () => {
  const w = createWorld();
  await w.group(CHAT, ADMIN, undefined, joined);
  await w.tick();
  for (let i = 0; i < 30; i++) {
    w.step(600);
    w.grid = !(i >= 10 && i < 16);
    await w.tick();
  }
  w.step(17 * 3600); // the next morning
  const morning = await w.tick();
  assert.ok(
    morning.some((m) => isSummary(m, CHAT)),
    'the group gets the summary'
  );

  const denied = await w.press(GUEST, 'ns', CHAT);
  assert.deepEqual(textsTo(denied, 'answer'), ['У груповому чаті це вирішує адмін']);
  assert.deepEqual(textsTo(await w.press(99, 'ns', CHAT), 'answer'), ['Немає доступу']);

  const off = await w.press(ADMIN, 'ns', CHAT);
  assert.match(textsTo(off, 'answer')[0], /^Підсумки дня в цьому чаті вимкнено/);
  w.step(86400);
  const next = await w.tick();
  assert.ok(!next.some((m) => isSummary(m, CHAT)), 'off for the group');
  assert.ok(
    next.some((m) => isSummary(m, ADMIN)),
    'the admin still gets their own'
  );
  assert.ok(
    next.some((m) => isSummary(m, GUEST)),
    'and so does the member who was refused'
  );

  await w.press(ADMIN, 'ns', CHAT); // the same button turns it back on
  w.step(86400);
  assert.ok((await w.tick()).some((m) => isSummary(m, CHAT)));
});
