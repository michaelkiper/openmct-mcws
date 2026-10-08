import {
  createPartialDataDecoder,
  decodeSbeError,
  ERROR_SENTINEL,
  formatTimestampNsDoy
} from '@gov.nasa.jpl.gds.mcs/chillax-sbe';
import mcwsClient from 'services/mcws/MCWSClient.js';

/**
 * Time systems chillax-server can filter and sort on. Requests in any other domain
 * (sclk, lmst, msl.sol) are left to the MCWS JSON providers.
 */
export const CHILLAX_SBE_DOMAINS = ['scet', 'ert'];

/**
 * The columns requested from chillax-server. Only `PartialData` messages are used: a request
 * that carries `columns` is answered with `PartialData` instead of full `channel` messages.
 * Together these cover the fields the MCWS JSON channel query selects.
 */
export const CHANNEL_COLUMNS = [
  'channelId',
  'type',
  'dn',
  'eu',
  'ert',
  'scet',
  'sclk',
  'lst',
  'dnAlarmState',
  'euAlarmState',
  'module',
  'realtime',
  'dssId',
  'status'
];

const SBE_HEADERS = {
  Accept: 'application/octet-stream',
  'Content-Type': 'application/json'
};

// Message length is the uint16 following the 8 byte SBE header.
const MESSAGE_LENGTH_OFFSET = 8;

let decoder;

function getDecoder() {
  // Built on first use, so nothing is compiled unless a dataset opts in to chillax.
  if (!decoder) {
    decoder = createPartialDataDecoder(CHANNEL_COLUMNS);
  }

  return decoder;
}

export function usesChillaxSbe(domainObject, options) {
  return (
    domainObject.telemetry?.useChillaxSbe === true && CHILLAX_SBE_DOMAINS.includes(options.domain)
  );
}

/**
 * chillax-server parses times without a zone designator as UTC.
 */
function formatTime(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, -1);
}

/**
 * Converts an MCWS style filter value, e.g. `(1,2)` or `a,b`, to the JSON body form, where a
 * list is a set of alternatives and anything else must match exactly.
 */
function toBodyValue(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value !== 'string') {
    return value;
  }

  const values = value.replace(/^\((.*)\)$/, '$1').split(',');

  return values.length > 1 ? values : values[0];
}

/**
 * Builds a chillax-server POST body from the MCWS style params assembled by the
 * HistoricalProvider.
 *
 * @param {object} options the telemetry request options
 * @param {object} params MCWS style params; time filters on the request domain are replaced
 *        by the request bounds
 * @param {string[]} channelIds channels to query
 * @param {object} [settings]
 * @param {boolean} [settings.sort] sort ascending on the request domain
 * @param {number} [settings.limit] maximum number of records to return
 */
export function buildChannelQueryBody(options, params, channelIds, { sort, limit } = {}) {
  const domain = options.domain;
  const body = {
    time_type: domain
  };

  if (Number.isFinite(options.start)) {
    body.gte = formatTime(options.start);
  }

  if (Number.isFinite(options.end)) {
    body.lte = formatTime(options.end);
  }

  Object.entries(params.filter ?? {}).forEach(([filterKey, value]) => {
    const [key, operator] = filterKey.split('__');

    if (key === domain || key === 'channel_id') {
      return;
    }

    if (operator !== undefined && operator !== 'in' && operator !== 'eq') {
      throw new Error(`Filter '${filterKey}' is not supported by chillax-server.`);
    }

    body[key] = toBodyValue(value);
  });

  body.channel_id = channelIds.length === 1 ? channelIds[0] : channelIds;

  if (sort) {
    body.sort_asc = domain;
  }

  if (limit !== undefined) {
    body.limit = limit;
  }

  return body;
}

function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function toTimestamp(nanoseconds) {
  return nanoseconds === undefined ? undefined : formatTimestampNsDoy(nanoseconds);
}

/**
 * Shapes a decoded `PartialData` record like an MCWS JSON channel value, so views and formats
 * treat both sources alike.
 */
function toChannelValue(record) {
  return {
    channel_id: record.channelId,
    dn: toNumber(record.dn),
    eu: record.eu ?? undefined,
    ert: toTimestamp(record.ert),
    scet: toTimestamp(record.scet),
    sclk: record.sclk,
    lst: record.lst,
    dn_alarm_state: record.dnAlarmState,
    eu_alarm_state: record.euAlarmState,
    module: record.module,
    realtime: record.realtime,
    dss_id: record.dssId ?? undefined,
    status: record.status
  };
}

async function errorFromResponse(response) {
  const prefix = `Chillax server responded with ${response.status}`;
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);

  // A failure before any data was sent arrives as an SBE Error message; a rejected request as text.
  if (
    buffer.byteLength > MESSAGE_LENGTH_OFFSET + 2 &&
    view.getUint16(MESSAGE_LENGTH_OFFSET, true) === ERROR_SENTINEL
  ) {
    const error = decodeSbeError(buffer, view);

    return new Error(`${prefix}: ${error.error_message} (code ${error.error_code})`);
  }

  const message = new TextDecoder().decode(buffer).trim();

  return new Error(message ? `${prefix}: ${message}` : prefix);
}

/**
 * Queries chillax-server for channel values as SBE `PartialData` messages.
 *
 * @param {string} url the chillax-server endpoint, e.g. `/channels` or `/channel_lad`
 * @param {object} body the JSON request body, see `buildChannelQueryBody`
 * @param {AbortSignal} [signal]
 * @returns {Promise<object[]>} channel values in MCWS JSON form
 */
export async function requestChannelValues(url, body, signal) {
  let response;

  try {
    response = await mcwsClient.request({
      url,
      method: 'POST',
      headers: SBE_HEADERS,
      body: JSON.stringify({ ...body, columns: CHANNEL_COLUMNS }),
      signal
    });
  } catch (error) {
    throw error?.response ? await errorFromResponse(error.response) : error;
  }

  // The request was aborted.
  if (!response) {
    return [];
  }

  const { records, error } = getDecoder().decode(await response.arrayBuffer());

  // The server ends a stream with an Error message when it fails partway, so the data is incomplete.
  if (error !== null) {
    throw new Error(
      `Chillax server error after ${records.length} records: ${error.error_message} (code ${error.error_code})`
    );
  }

  return records.map(toChannelValue);
}
