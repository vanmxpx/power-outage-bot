/**
 * Soft start of grid charging. When the grid returns, every inverter in the building starts
 * charging at full current at the same moment, which can overload the building's wiring.
 * So the grid-charge current is kept low for the first while and raised afterwards:
 *
 *   grid lost, or no data for longer than `gap` min → phase "low": write `low` A at once.
 *       The inverter then meets the returning grid already limited.
 *   grid present for `minutes` min without a break   → phase "high": write `high` A.
 *       A break in between starts the wait again.
 *
 * Rules:
 *   - the only values ever written are the site's own `low` and `high`, and only to the
 *     grid-charge current: no other inverter setting is touched, charging is never
 *     switched off and zero is never written;
 *   - a write happens on a phase change (or when the admin asks), and only if the value
 *     differs from the one confirmed in the inverter (`known`). A value confirmed in
 *     another phase is not trusted: every new outage writes `low`;
 *   - every doubt resolves to "low": the current is raised only on fresh data that shows
 *     the grid, a failed or unconfirmed raise leaves the low current in place, and while
 *     the low current is in force the admin cannot raise it by hand;
 *   - a write is a task that stays open until the cloud confirms the order. The state is
 *     saved before the order is sent, so a crash in between repeats the write instead of
 *     forgetting it. An order that was replaced before the cloud answered for it is
 *     watched to its end: if it lands after the newer one, the newer value is written again;
 *   - retries back off (CHARGE_RETRY_SEC), because the cloud's API is metered, and start
 *     again at once when the inverter comes back online.
 *
 * Settings of a site (⚙️ → 🏠 Об'єкти → об'єкт → 🐢 Заряд після світла):
 *   chg@<site> "1" on · chg_low@ A · chg_high@ A · chg_min@ minutes · chg_gap@ minutes.
 * State: one JSON value per site, kv "chg_state@<site>".
 */

import {
  CHARGE_AMPS_MAX,
  CHARGE_CONFIRM_MS,
  CHARGE_GAP_MIN_DEFAULT,
  CHARGE_LOW_A_DEFAULT,
  CHARGE_LOW_MIN_DEFAULT,
  CHARGE_ORDER_STALE_SEC,
  CHARGE_RETRY_SEC,
  CHARGE_SETTLE_SEC,
  CHARGE_SLACK_SEC,
  CHARGE_WATCH_TRIES,
  GIVEUP_SEC,
  sitesOf,
} from './config.js';
import { kvGet, kvSet, logEvent } from './db.js';
import { chargeControl } from './inverter.js';
import { render } from './messages.js';
import { broadcast } from './telegram.js';
import { fmtDur, now, sleep } from './util.js';

const AUTOMATION = 'автоматика';

/** An order of unknown id: it was being sent when the invocation ended. */
const UNKNOWN_ORDER = '?';

/** Storage key of a site's charge state. */
export const chargeKey = (site) => `chg_state@${site.id}`;

/** Event-log device of a site's charge events: its inverter. */
export const chargeDevice = (site) => site.source || `site.${site.id}`;

/**
 * @typedef {object} ChargeSettings
 * @property {boolean} on the automation is switched on
 * @property {number} low A while the grid is away and right after it returns
 * @property {number | null} high A the rest of the time; null until it is set
 * @property {number} minutes how long the grid must be present before `high` is written
 * @property {number} gap minutes without data that count as "the grid may be gone"
 */

/** @returns {ChargeSettings} */
export function chargeSettings(env, site) {
  const s = env.CFG?.settings || {};
  const num = (k, def) => {
    const v = Number(s[`${k}@${site.id}`]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    on: s[`chg@${site.id}`] === '1',
    low: num('chg_low', CHARGE_LOW_A_DEFAULT),
    high: num('chg_high', null),
    minutes: num('chg_min', CHARGE_LOW_MIN_DEFAULT),
    gap: num('chg_gap', CHARGE_GAP_MIN_DEFAULT),
  };
}

/** A current the bot agrees to write: a whole number of amperes, never zero. */
export const validAmps = (a) => Number.isInteger(a) && a >= 1 && a <= CHARGE_AMPS_MAX;

/** Why the settings cannot be used, or null when they can. @param {ChargeSettings} cfg */
export function settingsProblem(cfg) {
  if (!validAmps(cfg.low)) return `малий струм має бути цілим числом від 1 до ${CHARGE_AMPS_MAX} А`;
  if (cfg.high === null) return 'не вказано звичайний струм';
  if (!validAmps(cfg.high)) return `звичайний струм має бути цілим числом від 1 до ${CHARGE_AMPS_MAX} А`;
  if (cfg.high <= cfg.low) return 'звичайний струм має бути більшим за малий';
  return null;
}

/**
 * @typedef {object} ChargeTask an open write
 * @property {number} target A
 * @property {'low' | 'high' | 'manual'} kind what it is for
 * @property {string} actor "автоматика" or the admin's name
 * @property {number} since when it was opened
 * @property {string} [why] for "low": "off" (grid lost) or "gap" (no data)
 * @property {number | null} [was] value known to be in the inverter before the write
 * @property {boolean} [sending] saved just before the order is sent, cleared when the cloud answers
 * @property {string} [order] the cloud order of this write
 * @property {number} [sent] when that order was sent
 * @property {boolean} [confirmed] the cloud reported that order as carried out
 * @property {string} [prev] an older order with another value that the cloud has not answered for
 * @property {boolean} [told] the admins know the value is written; the task only watches `prev`
 * @property {number} tries failed attempts and unanswered checks in a row
 * @property {number} next not before this time
 * @property {boolean} [blind] the last failure happened while the inverter sent no data
 * @property {boolean} [alerted] the admins were told it is taking long
 * @property {string} [error] last failure
 */

/**
 * @typedef {object} ChargeState
 * @property {'low' | 'high' | null} phase
 * @property {number} ok since when the grid has been present in the low phase; 0 — not yet
 * @property {number | null} known A confirmed in the inverter; null while unknown
 * @property {ChargeTask | null} task
 */

/** The stored state with its saver; saving is skipped when nothing changed. */
async function load(env, site) {
  let raw = await kvGet(env, chargeKey(site));
  let st = {};
  try {
    st = JSON.parse(raw || '{}') || {};
  } catch {
    /* an unreadable state starts over */
  }
  /** @type {ChargeState} */
  const state = {
    phase: st.phase === 'low' || st.phase === 'high' ? st.phase : null,
    ok: Number(st.ok) || 0,
    known: Number.isFinite(st.known) ? st.known : null,
    task: st.task || null,
  };
  return {
    st: state,
    used: raw !== null,
    async save() {
      const next = JSON.stringify(state);
      if (next === raw) return;
      await kvSet(env, chargeKey(site), next);
      raw = next;
    },
  };
}

const vars = (env, site) => ({ where: sitesOf(env).length > 1 ? `${site.name} · ` : '', object: site.name });

/** Pause before the next attempt. A task that only watches an older order looks every check for a while. */
function pause(t) {
  if (t.told && t.tries <= CHARGE_WATCH_TRIES) return CHARGE_RETRY_SEC[0];
  const n = t.told ? t.tries - CHARGE_WATCH_TRIES : t.tries;
  return CHARGE_RETRY_SEC[Math.min(n, CHARGE_RETRY_SEC.length) - 1];
}

/**
 * Opens a write; an unfinished one is replaced (the newer intent wins). An order of the
 * replaced write that the cloud has not answered for is remembered as `prev`.
 * @param {number | null} was the value known before
 */
function open(st, kind, target, actor, why, was = st.known) {
  const old = st.task;
  const prev = (!old?.confirmed && old?.order) || old?.prev || (old?.sending ? UNKNOWN_ORDER : null);
  st.task = { kind, target, actor, why, was, since: now(), tries: 0, next: 0, ...(prev ? { prev } : {}) };
}

/** The value is confirmed in the inverter (or was there already): log it and tell the admins, once. */
async function tell(env, site, st, cfg) {
  const t = st.task;
  if (t.told) return;
  t.told = true;
  await logEvent(env, 'charge_set', chargeDevice(site), t.actor, {
    kind: t.kind,
    from: t.was ?? null,
    to: t.target,
    order: t.order || null,
    why: t.why || null,
  });
  const v = {
    ...vars(env, site),
    amps: t.target,
    was: Number.isFinite(t.was) && t.was !== t.target ? t.was : '',
    gap: t.why === 'gap' ? cfg.gap : '',
    duration: fmtDur(cfg.minutes * 60),
    who: t.actor,
  };
  const tpl = t.kind === 'low' ? 'charge_low' : t.kind === 'high' ? 'charge_high' : 'charge_manual';
  await broadcast(env, render(env, tpl, v), 'admin');
}

/** Not now: look again after a pause. */
function later(st, error, usable) {
  const t = st.task;
  t.tries += 1;
  t.next = now() + pause(t);
  t.error = String(error?.message || error);
  if (usable) delete t.blind;
  else t.blind = true;
}

/**
 * An attempt failed: back off, and tell the admins once when it has been failing for
 * GIVEUP_SEC. A manual write is given up at that point; an automatic one goes on.
 */
async function failed(env, site, st, error, usable) {
  const t = st.task;
  later(st, error, usable);
  if (t.alerted || now() - t.since < GIVEUP_SEC) return;
  t.alerted = true;
  const manual = t.kind === 'manual';
  if (manual) st.task = null;
  await logEvent(env, 'charge_fail', chargeDevice(site), t.actor, { to: t.target, error: t.error });
  const v = {
    ...vars(env, site),
    amps: t.target,
    duration: fmtDur(now() - t.since),
    error: t.error,
    next: manual ? 'Запис скасовано. Спробуй ще раз, коли інвертор буде на зв’язку.' : 'Бот пробуватиме далі.',
  };
  await broadcast(env, render(env, 'charge_failed', v), 'admin');
}

/**
 * One step of the open write: send the order if it is not sent yet, ask for its result,
 * then see an older order to its end.
 * @param {{st: ChargeState, save: () => Promise<void>}} box
 * @param {boolean} usable the inverter reported fresh data in this check
 * @param {boolean} inline ask for the result of a fresh order within this invocation
 */
async function work(env, site, box, cfg, usable, inline) {
  const { st } = box;
  const t = st.task;
  if (!t) return;
  // The inverter is back online: do not sit out a pause earned while it was away.
  if (usable && t.blind) {
    t.next = 0;
    delete t.blind;
  }
  if (now() + CHARGE_SLACK_SEC < t.next) return;
  const ctl = chargeControl(env, site);
  // The cloud or the settings may have changed since the task was opened.
  if (!ctl || !validAmps(t.target)) return void (st.task = null);

  // Lost in the cloud while the inverter is online: send again, and keep an eye on the old order.
  if (t.order && !t.confirmed && usable && now() - t.sent > CHARGE_ORDER_STALE_SEC) {
    t.prev = t.order;
    delete t.order;
  }

  if (!t.order) {
    if (st.known === t.target && !t.prev) {
      await tell(env, site, st, cfg); // already there: nothing to write
      return void (st.task = null);
    }
    st.known = null; // from here the value in the inverter is uncertain until the cloud confirms
    t.sending = true;
    await box.save(); // before the order: if the state cannot be saved, nothing is sent
    try {
      const sent = await ctl.write(t.target);
      t.order = sent.order;
      t.sent = now();
    } catch (e) {
      delete t.sending;
      return failed(env, site, st, e, usable);
    }
    delete t.sending;
    if (!inline) return; // the next check asks for the result
    await sleep(CHARGE_CONFIRM_MS);
  }

  if (!t.confirmed) {
    let res;
    try {
      res = await ctl.result(t.order);
    } catch (e) {
      return failed(env, site, st, e, usable);
    }
    if (res.state === 'failed') {
      delete t.order; // the next attempt sends it again
      return failed(env, site, st, `інвертор не виконав команду (${res.detail})`, usable);
    }
    if (res.state !== 'done') return failed(env, site, st, `команда ще в черзі хмари (${res.detail})`, usable);
    t.confirmed = true;
    t.tries = 0;
    st.known = t.target;
    await tell(env, site, st, cfg);
  }
  if (!t.prev) return void (st.task = null);

  // An older order with another value may still land after this one: see it to its end.
  const again = () => {
    delete t.prev;
    delete t.order;
    delete t.confirmed;
    st.known = null;
  };
  if (t.prev === UNKNOWN_ORDER) {
    // Its id is unknown, so it cannot be asked about: write our value once more after a while.
    again();
    t.next = now() + CHARGE_SETTLE_SEC;
    return;
  }
  let old;
  try {
    old = await ctl.result(t.prev);
  } catch (e) {
    return later(st, e, usable);
  }
  if (old.state === 'pending') return later(st, `стара команда ще в черзі хмари (${old.detail})`, usable);
  if (old.state !== 'done') return void (st.task = null); // it never reached the inverter
  again(); // it was carried out, perhaps after ours: write our value once more
  return work(env, site, box, cfg, usable, inline);
}

/**
 * Called from the periodic check for every site, after everything else.
 * @param {import('./deye.js').Reading | null} d the latest reading; null when the cloud did not answer
 * @param {number} [downSince] since when the cloud has not answered
 */
export async function chargeTick(env, site, d, downSince = 0) {
  if (!chargeControl(env, site)) return; // this cloud cannot set the current
  const cfg = chargeSettings(env, site);
  const box = await load(env, site);
  if (!cfg.on && !box.used) return; // never used at this site
  const { st } = box;
  const t = now();
  const ts = d ? Math.min(d.ts, t) : 0; // a logger whose clock runs ahead must not look fresher than now
  const usable = Boolean(d && d.grid !== null && t - ts <= cfg.gap * 60);

  if (cfg.on && !settingsProblem(cfg)) {
    const silent = d ? t - ts : downSince ? t - downSince : 0;
    const gone = usable ? !d.grid : silent > cfg.gap * 60;

    if (gone) {
      const was = st.known;
      if (st.phase !== 'low') st.known = null; // a new outage: what another phase confirmed is not trusted
      st.phase = 'low';
      st.ok = 0;
      const pending = st.task?.kind === 'low' && st.task.target === cfg.low;
      if (!pending) {
        if (st.known !== cfg.low) open(st, 'low', cfg.low, AUTOMATION, usable ? 'off' : 'gap', was);
        else st.task = null; // the inverter already holds the low current
      }
    } else if (usable) {
      if (st.phase === null) st.phase = 'high'; // switched on with the grid present: nothing to write
      if (st.phase === 'low') {
        if (!st.ok) st.ok = ts;
        else if (ts - st.ok >= cfg.minutes * 60) {
          st.phase = 'high';
          st.ok = 0;
          open(st, 'high', cfg.high, AUTOMATION);
        }
      }
    }
    // Otherwise: a short gap in the data. Nothing is known, nothing changes.

    // The admin changed the current while its write was open: the write follows the setting.
    const k = st.task?.kind;
    if ((k === 'low' || k === 'high') && st.task.target !== cfg[k] && !st.task.told) {
      open(st, k, cfg[k], AUTOMATION, st.task.why, st.task.was);
    }
  } else {
    // Switched off (or the settings are unusable): forget the phase and the automatic write.
    st.phase = null;
    st.ok = 0;
    if (st.task && st.task.kind !== 'manual') st.task = null;
  }

  try {
    // The check in which the grid disappears is the busiest one: the result of "low" waits for the next.
    await work(env, site, box, cfg, usable, st.task?.kind !== 'low');
  } finally {
    await box.save();
  }
}

/**
 * The admin's "write now": sends the order at once. If the cloud does not confirm it
 * within seconds, the periodic check follows it up and reports.
 * @param {'low' | 'high'} which
 * @returns {Promise<ChargeTask | null>} the task still open, or null when it is done
 */
export async function chargeManual(env, site, which, actor) {
  const cfg = chargeSettings(env, site);
  const amps = which === 'high' ? cfg.high : cfg.low;
  if (!validAmps(amps)) throw new Error(`Струм має бути від 1 до ${CHARGE_AMPS_MAX} А`);
  const box = await load(env, site);
  const { st } = box;
  if (which === 'high' && cfg.on && st.phase === 'low') {
    throw new Error(
      'Зараз діє малий струм: світла немає або воно ще не стабільне. Щоб записати звичайний, спершу вимкни «Заряд після світла»'
    );
  }
  const was = st.known;
  st.known = null; // the admin asks for a write: do not skip it on the bot's own knowledge
  open(st, 'manual', amps, actor, undefined, was);
  try {
    await work(env, site, box, cfg, true, true);
  } finally {
    await box.save();
  }
  return st.task;
}

/** Reads the current from the inverter and remembers it. @returns {Promise<number>} A */
export async function chargeRead(env, site) {
  const ctl = chargeControl(env, site);
  if (!ctl) throw new Error('Хмара цього інвертора не дає керувати струмом заряду');
  const amps = await ctl.read();
  const box = await load(env, site);
  if (!box.st.task) {
    box.st.known = amps;
    await box.save();
  }
  return amps;
}

/** Switching the automation on or off starts from a clean slate: no phase, nothing assumed about the inverter. */
export async function chargeReset(env, site) {
  const box = await load(env, site);
  Object.assign(box.st, { phase: null, ok: 0, known: null });
  if (box.st.task && box.st.task.kind !== 'manual') box.st.task = null;
  await box.save();
}

/** For the status and the settings screen: the phase and how long the low current still lasts. */
export async function chargeSummary(env, site) {
  const cfg = chargeSettings(env, site);
  const { st } = await load(env, site);
  const left = st.phase === 'low' && st.ok ? Math.max(0, st.ok + cfg.minutes * 60 - now()) : null;
  return { cfg, phase: st.phase, left, known: st.known, task: st.task };
}
