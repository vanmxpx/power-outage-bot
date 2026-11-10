/**
 * Inverter clouds. The rest of the bot reads a site's grid through here and does not care
 * which cloud the inverter reports to.
 *
 *   deye        — DeyeCloud (Deye OpenAPI)
 *   dess        — DESS Monitor / ShineMonitor: SmartESS, WatchPower, SmartClient …
 *   valueclouds — ValueClouds: the SmartValue app
 *
 * Credentials are Worker secrets. Account 1 uses the plain names (DESS_USER), account 2 adds
 * a suffix (DESS_USER_2), so one deployment can read inverters from several accounts.
 */

import { dessDevices, dessLatest } from './dess.js';
import {
  deyeGridCharge,
  deyeGridChargeRequest,
  deyeLatest,
  deyeOrder,
  deyeSetGridCharge,
  deyeStations,
} from './deye.js';
import { valueCloudsLatest, valueCloudsLogin, valueCloudsProbe } from './valueclouds.js';

const suffix = (account) => (Number(account) > 1 ? `_${account}` : '');

/**
 * @typedef {object} Cloud
 * @property {string} name shown to people
 * @property {string} app the phone app people know it by
 * @property {string[]} secrets secret names for account 1
 * @property {(env: any, account: number, params?: Record<string, string>) => any} connect
 * @property {(conn: any, params: Record<string, string>) => Promise<import('./deye.js').Reading>} latest
 * @property {((conn: any) => Promise<Array<{label: string, params: Record<string, string>}>>) | null} list
 *   inverters visible to the account; null when the cloud cannot list them
 * @property {string[]} [manual] identifiers to ask for when there is no list
 * @property {ChargeDriver} [charge] setting the grid-charge current, for clouds that can (charge.js)
 */

/**
 * @typedef {object} ChargeDriver
 * @property {(conn: any, params: Record<string, string>) => Promise<number>} read A the inverter holds now
 * @property {(conn: any, params: Record<string, string>, amps: number) => Promise<{order: string, online: boolean | null}>} write
 * @property {(conn: any, order: string) => Promise<{state: 'done' | 'failed' | 'pending', detail: string}>} result
 * @property {(conn: any, params: Record<string, string>, amps: number) => string} preview the request, shown to the admin
 */

/** @type {Record<string, Cloud>} */
export const CLOUDS = {
  deye: {
    name: 'Deye',
    app: 'DeyeCloud',
    secrets: ['DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_EMAIL', 'DEYE_PASSWORD'],
    connect: (env, account) => {
      const s = suffix(account);
      return {
        env,
        appId: env[`DEYE_APP_ID${s}`],
        appSecret: env[`DEYE_APP_SECRET${s}`],
        email: env[`DEYE_EMAIL${s}`],
        password: env[`DEYE_PASSWORD${s}`],
        api: env[`DEYE_API${s}`],
        cacheKey: `deye_token${s}`,
      };
    },
    latest: (c, p) => deyeLatest(c, p.sn),
    async list(c) {
      const { stations, code, msg } = await deyeStations(c);
      if (!stations.length && code && !['0', '1000000', 0, 1000000].includes(code))
        throw new Error(`Deye: ${code} ${msg || ''}`);
      return stations.flatMap((st) =>
        (st.deviceListItems || st.deviceList || [])
          .filter((d) => d.deviceType === 'INVERTER')
          .map((d) => ({ label: `${st.name} · ${d.deviceSn}`, params: { sn: d.deviceSn } }))
      );
    },
    charge: {
      read: (c, p) => deyeGridCharge(c, p.sn),
      write: (c, p, amps) => deyeSetGridCharge(c, p.sn, amps),
      result: (c, order) => deyeOrder(c, order),
      preview(c, p, amps) {
        const req = deyeGridChargeRequest(c, p.sn, amps);
        return `${req.method} ${req.url}\n${JSON.stringify(req.body)}`;
      },
    },
  },
  dess: {
    name: 'SmartESS',
    app: 'SmartESS / WatchPower / SmartClient',
    secrets: ['DESS_USER', 'DESS_PASSWORD'],
    connect: (env, account, params = {}) => {
      const s = suffix(account);
      return {
        env,
        user: env[`DESS_USER${s}`],
        password: env[`DESS_PASSWORD${s}`],
        companyKey: env[`DESS_COMPANY_KEY${s}`],
        platform: params.platform,
        cacheKey: `dess_token${s}${params.platform === 'shinemonitor' ? '_shine' : ''}`,
      };
    },
    latest: (c, p) => dessLatest(c, p),
    list: (c) => dessDevices(c),
  },
  valueclouds: {
    name: 'SmartValue',
    app: 'SmartValue',
    secrets: ['VC_USER', 'VC_PASSWORD'],
    connect: (env, account) => {
      const s = suffix(account);
      return { env, user: env[`VC_USER${s}`], password: env[`VC_PASSWORD${s}`], cacheKey: `vc_token${s}` };
    },
    latest: (c, p) => valueCloudsLatest(c, p),
    list: null,
    manual: ['pn', 'sn', 'devcode', 'devaddr'],
  },
};

/** @param {string} cloud */
function cloudOf(cloud) {
  const c = CLOUDS[cloud];
  if (!c) throw new Error(`Невідома хмара інвертора «${cloud}»`);
  return c;
}

/** Secret names for this cloud and account, e.g. ["DESS_USER_2", "DESS_PASSWORD_2"]. */
export const secretNames = (cloud, account = 1) => cloudOf(cloud).secrets.map((n) => n + suffix(account));

/** Secrets that are not set yet; empty when the bot can log in. */
export const missingSecrets = (env, cloud, account = 1) => secretNames(cloud, account).filter((n) => !env[n]);

/** Name used in messages, e.g. "Deye не відповідає". @param {import('./config.js').Site} site */
export const inverterName = (site) => cloudOf(site.inverter).name;

/** True when the site knows which inverter to read. */
export const inverterConfigured = (env, site) => Boolean(site.params?.sn);

/** @returns {Promise<import('./deye.js').Reading>} */
export function inverterLatest(env, site) {
  const cloud = cloudOf(site.inverter);
  return cloud.latest(cloud.connect(env, site.account, site.params), site.params);
}

/**
 * Control of the grid-charge current of a site's inverter; null when its cloud cannot do
 * it or the inverter is not chosen yet.
 * @param {import('./config.js').Site} site
 */
export function chargeControl(env, site) {
  const cloud = CLOUDS[site?.inverter];
  if (!cloud?.charge || !site.params?.sn) return null;
  const conn = cloud.connect(env, site.account, site.params);
  return {
    read: () => cloud.charge.read(conn, site.params),
    /** @param {number} amps */
    write: (amps) => cloud.charge.write(conn, site.params, amps),
    /** @param {string} order */
    result: (order) => cloud.charge.result(conn, order),
    /** @param {number} amps */
    preview: (amps) => cloud.charge.preview(conn, site.params, amps),
  };
}

/**
 * Inverters the account can see, for picking one in the bot.
 * @returns {Promise<Array<{label: string, params: Record<string, string>}> | null>} null: enter by hand
 */
export async function listInverters(env, cloud, account = 1, extra = {}) {
  const c = cloudOf(cloud);
  if (!c.list) {
    if (cloud === 'valueclouds') await valueCloudsLogin(c.connect(env, account));
    return null;
  }
  const found = await c.list(c.connect(env, account, extra));
  return found.map((f) => ({ ...f, params: { ...f.params, ...extra } }));
}

/** For clouds without a list: checks identifiers typed by hand and fills in what can be found. */
export async function probeInverter(env, cloud, account, params) {
  if (cloud !== 'valueclouds') throw new Error('Перевірка вручну потрібна лише для SmartValue');
  return valueCloudsProbe(CLOUDS.valueclouds.connect(env, account), params);
}
