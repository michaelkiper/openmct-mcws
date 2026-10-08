import types from '../../types/types.js';
import { groupBy, keyBy } from '../../utils/utils.js';
import {
  buildChannelQueryBody,
  requestChannelValues,
  usesChillaxSbe
} from 'services/chillax/chillaxSbe.js';

/**
 * Historical channel queries against chillax-server, decoded from SBE `PartialData` messages.
 * Used in place of ChannelHistoricalProvider for datasets with `useChillaxSbe` enabled.
 */
class ChillaxChannelHistoricalProvider {
  supportsRequest(domainObject, request) {
    return (
      domainObject.type === types.Channel.key &&
      Boolean(domainObject.telemetry?.channelHistoricalUrl) &&
      usesChillaxSbe(domainObject, request) &&
      (request.strategy === 'minmax' ? !domainObject.telemetry.channelMinMaxUrl : true) &&
      request.size !== 1
    );
  }

  get batchId() {
    if (window.openmctMCWSConfig?.batchHistoricalChannelQueries === true) {
      return (domainObject, options) => {
        return [domainObject.telemetry.channelHistoricalUrl, options.domain, options.filters];
      };
    }
    return undefined;
  }

  querySettings(options) {
    const settings = {
      sort: window.openmctMCWSConfig?.disableSortParam !== true
    };

    if (
      options.strategy !== 'comprehensive' &&
      window.openmctMCWSConfig?.maxResults !== undefined
    ) {
      settings.limit = window.openmctMCWSConfig.maxResults;
    }

    return settings;
  }

  batchRequest(batch) {
    const requests = Object.values(batch.requestsById);
    const { domainObject, options, params } = requests[0];
    const channelIds = requests.map((req) => req.domainObject.telemetry.channel_id);

    // A shared limit would starve some channels of data, so batched queries are not limited.
    const settings = { sort: this.querySettings(options).sort };

    Promise.resolve()
      .then(() => {
        const body = buildChannelQueryBody(options, params, channelIds, settings);

        return requestChannelValues(
          domainObject.telemetry.channelHistoricalUrl,
          body,
          options.signal
        );
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

  async request(domainObject, options, params) {
    const body = buildChannelQueryBody(
      options,
      params,
      [domainObject.telemetry.channel_id],
      this.querySettings(options)
    );

    return requestChannelValues(domainObject.telemetry.channelHistoricalUrl, body, options.signal);
  }
}

export default new ChillaxChannelHistoricalProvider();
