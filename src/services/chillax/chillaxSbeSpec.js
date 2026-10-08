import { buildChannelQueryBody, CHANNEL_COLUMNS, requestChannelValues } from './chillaxSbe.js';
import chillaxChannelHistoricalProvider from '../../historical/providers/ChillaxChannelHistoricalProvider.js';
import chillaxChannelLadProvider from '../../historical/providers/ChillaxChannelLadProvider.js';

const URL = 'http://chillax.example/channels';
const encoder = new TextEncoder();

function text(value) {
  return encoder.encode(value);
}

function fixed(size, write) {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

const float64 = (value) => fixed(8, (view) => view.setFloat64(0, value, true));
const int64 = (value) => fixed(8, (view) => view.setBigInt64(0, value, true));
const uint64 = (value) => fixed(8, (view) => view.setBigUint64(0, value, true));
const uint32 = (value) => fixed(4, (view) => view.setUint32(0, value, true));
const bool = (value) => fixed(1, (view) => view.setUint8(0, value ? 1 : 0));

/**
 * Encodes one `PartialData` message (templateId 900) carrying `CHANNEL_COLUMNS`, in order.
 * A column missing from `columns` is sent empty.
 */
function partialData(columns) {
  const values = CHANNEL_COLUMNS.map((column) => columns[column] ?? new Uint8Array(0));
  const dataStart = 10 + 2 * values.length + 2;
  const length = values.reduce((total, value) => total + value.length, dataStart);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);

  view.setUint16(2, 900, true);
  view.setUint16(8, length, true);

  let offset = dataStart;
  values.forEach((value, i) => {
    view.setUint16(10 + 2 * i, offset, true);
    bytes.set(value, offset);
    offset += value.length;
  });
  view.setUint16(10 + 2 * values.length, offset, true);

  return bytes;
}

/** Encodes an `Error` message (templateId 899). */
function sbeError(code, message) {
  const encoded = text(message);
  const bytes = new Uint8Array(14 + encoded.length);
  const view = new DataView(bytes.buffer);

  view.setUint16(2, 899, true);
  view.setUint16(8, 0xffff, true);
  view.setUint16(10, code, true);
  view.setInt16(12, encoded.length, true);
  bytes.set(encoded, 14);

  return bytes;
}

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  parts.forEach((part) => {
    bytes.set(part, offset);
    offset += part.length;
  });
  return bytes;
}

// 2024-10-05T00:00:00.123456789Z
const SCET_NS = 1728086400123456789n;
const ERT_NS = 1728086401000000000n;

describe('chillax SBE channel queries', () => {
  let fetchSpy;

  function respondWith(bytes, status = 200) {
    fetchSpy.and.callFake(() => Promise.resolve(new Response(bytes, { status })));
  }

  beforeEach(() => {
    fetchSpy = spyOn(window, 'fetch');
  });

  describe('requestChannelValues', () => {
    it('requests the partial data columns as SBE', async () => {
      respondWith(new Uint8Array(0));

      await requestChannelValues(URL, { channel_id: 'A-0001' });

      const [url, options] = fetchSpy.calls.mostRecent().args;
      expect(url).toBe(URL);
      expect(options.method).toBe('POST');
      expect(options.headers.Accept).toBe('application/octet-stream');
      expect(JSON.parse(options.body)).toEqual({
        channel_id: 'A-0001',
        columns: CHANNEL_COLUMNS
      });
    });

    it('decodes PartialData messages into MCWS shaped channel values', async () => {
      respondWith(
        concat(
          partialData({
            channelId: text('A-0001'),
            type: text('FLOAT'),
            dn: float64(1.5),
            eu: float64(3),
            ert: uint64(ERT_NS),
            scet: uint64(SCET_NS),
            sclk: text('0781234567.12345'),
            lst: text('SOL-0001M12:00:00.000'),
            dnAlarmState: text('NONE'),
            euAlarmState: text('RED'),
            module: text('ACS'),
            realtime: bool(true),
            dssId: uint32(14)
          }),
          partialData({
            channelId: text('A-0002'),
            type: text('SIGNED_INT'),
            dn: int64(-42n),
            scet: uint64(SCET_NS),
            realtime: bool(false),
            status: text('ON')
          })
        )
      );

      const values = await requestChannelValues(URL, {});

      expect(values).toEqual([
        {
          channel_id: 'A-0001',
          dn: 1.5,
          eu: 3,
          ert: '2024-279T00:00:01.000',
          scet: '2024-279T00:00:00.123',
          sclk: '0781234567.12345',
          lst: 'SOL-0001M12:00:00.000',
          dn_alarm_state: 'NONE',
          eu_alarm_state: 'RED',
          module: 'ACS',
          realtime: true,
          dss_id: 14,
          status: undefined
        },
        {
          channel_id: 'A-0002',
          dn: -42,
          eu: undefined,
          ert: undefined,
          scet: '2024-279T00:00:00.123',
          sclk: undefined,
          lst: undefined,
          dn_alarm_state: undefined,
          eu_alarm_state: undefined,
          module: undefined,
          realtime: false,
          dss_id: undefined,
          status: 'ON'
        }
      ]);
    });

    it('rejects when the stream ends with an SBE error', async () => {
      respondWith(
        concat(
          partialData({ channelId: text('A-0001'), realtime: bool(true) }),
          sbeError(403, 'user attempting to retrieve forbidden data')
        )
      );

      await expectAsync(requestChannelValues(URL, {})).toBeRejectedWithError(
        /after 1 records: user attempting to retrieve forbidden data \(code 403\)/
      );
    });

    it('rejects with the SBE error sent in place of data', async () => {
      respondWith(sbeError(500, 'database unavailable'), 500);

      await expectAsync(requestChannelValues(URL, {})).toBeRejectedWithError(
        'Chillax server responded with 500: database unavailable (code 500)'
      );
    });

    it('rejects with the reason a request was refused', async () => {
      respondWith(text("field 'foo' is not supported"), 400);

      await expectAsync(requestChannelValues(URL, {})).toBeRejectedWithError(
        "Chillax server responded with 400: field 'foo' is not supported"
      );
    });
  });

  describe('buildChannelQueryBody', () => {
    const options = {
      domain: 'scet',
      start: Date.UTC(2024, 9, 5),
      end: Date.UTC(2024, 9, 5, 1, 2, 3, 456)
    };

    it('translates MCWS style params', () => {
      const params = {
        filter: {
          scet__gte: '2024-279T00:00:00.000',
          scet__lte: '2024-279T01:02:03.456',
          session_id: '(1,2)',
          session_host: 'host',
          realtime: 'true',
          channel_id: 'ignored'
        }
      };

      expect(
        buildChannelQueryBody(options, params, ['A-0001'], { sort: true, limit: 100 })
      ).toEqual({
        time_type: 'scet',
        gte: '2024-10-05T00:00:00.000',
        lte: '2024-10-05T01:02:03.456',
        session_id: ['1', '2'],
        session_host: 'host',
        realtime: 'true',
        channel_id: 'A-0001',
        sort_asc: 'scet',
        limit: 100
      });
    });

    it('queries several channels at once', () => {
      const body = buildChannelQueryBody(options, { filter: {} }, ['A-0001', 'A-0002']);

      expect(body.channel_id).toEqual(['A-0001', 'A-0002']);
      expect(body.sort_asc).toBeUndefined();
      expect(body.limit).toBeUndefined();
    });

    it('rejects filters chillax-server cannot express', () => {
      expect(() =>
        buildChannelQueryBody(options, { filter: { dss_id__gt: 3 } }, ['A-0001'])
      ).toThrowError(/dss_id__gt/);
    });
  });

  describe('providers', () => {
    function channel(telemetry) {
      return {
        type: 'vista.channel',
        telemetry: {
          channel_id: 'A-0001',
          channelHistoricalUrl: URL,
          channelLADUrl: 'http://chillax.example/channel_lad',
          ...telemetry
        }
      };
    }

    it('are used only for datasets that opt in', () => {
      const request = { domain: 'scet' };

      expect(chillaxChannelHistoricalProvider.supportsRequest(channel({}), request)).toBeFalse();
      expect(
        chillaxChannelHistoricalProvider.supportsRequest(channel({ useChillaxSbe: true }), request)
      ).toBeTrue();
    });

    it('are used only in time systems chillax-server supports', () => {
      const domainObject = channel({ useChillaxSbe: true });

      expect(
        chillaxChannelHistoricalProvider.supportsRequest(domainObject, { domain: 'ert' })
      ).toBeTrue();
      expect(
        chillaxChannelHistoricalProvider.supportsRequest(domainObject, { domain: 'sclk' })
      ).toBeFalse();
      expect(
        chillaxChannelLadProvider.supportsRequest(domainObject, { domain: 'lmst', size: 1 })
      ).toBeFalse();
    });

    it('split historical and latest requests', () => {
      const domainObject = channel({ useChillaxSbe: true });
      const latest = { domain: 'scet', strategy: 'latest', size: 1 };

      expect(chillaxChannelLadProvider.supportsRequest(domainObject, latest)).toBeTrue();
      expect(chillaxChannelHistoricalProvider.supportsRequest(domainObject, latest)).toBeFalse();
    });

    it('leave min-max requests to the min-max endpoint', () => {
      const request = { domain: 'scet', strategy: 'minmax', size: 800 };

      expect(
        chillaxChannelHistoricalProvider.supportsRequest(
          channel({ useChillaxSbe: true, channelMinMaxUrl: 'http://mcws/minmax' }),
          request
        )
      ).toBeFalse();
    });

    it('resolve each request in a batch with its own channel values', async () => {
      respondWith(
        concat(
          partialData({ channelId: text('A-0002'), realtime: bool(true) }),
          partialData({ channelId: text('A-0001'), realtime: bool(false) })
        )
      );

      const requests = ['A-0001', 'A-0002', 'A-0003'].map((id) => {
        const entry = {
          domainObject: channel({ useChillaxSbe: true, channel_id: id }),
          options: { domain: 'scet', strategy: 'latest', size: 1 },
          params: { filter: {} }
        };
        entry.promise = new Promise((resolve, reject) => {
          entry.resolve = resolve;
          entry.reject = reject;
        });
        return entry;
      });

      chillaxChannelLadProvider.batchRequest({ requestsById: { ...requests } });
      const [first, second, third] = await Promise.all(requests.map((req) => req.promise));

      const [url, fetchOptions] = fetchSpy.calls.mostRecent().args;
      expect(url).toBe('http://chillax.example/channel_lad');
      expect(JSON.parse(fetchOptions.body).channel_id).toEqual(['A-0001', 'A-0002', 'A-0003']);
      expect(first.map((value) => value.realtime)).toEqual([false]);
      expect(second.map((value) => value.realtime)).toEqual([true]);
      expect(third).toEqual([]);
    });
  });
});
