/** Deye Cloud OpenAPI client: token handling, latest inverter reading, station list, grid-charge current. */

/* global AbortSignal */

import {
  CHARGE_HTTP_TIMEOUT_MS,
  CHARGE_READ_TRIES,
  CHARGE_READ_WAIT_MS,
  DEFAULT_DEYE_API,
  GRID_HZ_MIN,
  GRID_V_MIN,
} from './config.js';
import { kvGet, kvSet } from './db.js';
import { hash, now, sleep } from './util.js';

/** Deye answers success with several codes, as string or number. */
const OK_CODES = ['0', '1000000', '1106000', 0, 1000000, 1106000];

/** Refresh the token a day before it expires. */
const TOKEN_MARGIN_SEC = 86400;

/**
 * @typedef {object} DeyeConn one DeyeCloud account
 * @property {import('./config.js').Env} env
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} email
 * @property {string} password
 * @property {string} [api] regional OpenAPI address
 * @property {string} cacheKey storage key of the cached token
 */

const baseUrl = (c) => c.api || DEFAULT_DEYE_API;

/**
 * @typedef {object} Reading
 * @property {number} ts logger timestamp, Unix seconds
 * @property {boolean} grid grid present
 * @property {number} volt grid voltage, V
 * @property {number} hz grid frequency, Hz
 * @property {number} soc battery state of charge, %
 * @property {number} batt battery power, W (negative = charging)
 * @property {number} load house consumption, W
 */

/** Cached access token; `force` obtains a new one. @param {DeyeConn} c */
export async function deyeToken(c, force = false) {
  const { env } = c;
  if (!force) {
    const cached = await kvGet(env, c.cacheKey);
    if (cached) {
      const { token, exp } = JSON.parse(cached);
      if (exp > now()) return token;
    }
  }
  const res = await fetch(`${baseUrl(c)}/account/token?appId=${encodeURIComponent(c.appId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appSecret: c.appSecret,
      email: c.email,
      password: (await hash('SHA-256', c.password)).toLowerCase(),
    }),
  });
  const j = await res.json();
  if (!j.accessToken) throw new Error(`Deye auth: ${j.code} ${j.msg || ''}`);
  const token = j.accessToken.split(' ').pop();
  const ttl = Number(j.expiresIn) || 86400 * 30;
  await kvSet(env, c.cacheKey, JSON.stringify({ token, exp: now() + ttl - TOKEN_MARGIN_SEC }));
  return token;
}

/**
 * Latest reading of an inverter. Retries once with a fresh token.
 * @param {DeyeConn} c
 * @param {string} sn inverter serial number
 * @returns {Promise<Reading>}
 */
export async function deyeLatest(c, sn) {
  if (!sn) throw new Error('Не вказано серійний номер інвертора Deye');
  const fetchLatest = async (token) => {
    const res = await fetch(`${baseUrl(c)}/device/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceList: [sn] }),
    });
    return { status: res.status, j: await res.json().catch(() => ({})) };
  };

  let r = await fetchLatest(await deyeToken(c));
  if (r.status === 401 || !OK_CODES.includes(r.j.code)) r = await fetchLatest(await deyeToken(c, true));
  if (!OK_CODES.includes(r.j.code)) throw new Error(`Deye latest: ${r.status} ${r.j.code} ${r.j.msg || ''}`);

  const dev = (r.j.deviceDataList || [])[0];
  if (!dev) throw new Error('Deye: інвертор не знайдено');
  const v = Object.fromEntries((dev.dataList || []).map((it) => [it.key, it.value]));
  const volt = Number(v.GridVoltageL1L2) || 0;
  const hz = Number(v.GridFrequency) || 0;
  return {
    ts: Number(dev.collectionTime) || 0,
    grid: volt > GRID_V_MIN && hz > GRID_HZ_MIN,
    volt,
    hz,
    soc: Number(v.SOC),
    batt: Number(v.BatteryPower),
    load: Number(v.TotalConsumptionPower),
  };
}

/** Stations with their devices (for discovery). @param {DeyeConn} c */
export async function deyeStations(c) {
  const res = await fetch(`${baseUrl(c)}/station/listWithDevice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await deyeToken(c)}` },
    body: '{}',
  });
  const j = await res.json();
  return { stations: j.data?.stationList || j.stationList || [], code: j.code, msg: j.msg };
}

/* ---------- grid-charge current ---------- */

/**
 * The battery parameter this client writes. The OpenAPI has others (MAX_CHARGE_CURRENT,
 * MAX_DISCHARGE_CURRENT, BATT_LOW); the bot leaves them alone.
 */
const GRID_CHARGE = 'GRID_CHARGE_AMPERE';

/** "The read order is still on its way to the inverter": ask for the result again. */
const READ_PENDING = ['2104013', 2104013];

/**
 * Order states of GET /order/{orderId}: 0 to be sent, 100 sending, 300 during upgrade,
 * 400 terminated, 500 failed, 666 succeeded.
 */
const ORDER_DONE = 666;
const ORDER_FAILED = [400, 500];

/**
 * One authorised call. A rejected token is replaced once; nothing else is repeated here,
 * so this function never sends a command twice.
 */
async function deyeCall(c, method, path, body) {
  const call = async (token) => {
    const res = await fetch(`${baseUrl(c)}${path}`, {
      method,
      signal: AbortSignal.timeout(CHARGE_HTTP_TIMEOUT_MS), // a hanging cloud must not hang the check
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text().catch(() => '');
    let j = {};
    try {
      j = JSON.parse(text) || {};
    } catch {
      /* not JSON: the status tells the rest */
    }
    return { status: res.status, j, text };
  };
  let r = await call(await deyeToken(c));
  if (r.status === 401) r = await call(await deyeToken(c, true));
  return r;
}

const fail = (what, r) => new Error(`Deye ${what}: ${r.status} ${r.j.code ?? ''} ${r.j.msg || ''}`.trim());

/** Order ids are 64-bit: taken from the text, so a long one is not rounded by JSON.parse. */
const orderId = (r) => r.text.match(/"orderId"\s*:\s*"?(\d+)/)?.[1] || null;

/**
 * The request that sets the grid-charge current, exactly as it is sent: the bot shows it
 * to the admin before a manual write.
 * @param {DeyeConn} c
 * @param {string} sn
 * @param {number} amps
 */
export function deyeGridChargeRequest(c, sn, amps) {
  return {
    method: 'POST',
    path: '/order/battery/parameter/update',
    url: `${baseUrl(c)}/order/battery/parameter/update`,
    // "paramterType" is the spelling of the OpenAPI itself.
    body: { deviceSn: sn, paramterType: GRID_CHARGE, value: amps },
  };
}

/**
 * Sets the grid-charge current. The cloud answers with an order; whether the inverter
 * carried it out is asked with deyeOrder.
 * @param {DeyeConn} c
 * @param {string} sn
 * @param {number} amps whole amperes, at least 1
 * @returns {Promise<{order: string, online: boolean | null}>}
 */
export async function deyeSetGridCharge(c, sn, amps) {
  if (!sn) throw new Error('Не вказано серійний номер інвертора Deye');
  if (!Number.isInteger(amps) || amps < 1) throw new Error(`Deye: недопустимий струм заряду «${amps}»`);
  const req = deyeGridChargeRequest(c, sn, amps);
  const r = await deyeCall(c, req.method, req.path, req.body);
  const order = orderId(r);
  if (!OK_CODES.includes(r.j.code) || !order) throw fail('order', r);
  const st = r.j.connectionStatus;
  return { order, online: st === undefined || st === null ? null : Number(st) === 1 };
}

/**
 * Result of an order.
 * @param {DeyeConn} c
 * @param {string} order
 * @returns {Promise<{state: 'done' | 'failed' | 'pending', detail: string}>}
 */
export async function deyeOrder(c, order) {
  const r = await deyeCall(c, 'GET', `/order/${encodeURIComponent(order)}`);
  if (!OK_CODES.includes(r.j.code)) throw fail('order result', r);
  const status = Number(r.j.status);
  const detail = `стан ${r.j.status}${r.j.error ? `, помилка ${r.j.error}` : ''}`;
  if (status === ORDER_DONE) return { state: 'done', detail };
  return { state: ORDER_FAILED.includes(status) ? 'failed' : 'pending', detail };
}

/**
 * The grid-charge current the inverter holds now, A. The cloud asks the inverter, so this
 * takes a few seconds and works only while the inverter is online.
 * @param {DeyeConn} c
 * @param {string} sn
 * @returns {Promise<number>}
 */
export async function deyeGridCharge(c, sn) {
  if (!sn) throw new Error('Не вказано серійний номер інвертора Deye');
  const asked = await deyeCall(c, 'POST', '/strategy/dynamicControl/read', { deviceSn: sn });
  const order = orderId(asked);
  if (!OK_CODES.includes(asked.j.code) || !order) throw fail('read', asked);
  let r;
  for (let i = 0; i < CHARGE_READ_TRIES; i++) {
    await sleep(CHARGE_READ_WAIT_MS);
    // The id goes back digit for digit (a JSON number, as the API expects), never through Number().
    r = await deyeCall(c, 'POST', '/strategy/dynamicControl/readResult', `{"orderId":${order}}`);
    if (!READ_PENDING.includes(r.j.code)) break;
  }
  const amps = Number(r.j.gridChargeAmpere);
  if (!OK_CODES.includes(r.j.code) || r.j.gridChargeAmpere === undefined || !Number.isFinite(amps)) {
    throw fail('read result', r);
  }
  return amps;
}
