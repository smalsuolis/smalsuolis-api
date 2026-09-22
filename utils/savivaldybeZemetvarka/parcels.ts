import wkx from 'wkx';
import * as turf from '@turf/turf';
import { Feature } from 'geojsonjs';
import { parcelsSearch } from '../boundaries';
import { ParcelIds } from './cadastral';

/**
 * Resolving parcel identifiers to geometry through boundaries.biip.lt.
 *
 * The registry is asked for both notations separately, because they are
 * different identifiers and not two spellings of one. A unique number is never
 * rewritten as a cadastral number to save a lookup: `7213-0002-0086` rewritten
 * that way names a parcel that does not exist, and the registry answers the
 * honest lookup with `7213/0005:0086`.
 *
 * Every answer is checked against the municipality the notice was published by.
 * A parcel in the wrong municipality means the identifier was misread, and a
 * silently misplaced parcel is worse than a missing one: it puts a notice on
 * someone else's map and into someone else's subscription.
 */

// The registry accepts up to 100 identifiers per request.
const CHUNK_SIZE = 100;

export type ResolvedParcel = {
  cadastralNumber: string;
  municipalityCode: string;
  municipalityName: string;
  geometry: Feature;
};

/** Keyed by the identifier as it was written in the notice. */
export type ParcelLookup = Map<string, ResolvedParcel>;

export type ParcelResolution = {
  lookup: ParcelLookup;
  /**
   * True when the registry failed to answer for part of the batch.
   *
   * The caller must not retire anything on such a run: a record whose parcels
   * went unresolved produces no event, so its id is absent from the run's list
   * of what is still valid, and cleanup would read that as "the municipality
   * stopped listing it" — soft-deleting up to a hundred live notices and
   * re-creating them, with fresh timestamps, on the next successful run.
   */
  incomplete: boolean;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

function toResolved(item: any): ResolvedParcel | null {
  if (!item?.geometry?.data || !item?.cadastral_number) return null;
  const geometry = wkx.Geometry.parse(item.geometry.data).toGeoJSON();
  return {
    cadastralNumber: item.cadastral_number,
    municipalityCode: String(item.municipality?.code ?? ''),
    municipalityName: item.municipality?.name ?? '',
    geometry: { type: 'Feature', geometry } as Feature,
  };
}

/**
 * Look up every identifier a run collected, in as few requests as possible.
 *
 * `onError` reports a failed chunk rather than throwing: one unlucky batch must
 * not cost the whole run, and the caller counts what went missing.
 */
export async function resolveParcels(
  ids: ParcelIds,
  onError?: (message: string) => void,
): Promise<ParcelResolution> {
  const lookup: ParcelLookup = new Map();
  let incomplete = false;

  for (const group of chunk(ids.cadastrals, CHUNK_SIZE)) {
    try {
      const data = await parcelsSearch({
        requestBody: {
          filters: group.map((cadastral_number) => ({
            parcels: { cadastral_number: { exact: cadastral_number } },
          })),
        },
        size: CHUNK_SIZE,
        srid: 4326,
      });
      for (const item of data.items ?? []) {
        const resolved = toResolved(item);
        if (resolved) lookup.set(resolved.cadastralNumber, resolved);
      }
    } catch (err: any) {
      incomplete = true;
      onError?.(`cadastral chunk of ${group.length} failed: ${err?.message ?? err}`);
    }
  }

  for (const group of chunk(ids.uniqueNumbers, CHUNK_SIZE)) {
    try {
      const data = await parcelsSearch({
        requestBody: {
          filters: [{ parcels: { unique_numbers: group.map(Number) } }],
        },
        size: CHUNK_SIZE,
        srid: 4326,
      });
      for (const item of data.items ?? []) {
        const resolved = toResolved(item);
        // Keyed by the unique number as written, since that is what the notice
        // gives; the cadastral number the registry returns is kept for display.
        if (resolved && item.unique_number != null) {
          lookup.set(String(item.unique_number).padStart(12, '0'), resolved);
        }
      }
    } catch (err: any) {
      incomplete = true;
      onError?.(`unique-number chunk of ${group.length} failed: ${err?.message ?? err}`);
    }
  }

  return { lookup, incomplete };
}

export type ParcelGeometry = {
  geom: any;
  /** Cadastral numbers, for display — resolved from unique numbers where needed. */
  cadastralNumbers: string[];
  /** Identifiers the registry did not recognise. */
  unresolved: string[];
  /** Identifiers resolved to a parcel in a different municipality. */
  wrongMunicipality: string[];
};

/**
 * Combine one notice's parcels into a single geometry.
 *
 * `expectedMunicipalityCode` is optional because not every source knows which
 * municipality it is reading; where it is known, mismatches are dropped rather
 * than trusted.
 */
export function buildGeometry(
  ids: ParcelIds,
  lookup: ParcelLookup,
  expectedMunicipalityCode?: string,
): ParcelGeometry | null {
  const written = [...ids.cadastrals, ...ids.uniqueNumbers];
  const unresolved: string[] = [];
  const wrongMunicipality: string[] = [];
  const parcels: ResolvedParcel[] = [];

  for (const id of written) {
    const resolved = lookup.get(id);
    if (!resolved) {
      unresolved.push(id);
      continue;
    }
    if (expectedMunicipalityCode && resolved.municipalityCode !== expectedMunicipalityCode) {
      wrongMunicipality.push(id);
      continue;
    }
    parcels.push(resolved);
  }

  if (!parcels.length) return null;

  const features = parcels.map((p) => p.geometry);
  const combined: any =
    features.length === 1 ? features[0] : turf.union(turf.featureCollection(features as any));
  if (!combined?.geometry) return null;
  combined.geometry.crs = 'EPSG:4326';

  return {
    geom: combined,
    cadastralNumbers: [...new Set(parcels.map((p) => p.cadastralNumber))].sort(),
    unresolved,
    wrongMunicipality,
  };
}

/**
 * The municipality a set of parcels belongs to, taken from the registry's own
 * answers rather than from a hand-kept mapping.
 *
 * A parcel identifier is easy to misread, and a misread one usually resolves to
 * a real parcel somewhere else in the country. The majority answer for one
 * municipality is what that municipality is; anything disagreeing with it was
 * misread, and putting it on the map would place a notice in a stranger's
 * subscription.
 *
 * Returns undefined below `minimumSupport`, because a source with a couple of
 * notices says nothing about which municipality it is — and guessing there
 * would reject the very parcels it was meant to protect.
 */
export function majorityMunicipalityCode(
  writtenIds: string[],
  lookup: ParcelLookup,
  minimumSupport = 5,
): string | undefined {
  const counts = new Map<string, number>();
  for (const id of writtenIds) {
    const code = lookup.get(id)?.municipalityCode;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return bestCount >= minimumSupport ? best : undefined;
}
