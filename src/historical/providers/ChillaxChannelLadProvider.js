import types from '../../types/types.js';
import { groupBy, keyBy } from '../../utils/utils.js';
import {
  buildChannelQueryBody,
  requestChannelValues,
  usesChillaxSbe
} from 'services/chillax/chillaxSbe.js';

/**
 * Latest value queries against chillax-server, decoded from SBE `PartialData` messages.
 * Used in place of ChannelLadProvider for datasets with `useChillaxSbe` enabled.
 */
class ChillaxChannelLadProvider {
  supportsRequest(domainObject, request) {
    return (
      domainObject.type === types.Channel.key &&
      Boolean(
        domainObject.telemetry?.channelLADUrl || domainObject.telemetry?.channelHistoricalUrl
      ) &&
      usesChillaxSbe(domainObject, request) &&
      (request.strategy === 'latest' || request.size === 1)
    );
  }

  batchId(domainObject, options) {
    return [domainObject.telemetry.channelLADUrl, options.domain, options.filters];
  }

  batchRequest(batch) {
    const requests = Object.values(batch.requestsById);
    const { domainObject, options, params } = requests[0];
    const channelIds = requests.map((req) => req.domainObject.telemetry.channel_id);
    const ladURL = domainObject.telemetry.channelLADUrl;

    Promise.resolve()
      .then(() => {
        // Without a LAD endpoint, fall back to the historical endpoint, as ChannelLadProvider does.
        const url = ladURL || domainObject.telemetry.channelHistoricalUrl;
        const body = buildChannelQueryBody(options, params, channelIds, {
          sort: !ladURL && window.openmctMCWSConfig?.disableSortParam !== true
        });

        return requestChannelValues(url, body, options.signal);
      })
      .then((res) => {
        const valuesByChannelId = groupBy(res, 'channel_id');
        const toFulfill = keyBy(requests, (req) => req.domainObject.telemetry.channel_id);

        Object.entries(valuesByChannelId).forEach(([id, values]) => {
          toFulfill[id]?.resolve(values);
          delete toFulfill[id];
        });
        Object.values(toFulfill).forEach((request) => {
          request.resolve([]);
        });
      })
      .catch((reason) => {
        requests.forEach((request) => request.reject(reason));
      });
  }
}

export default new ChillaxChannelLadProvider();
