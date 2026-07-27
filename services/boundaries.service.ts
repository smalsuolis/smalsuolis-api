'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { wktToGeoJSON } from 'betterknown';
import { addressesSearch, Address } from '../utils/boundaries';
import { EndpointType } from '../types';

// Public proxy over the LT address registry (boundaries.biip.lt). Powers the
// homepage/map address autocomplete: the browser can't reach boundaries directly,
// so we expose a thin, cached suggestion endpoint. Registry data is effectively
// static, so results are cached in-memory per normalized query.

export interface AddressSuggestion {
  code: number;
  label: string;
  // GeoJSON Point (EPSG:4326), ready to drop into a FeatureCollection for the map.
  geometry: any;
}

// Split free-text input into the parts the registry can filter on.
// "Vilniaus g. 2, Vilnius" → { street: 'Vilniaus g.', houseNumber: '2' }
// "Gedimino"              → { street: 'Gedimino',   houseNumber: undefined }
// Everything after the first comma is a locality hint we don't filter on — the
// registry has no combined free-text search, and including it would match no
// street name (causing a very slow full scan).
export const parseAddressInput = (input: string): { street: string; houseNumber?: string } => {
  const beforeComma = input.split(',')[0].trim();
  // Trailing token starting with a digit is the plot/building number.
  const match = beforeComma.match(/^(.*?)[\s]+(\d[\w-]*)$/);
  if (match) {
    return { street: match[1].trim(), houseNumber: match[2] };
  }
  return { street: beforeComma };
};

// Build a human-readable label: "<street full name> <building no>, <municipality>".
// Falls back to residential area when there's no street (rural addresses).
const buildLabel = (a: Address): string => {
  const streetPart = a.street?.full_name || a.street?.name || a.residential_area?.name || '';
  const number = a.plot_or_building_number ? ` ${a.plot_or_building_number}` : '';
  const muni = a.municipality?.name ? `, ${a.municipality.name}` : '';
  return `${streetPart}${number}${muni}`.trim().replace(/^,\s*/, '');
};

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

    // Split the input into a street part and an optional house number, e.g.
    // "Vilniaus g. 2, Vilnius" → street "Vilniaus g.", number "2".
    // Passing the whole raw string as a street-name `contains` matches nothing
    // once a house number is typed, and makes the registry do a very slow scan
    // (30s+ timeouts), so we always query the structured fields instead.
    const { street, houseNumber } = parseAddressInput(search);

    let items: Address[] = [];
    try {
      const data = await addressesSearch({
        requestBody: {
          // OR across street-name and residential-area-name so both urban and
          // rural inputs match. `contains` is case-insensitive. When a house
          // number is present, narrow by it too.
          filters: [
            {
              streets: { name: { contains: street } },
              ...(houseNumber
                ? { addresses: { plot_or_building_number: { starts: houseNumber } } }
                : null),
            },
            { residential_areas: { name: { contains: street } } },
          ],
        },
        size: 8,
        srid: 4326,
      });
      items = data.items || [];
    } catch (err) {
      this.logger.warn('Address suggest failed', err);
      items = [];
    }

    const suggestions: AddressSuggestion[] = items
      .filter((a) => a?.geometry?.data)
      .map((a) => {
        const geom: any = wktToGeoJSON(a.geometry.data);
        return { code: a.code, label: buildLabel(a), geometry: geom };
      })
      .filter((s) => !!s.label);

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
