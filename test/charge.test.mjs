import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deyeSetGridCharge } from '../src/deye.js';
import { parseAmps } from '../src/settings.js';
import { ADMIN, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

const SITE = 'home';
const STATE = `chg_state@${SITE}`;
const buttons = (msgs) => msgs.flatMap((m) => m.markup?.inline_keyboard?.flat() || []);
const values = (w) => w.orders.map((o) => o.value);
const state = (w) => JSON.parse(w.kv(STATE) || '{}');
const setting = (w, k) => w.kv(`cfg.${k}@${SITE}`);
const lowTexts = (msgs) => textsTo(msgs, ADMIN).filter((t) => t.startsWith('🐢'));

/** A home whose admin switched "🐢 Заряд після світла" on: 25 A low, 60 A usual (read from the inverter). */
async function enabled(opts = {}) {
  const w = createWorld();
  await w.tick();
  for (const [k, v] of Object.entries(opts)) await w.press(ADMIN, `s:${k}:${SITE}:${v}`);
  const on = await w.press(ADMIN, `s:cT:${SITE}`);
  assert.equal(setting(w, 'chg'), '1', JSON.stringify(on));
  w.deyeCalls = { write: 0, result: 0, read: 0 };
  return w;
}

/** The grid goes (or comes back) and the bot notices on its next check. */
async function grid(w, on) {
  w.step(120);
  w.grid = on;
  return w.tick();
}

/** The clock moves, the inverter's data does not: the logger is offline. */
async function silentFor(w, minutes) {
  const out = [];
  for (let m = 0; m < minutes; m += 2) {
    w.clock += 120;
    out.push(...(await w.tick()));
  }
  return out;
}

test('switching on takes the usual current from the inverter and writes nothing while the grid is there', async () => {
  const w = createWorld();
  await w.tick();
  const card = await w.press(ADMIN, `s:so:${SITE}`);
  assert.ok(buttons(card).some((b) => b.callback_data === `s:cg:${SITE}` && b.text.includes('вимкнено')));

  const on = await w.press(ADMIN, `s:cT:${SITE}`);
  assert.match(on[0].text, /Звичайний струм узято з інвертора: 60 А/);
  assert.equal(setting(w, 'chg'), '1');
  assert.equal(setting(w, 'chg_high'), '60');
  assert.equal(w.deyeCalls.read, 1);

  assert.deepEqual(await w.ticksFor(30), []);
  assert.deepEqual(w.orders, [], 'no command while nothing changes');
  assert.equal(state(w).phase, 'high');
});

test('outage: the low current is written at once; after an hour of stable grid the usual one returns', async () => {
  const w = await enabled();

  const off = await grid(w, false);
  assert.equal(w.orders.length, 1);
  assert.deepEqual(
    { sn: w.orders[0].sn, type: w.orders[0].type, value: w.orders[0].value, keys: w.orders[0].keys },
    { sn: 'SN1', type: 'GRID_CHARGE_AMPERE', value: 25, keys: ['deviceSn', 'paramterType', 'value'] },
    'one parameter and nothing else'
  );
  assert.equal(w.charge, 25, 'the inverter meets the returning grid already limited');
  assert.ok(textsTo(off, ADMIN)[0].startsWith('🔌 Світло зникло'), 'the outage itself is reported first');
  assert.deepEqual(lowTexts(off), [], 'the result of the order is asked for on the next check');

  w.step(120);
  const confirmed = await w.tick();
  assert.deepEqual(lowTexts(confirmed), [
    '🐢 Струм заряду від мережі тепер 25 А.\nБуло 60 А.\nЗвичайний струм повернеться, коли світло буде стабільно 1 год 0 хв.',
  ]);
  assert.ok(!textsTo(confirmed, MEMBER).some((t) => t.startsWith('🐢')), 'admins only');

  await w.ticksFor(60); // still no grid
  assert.deepEqual(values(w), [25], 'nothing is repeated during the outage');

  await grid(w, true);
  const waiting = await w.ticksFor(58);
  assert.deepEqual(values(w), [25], 'the hour is not over yet');
  assert.ok(!waiting.some((m) => m.text.startsWith('⚡')));
  const status = await w.say(ADMIN, '📊 Статус');
  assert.match(status[0].text, /🐢 Заряд від мережі: малий струм 25 А, ще \d+ хв/);

  const raised = await w.ticksFor(4);
  assert.deepEqual(values(w), [25, 60]);
  assert.equal(w.charge, 60);
  assert.ok(
    textsTo(raised, ADMIN).includes('⚡ Світло стабільне 1 год 0 хв: струм заряду від мережі знову 60 А.\nБуло 25 А.')
  );
  assert.deepEqual(
    [w.deyeCalls.write, w.deyeCalls.result],
    [2, 2],
    'two orders and their two results for the whole outage'
  );
  assert.ok(
    w.deyeCalls.read >= 4 && w.deyeCalls.read <= 8,
    w.deyeCalls.read + ' readings of the inverter in two hours'
  );
  assert.deepEqual(
    w.events('charge_set').map((e) => [e.device, e.actor, JSON.parse(e.data).from, JSON.parse(e.data).to]),
    [
      ['i1', 'автоматика', 60, 25],
      ['i1', 'автоматика', 25, 60],
    ]
  );
  assert.equal(state(w).task, null);
});

test('the grid drops again before the wait is over: the wait starts again and nothing is written twice', async () => {
  const w = await enabled();
  await grid(w, false);
  w.step(480);
  await grid(w, true);
  await w.ticksFor(40);

  await grid(w, false);
  await w.ticksFor(10);
  assert.deepEqual(values(w), [25], 'the inverter already holds the low current');

  await grid(w, true);
  await w.ticksFor(56);
  assert.deepEqual(values(w), [25], '40 minutes before the second outage do not count');
  await w.ticksFor(6);
  assert.deepEqual(values(w), [25, 60]);
});

test('every new outage writes the low current, whatever the bot remembers from before', async () => {
  const w = await enabled({ cM: 5 });
  await grid(w, false);
  await grid(w, true);
  await w.ticksFor(10);
  assert.deepEqual(values(w), [25, 60]);

  // The automation is switched off and on; in between the owner changes the current in the Deye app.
  await grid(w, false);
  await w.ticksFor(4);
  await w.press(ADMIN, `s:cT:${SITE}`);
  await grid(w, true);
  await w.press(ADMIN, `s:cT:${SITE}`);
  w.charge = 60;
  await w.ticksFor(10);
  assert.deepEqual(values(w), [25, 60, 25], 'switched on with the grid present: nothing is written');
  assert.equal(state(w).phase, 'high');

  await grid(w, false);
  assert.deepEqual(values(w), [25, 60, 25, 25]);
  assert.equal(w.charge, 25);
});

test('LOW_MINUTES is a setting: 5 minutes for a test', async () => {
  const w = await enabled({ cM: 5 });
  assert.equal(setting(w, 'chg_min'), '5');
  await grid(w, false);
  await grid(w, true);
  await w.ticksFor(4);
  assert.deepEqual(values(w), [25]);
  await w.ticksFor(2);
  assert.deepEqual(values(w), [25, 60]);
});

test('no data for longer than N minutes counts as an outage; the usual current needs fresh data with grid', async () => {
  const w = await enabled();
  const quiet = await silentFor(w, 10);
  assert.deepEqual(values(w), [], 'ten minutes is still within N');
  assert.deepEqual(lowTexts(quiet), []);

  const gap = await silentFor(w, 4);
  assert.deepEqual(values(w), [25]);
  assert.ok(lowTexts(gap)[0].includes('Даних від інвертора немає довше 10 хв.'));

  await silentFor(w, 120);
  assert.deepEqual(values(w), [25], 'without data the current is never raised');

  w.deyeTs = w.clock; // the logger is back, the grid is there
  await w.tick();
  await w.ticksFor(58);
  assert.deepEqual(values(w), [25]);
  await w.ticksFor(4);
  assert.deepEqual(values(w), [25, 60]);
});

test('the cloud does not answer for longer than N minutes: the low current is asked for as well', async () => {
  const w = await enabled();
  w.deyeFails = Infinity;
  await w.ticksFor(10);
  assert.deepEqual(values(w), []);
  await w.ticksFor(4);
  assert.deepEqual(values(w), [25]);
  assert.equal(state(w).phase, 'low');
});

test('a rejected write is retried with growing pauses, with one alert; only the low current is ever sent', async () => {
  const w = await enabled();
  w.writeFails = Infinity;
  const first = await grid(w, false);
  assert.equal(w.deyeCalls.write, 1);
  assert.ok(!first.some((m) => m.text.startsWith('⚠️ Не вдається')), 'no alert on the first failure');

  const second = await w.ticksFor(2);
  assert.equal(w.deyeCalls.write, 2, 'the first retry comes with the next check');
  assert.ok(!second.some((m) => m.text.startsWith('⚠️ Не вдається')));

  const later = await w.ticksFor(120);
  const alerts = textsTo(later, ADMIN).filter((t) => t.startsWith('⚠️ Не вдається записати струм заряду'));
  assert.equal(alerts.length, 1, 'one alert');
  assert.match(alerts[0], /25 А вже \d+ хв[\s\S]*Бот пробуватиме далі\.[\s\S]*2104006 device offline/);
  assert.equal(w.deyeCalls.write, 7, 'attempts after 0, 2, 6, 14, 29, 59 and 119 minutes: the cloud is metered');
  assert.deepEqual(w.orders, []);
  assert.equal(w.charge, 60, 'nothing else was written in the meantime');

  w.writeFails = 0;
  const done = await w.ticksFor(64);
  assert.deepEqual(values(w), [25]);
  assert.equal(lowTexts(done).length, 1);
});

test('a write rejected while the inverter was offline is repeated as soon as it reports again', async () => {
  const w = await enabled();
  w.writeFails = Infinity;
  await silentFor(w, 60); // logger offline: N passes, the writes are rejected and back off
  const attempts = w.deyeCalls.write;
  assert.ok(attempts >= 2 && attempts <= 5, String(attempts));

  w.writeFails = 0;
  w.deyeTs = w.clock;
  w.step(120);
  await w.tick();
  assert.deepEqual(values(w), [25], 'no waiting for the pause to run out');
});

test('data that comes and goes does not turn the retries into a stream of requests', async () => {
  const w = await enabled();
  w.writeFails = Infinity;
  await grid(w, false);
  for (let i = 0; i < 60; i++) {
    w.step(120);
    w.deyeFails = i % 2 ? 0 : 1; // every other check the cloud gives no reading
    await w.tick();
  }
  assert.ok(w.deyeCalls.write <= 12, `${w.deyeCalls.write} write attempts in two hours`);
});

test('the inverter does not carry out the raise: the low current stays, the bot tries again later', async () => {
  const w = await enabled({ cM: 5 });
  await grid(w, false);
  await grid(w, true);

  w.orderFail = true;
  const failing = await w.ticksFor(8);
  assert.deepEqual(values(w), [25, 60, 60], 'sent when the wait is over, and once more after a pause');
  assert.equal(w.charge, 25, 'a failed raise leaves the low current');
  assert.ok(!failing.some((m) => m.text.startsWith('⚡')), 'nothing is reported as done');

  w.orderFail = false;
  const done = await w.ticksFor(4);
  assert.equal(w.charge, 60);
  assert.ok(done.some((m) => m.text.startsWith('⚡')));
  assert.ok(
    values(w).every((v) => v === 25 || v === 60),
    'only the two configured values are ever sent'
  );
});

test('an order the cloud keeps in its queue is confirmed later, without sending it again', async () => {
  const w = await enabled();
  w.orderPending = 2;
  await grid(w, false);
  assert.equal(state(w).task.order, w.orders[0].id, 'the 64-bit order id is kept digit for digit');
  assert.equal(w.charge, 60, 'the inverter has not carried it out yet');

  const later = await w.ticksFor(10);
  assert.deepEqual(values(w), [25]);
  assert.equal(w.charge, 25);
  assert.equal(lowTexts(later).length, 1);
  assert.equal(state(w).task, null);
});

test('a raise still in the cloud queue when the grid drops: low is written, and written again if the raise lands later', async () => {
  const w = await enabled({ cM: 5 });
  await grid(w, false);
  await grid(w, true);
  w.orderPending = Infinity;
  await w.ticksFor(6);
  assert.deepEqual(values(w), [25, 60], 'the raise is sent and not confirmed');
  assert.equal(w.charge, 25);

  await grid(w, false);
  assert.deepEqual(values(w), [25, 60, 25]);
  const told = await w.ticksFor(4);
  assert.equal(lowTexts(told).length, 1, 'the admins hear about the low current once it is confirmed');
  assert.equal(state(w).task.prev, w.orders[1].id, 'the old order is still watched');

  w.land(w.orders[1]); // the stale raise reaches the inverter after all
  assert.equal(w.charge, 60);
  const fixed = await w.ticksFor(4);
  assert.deepEqual(values(w), [25, 60, 25, 25]);
  assert.equal(w.charge, 25, 'the low current is back');
  assert.deepEqual(lowTexts(fixed), [], 'no second message');
  assert.equal(state(w).task, null);
});

test('the cloud takes one command at a time: low waits its turn and still gets through', async () => {
  const w = await enabled({ cM: 5 });
  w.exclusive = true;
  await grid(w, false);
  await grid(w, true);
  w.orderPending = Infinity;
  await w.ticksFor(6);
  assert.deepEqual(values(w), [25, 60]);

  await grid(w, false);
  assert.deepEqual(values(w), [25, 60], 'rejected: the raise is still being sent');
  w.land(w.orders[1]);
  assert.equal(w.charge, 60);
  await w.ticksFor(2);
  assert.equal(w.charge, 25);
  await w.ticksFor(6);
  assert.equal(w.charge, 25);
  assert.equal(state(w).task, null);
});

test('the state is saved before the order goes out: a failed save sends nothing, a lost save repeats the write', async () => {
  const w = await enabled({ cM: 5 });
  w.d1.fail = (q, args) => q.startsWith('INSERT INTO kv') && args[0] === STATE;
  await grid(w, false);
  assert.deepEqual(values(w), [], 'the state could not be saved, so nothing was sent');
  w.d1.fail = null;
  await w.ticksFor(2);
  assert.deepEqual(values(w), [25]);
  await w.ticksFor(2);

  // The raise is sent, but the save after it fails; the grid drops before the next check.
  await grid(w, true);
  await w.ticksFor(4);
  let saves = 0;
  w.d1.fail = (q, args) => q.startsWith('INSERT INTO kv') && args[0] === STATE && ++saves > 1;
  w.orderPending = Infinity;
  await w.ticksFor(2);
  w.d1.fail = null;
  assert.deepEqual(values(w), [25, 60]);
  assert.equal(state(w).task.sending, true, 'what is on disk says an order may be out');

  await grid(w, false);
  assert.deepEqual(values(w), [25, 60, 25], 'the low current is written although the raise was never recorded');
  w.land(w.orders[1]); // the unrecorded raise lands late
  await w.ticksFor(10);
  assert.equal(w.charge, 25, 'and is written once more, because that raise could not be asked about');
});

test('"write now" shows the exact request and sends it only after a confirmation', async () => {
  const w = await enabled();
  const menu = await w.press(ADMIN, `s:cw:${SITE}`);
  assert.deepEqual(
    buttons(menu).map((b) => b.callback_data),
    [`s:cv:${SITE}:low`, `s:cv:${SITE}:high`, `s:cg:${SITE}`]
  );
  const preview = await w.press(ADMIN, `s:cv:${SITE}:low`);
  assert.ok(
    preview[0].text.includes(
      'POST https://eu1-developer.deyecloud.com/v1.0/order/battery/parameter/update\n{"deviceSn":"SN1","paramterType":"GRID_CHARGE_AMPERE","value":25}'
    ),
    preview[0].text
  );
  assert.deepEqual(w.orders, [], 'nothing is sent before the admin agrees');

  const sent = await w.press(ADMIN, `s:cW:${SITE}:low`);
  assert.deepEqual(values(w), [25]);
  assert.equal(w.charge, 25);
  assert.ok(textsTo(sent, ADMIN).includes('✍️ Струм заряду від мережі тепер 25 А: Admin.\nБуло 60 А.'));

  await w.ticksFor(10);
  assert.deepEqual(values(w), [25], 'with the grid present a manual value stays');
});

test('while the low current is in force the usual one cannot be written by hand', async () => {
  const w = await enabled();
  await grid(w, false);
  await w.ticksFor(2);

  const menu = await w.press(ADMIN, `s:cw:${SITE}`);
  assert.ok(!buttons(menu).some((b) => b.callback_data.endsWith(':high')));
  const forced = await w.press(ADMIN, `s:cW:${SITE}:high`); // a button from an older message
  assert.match(forced[0].text, /Зараз діє малий струм/);
  assert.deepEqual(values(w), [25]);
  assert.equal(w.charge, 25);

  await grid(w, true); // the wait for stable grid is the low phase too
  await w.press(ADMIN, `s:cW:${SITE}:high`);
  assert.deepEqual(values(w), [25]);
});

test('a manual write to an unreachable inverter is given up after 10 minutes, with a message', async () => {
  const w = await enabled();
  w.writeFails = Infinity;
  const sent = await w.press(ADMIN, `s:cW:${SITE}:low`);
  assert.match(sent[0].text, /Поки не відправлено[\s\S]*2104006/);
  const later = await w.ticksFor(60);
  const alerts = textsTo(later, ADMIN).filter((t) => t.startsWith('⚠️ Не вдається записати'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Запис скасовано/);
  assert.equal(state(w).task, null);
  assert.ok(w.deyeCalls.write <= 4, String(w.deyeCalls.write));
});

test('the current changed in the settings while its write is open: the write follows the setting', async () => {
  const w = await enabled({ cM: 5 });
  await grid(w, false);
  await grid(w, true);
  w.writeFails = Infinity;
  await w.ticksFor(6);
  assert.equal(state(w).task.target, 60);

  await w.press(ADMIN, `s:ch:${SITE}`);
  await w.say(ADMIN, '40');
  w.writeFails = 0;
  await w.ticksFor(20);
  assert.deepEqual(values(w), [25, 40]);
  assert.equal(w.charge, 40);
});

test('settings are checked: whole amperes, never zero, usual above low', async () => {
  assert.equal(parseAmps('25'), 25);
  assert.equal(parseAmps('25 А'), 25);
  for (const bad of ['0', '-5', '2.5', '25,5', '999', 'abc', '']) assert.equal(parseAmps(bad), null, bad);

  const w = await enabled();
  await w.press(ADMIN, `s:cl:${SITE}`);
  assert.match((await w.say(ADMIN, '0'))[0].text, /Не підходить/);
  assert.match((await w.say(ADMIN, '60'))[0].text, /звичайний струм має бути більшим за малий/);
  assert.equal(setting(w, 'chg_low'), null);
  await w.say(ADMIN, '20');
  assert.equal(setting(w, 'chg_low'), '20');

  await w.press(ADMIN, `s:ch:${SITE}`);
  assert.match((await w.say(ADMIN, '15'))[0].text, /Не підходить/);
  await w.say(ADMIN, '80');
  assert.equal(setting(w, 'chg_high'), '80');
  assert.deepEqual(w.orders, [], 'changing a setting writes nothing by itself');

  await assert.rejects(deyeSetGridCharge({ env: w.env, cacheKey: 'deye_token' }, 'SN1', 0), /недопустимий струм/);
  await assert.rejects(deyeSetGridCharge({ env: w.env, cacheKey: 'deye_token' }, 'SN1', 2.5), /недопустимий струм/);
  assert.equal(w.deyeCalls.write, 0, 'zero never reaches the cloud');
});

test('switched off, the bot sends nothing; other clouds have no such setting', async () => {
  const w = await enabled();
  const off = await w.press(ADMIN, `s:cT:${SITE}`);
  assert.equal(setting(w, 'chg'), '0');
  assert.match(off[0].text, /Зараз: вимкнено/);
  await grid(w, false);
  await w.ticksFor(20);
  assert.deepEqual(w.orders, []);
  assert.deepEqual(w.deyeCalls, { write: 0, result: 0, read: 0 });

  const dess = createWorld().useDess();
  await dess.tick();
  const card = await dess.press(ADMIN, `s:so:${SITE}`);
  assert.ok(!buttons(card).some((b) => b.callback_data.startsWith('s:cg')));
});

test('if the inverter cannot be read, the usual current is asked for and nothing is switched on', async () => {
  const w = createWorld();
  await w.tick();
  w.readFails = 1;
  const on = await w.press(ADMIN, `s:cT:${SITE}`);
  assert.match(on[0].text, /Не вдалося зчитати струм з інвертора[\s\S]*Не ввімкнено: не вказано звичайний струм/);
  assert.equal(setting(w, 'chg'), null);
});

test('a deleted site takes its charge settings with it: a new site with the same id starts clean', async () => {
  const w = createWorld();
  for (const k of ['DEYE_SN', 'MIDEA_DEVICE_ID', 'TZ']) delete w.env[k];
  await w.tick();
  await w.press(ADMIN, 's:sa');
  await w.say(ADMIN, 'Дім');
  await w.press(ADMIN, 's:sc:deye');
  await w.press(ADMIN, 's:sk:1');
  await w.press(ADMIN, 's:sp:0');
  await w.press(ADMIN, 's:cT:s1');
  assert.equal(w.kv('cfg.chg@s1'), '1');
  assert.equal(w.kv('cfg.chg_high@s1'), '60');
  assert.notEqual(w.kv('chg_state@s1'), null);

  await w.press(ADMIN, 's:sD:s1');
  for (const k of ['cfg.chg@s1', 'cfg.chg_high@s1', 'chg_state@s1']) assert.equal(w.kv(k), null, k);
});

/* ---------- the inverter is read back: the cloud's "carried out" is not the last word ---------- */

test('after the write the inverter is read; a value that did not stay is written again, and the admins are told why', async () => {
  const w = await enabled();
  await grid(w, false);
  w.step(120);
  const confirmed = await w.tick();
  assert.equal(lowTexts(confirmed).length, 1);
  assert.equal(w.deyeCalls.read, 0, 'the reading comes with the next check');

  w.charge = 60; // the inverter's screen wrote the old value back
  w.step(120);
  const fixed = await w.tick();
  assert.equal(w.deyeCalls.read, 1);
  assert.deepEqual(values(w), [25, 25]);
  assert.equal(w.charge, 25);
  assert.deepEqual(lowTexts(fixed), [
    '🐢 Струм заряду від мережі тепер 25 А.\nБуло 60 А.\nВ інверторі це значення змінили не через бот, тому його записано знову.\nЗвичайний струм повернеться, коли світло буде стабільно 1 год 0 хв.',
  ]);

  w.step(120);
  await w.tick();
  assert.equal(w.deyeCalls.read, 2, 'the rewrite is read back as well');
  assert.deepEqual(values(w), [25, 25]);
  assert.equal(state(w).redo, 0);
});

test('during a long outage the inverter is read every half an hour, and once more when the grid returns', async () => {
  const w = await enabled();
  await grid(w, false);
  await w.ticksFor(120);
  assert.deepEqual(values(w), [25]);
  assert.ok(w.deyeCalls.read >= 4 && w.deyeCalls.read <= 5, `${w.deyeCalls.read} readings in two hours`);

  w.charge = 60; // changed in the vendor's app a minute before the grid returns
  const before = w.deyeCalls.read;
  await grid(w, true);
  assert.equal(w.deyeCalls.read, before + 1, 'read at the moment the low current matters');
  assert.deepEqual(values(w), [25, 25]);
  assert.equal(w.charge, 25);
});

test('the grid comes back and goes again within the wait: the inverter is asked instead of trusted', async () => {
  const w = await enabled();
  await grid(w, false);
  await w.ticksFor(4);
  await grid(w, true);
  await w.ticksFor(10);
  const reads = w.deyeCalls.read;
  w.charge = 60; // raised by hand in the vendor's app during the wait
  await grid(w, false);
  assert.equal(w.deyeCalls.read, reads + 1);
  assert.deepEqual(values(w), [25, 25], 'the second outage does not start with the usual current');
  assert.equal(w.charge, 25);
});

test('the raise is read back once; then the bot leaves the inverter alone', async () => {
  const w = await enabled({ cM: 5 });
  await grid(w, false);
  await grid(w, true);
  await w.ticksFor(8);
  assert.deepEqual(values(w), [25, 60]);
  const reads = w.deyeCalls.read;
  await w.ticksFor(240);
  assert.equal(
    w.deyeCalls.read - reads <= 1,
    true,
    'no reading in the usual phase after the raise is seen in the inverter'
  );
  assert.equal(state(w).check, 0);
  assert.deepEqual(w.deyeCalls.write, 2);
});

test('a value that never stays: three rewrites, one message, then a slower pace', async () => {
  const w = await enabled();
  await grid(w, false);
  const sent = [];
  for (let i = 0; i < 90; i++) {
    w.charge = 60; // something keeps writing the old value back
    w.step(120);
    sent.push(...(await w.tick()));
  }
  const drift = textsTo(sent, ADMIN).filter((t) => t.startsWith('⚠️ Струм заряду від мережі 25 А не тримається'));
  assert.equal(drift.length, 1);
  assert.match(drift[0], /в ньому знову 60 А[\s\S]*Бот пробуватиме далі, але рідше\./);
  assert.ok(w.deyeCalls.write <= 12, `${w.deyeCalls.write} writes in three hours`);
  assert.ok(values(w).every((v) => v === 25));
});

test('the inverter cannot be read: nothing is rewritten and nobody is alarmed', async () => {
  const w = await enabled();
  w.readFails = Infinity;
  const sent = [await grid(w, false), await w.ticksFor(120)].flat();
  assert.deepEqual(values(w), [25]);
  assert.equal(lowTexts(sent).length, 1);
  assert.ok(!sent.some((m) => m.text.startsWith('⚠️')));
  assert.ok(w.deyeCalls.read <= 16, `${w.deyeCalls.read} attempts to read in two hours`);
});
