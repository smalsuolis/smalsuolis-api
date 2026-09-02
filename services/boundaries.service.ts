'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { AddressSuggestion, searchAddressSuggestions } from '../utils/addressSuggest';
import { EndpointType } from '../types';

// Public proxy over the LT address registry (boundaries.biip.lt). Powers the
// homepage/map address autocomplete: the browser can't reach boundaries directly,
// so we expose a thin, cached suggestion endpoint. Registry data is effectively
// static, so results are cached in-memory per normalized query.

export { AddressSuggestion };

@Service({
  name: 'boundaries',
})
export default class BoundariesService extends moleculer.Service {
  private suggestCache = new Map<string, { data: AddressSuggestion[]; expiry: number }>();
  private readonly SUGGEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // registry is static
  private readonly SUGGEST_CACHE_MAX_ENTRIES = 2000;

  @Action({
    rest: {
      method: 'GET',
      path: '/suggest',
      basePath: '/addresses',
    },
    auth: EndpointType.PUBLIC,
    params: {
      search: 'string|min:3|trim',
    },
    timeout: 30 * 1000,
  })
  async suggest(ctx: Context<{ search: string }>): Promise<AddressSuggestion[]> {
    const search = ctx.params.search.trim();
    const cacheKey = search.toLowerCase();

    const cached = this.suggestCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    let suggestions: AddressSuggestion[];
    try {
      suggestions = await searchAddressSuggestions(search);
    } catch (err) {
      // Don't cache a transient registry failure — a single blip would otherwise
      // answer this query with an empty list for the next 24 hours.
      this.logger.warn('Address suggest failed', err);
      return [];
    }

    if (this.suggestCache.size >= this.SUGGEST_CACHE_MAX_ENTRIES) {
      this.suggestCache.delete(this.suggestCache.keys().next().value);
    }
    this.suggestCache.set(cacheKey, {
      data: suggestions,
      expiry: Date.now() + this.SUGGEST_CACHE_TTL_MS,
    });

    return suggestions;
  }
}
