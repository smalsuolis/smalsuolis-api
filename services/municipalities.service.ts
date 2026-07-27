'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { Knex } from 'knex';
import DbConnection from '../mixins/database.mixin';
import {
  CommonFields,
  CommonPopulates,
  COMMON_DEFAULT_SCOPES,
  COMMON_FIELDS,
  COMMON_SCOPES,
  EndpointType,
  Table,
} from '../types';
import { municipalitiesSearch, municipalitiesGetWithGeometry } from '../utils/boundaries';

interface Fields extends CommonFields {
  code: string;
  name: string;
}

interface Populates extends CommonPopulates {}

export type Municipality<
  P extends keyof Populates = never,
  F extends keyof (Fields & Populates) = keyof Fields,
> = Table<Fields, Populates, P, F>;

// Municipality boundary polygons, imported from boundaries.biip.lt. The geom
// column (EPSG:3346) is managed outside the moleculer field layer via raw SQL,
// since the DB mixin doesn't handle PostGIS geometry.
@Service({
  name: 'municipalities',
  mixins: [
    DbConnection({
      collection: 'municipalities',
    }),
  ],
  settings: {
    fields: {
      id: {
        type: 'number',
        columnType: 'integer',
        primaryKey: true,
        secure: true,
      },
      code: 'string|required',
      name: 'string|required',
      ...COMMON_FIELDS,
    },
    scopes: {
      ...COMMON_SCOPES,
    },
    defaultScopes: [...COMMON_DEFAULT_SCOPES],
  },
})
export default class MunicipalitiesService extends moleculer.Service {
  // Fetch all municipalities from the LT boundaries registry and upsert them
  // (code, name, geom) into the local table. Geometry is requested in EPSG:3346
  // EWKT so it drops straight into ST_GeomFromEWKT and matches events.geom.
  // Idempotent: re-running refreshes names/geometries in place.
  @Action({
    timeout: 10 * 60 * 1000,
    auth: EndpointType.ADMIN,
  })
  async import(ctx: Context) {
    const adapter = await this.getAdapter(ctx);
    const knex: Knex = adapter.client;

    const list = await municipalitiesSearch({ size: 100, requestBody: {} });
    const items = list.items || [];
    this.logger.info(`[municipalities.import] fetched ${items.length} municipalities`);

    let imported = 0;
    let skipped = 0;

    for (const item of items) {
      const code = String(item.code);
      try {
        const withGeom = await municipalitiesGetWithGeometry({
          code: item.code,
          srid: 3346,
          geometryOutputFormat: 'ewkt',
        });
        const ewkt = withGeom?.geometry?.data;
        if (!ewkt) {
          this.logger.warn(`[municipalities.import] no geometry for ${code} (${item.name})`);
          skipped++;
          continue;
        }

        // Upsert on the unique `code`. Geometry set via ST_GeomFromEWKT so the
        // stored SRID stays 3346.
        await knex.raw(
          `INSERT INTO municipalities (code, name, geom, created_at, updated_at)
           VALUES (?, ?, ST_GeomFromEWKT(?), now(), now())
           ON CONFLICT (code) DO UPDATE
             SET name = EXCLUDED.name,
                 geom = EXCLUDED.geom,
                 updated_at = now()`,
          [code, item.name, ewkt],
        );
        imported++;
      } catch (err: any) {
        this.logger.warn(
          `[municipalities.import] failed for ${code} (${item.name}): ${err?.message || err}`,
        );
        skipped++;
      }
    }

    this.logger.info(`[municipalities.import] done: imported=${imported} skipped=${skipped}`);
    return { total: items.length, imported, skipped };
  }

  // One-off backfill: stamp municipalityId on existing events by spatially
  // joining each event's geom to the municipality that contains it. Batched by
  // event id range to keep each UPDATE bounded and avoid long locks on the hot
  // events table (~2.1M rows). Both geoms are SRID 3346 with GIST indexes.
  //
  // Events are a mix of POINTs (~88%) and POLYGON/MULTIPOLYGON (~12%, lumbering
  // + land parcels), and a polygon event can straddle a municipality border. To
  // assign exactly one municipality deterministically, we match the municipality
  // whose polygon contains the event's ST_PointOnSurface (a representative point
  // guaranteed to lie inside the geom) — for POINT geoms this is the point
  // itself. Idempotent — only fills rows where municipalityId IS NULL, so it can
  // resume if interrupted.
  @Action({
    timeout: 60 * 60 * 1000,
    auth: EndpointType.ADMIN,
    params: {
      batchSize: { type: 'number', optional: true, convert: true, default: 20000 },
    },
  })
  async backfillEvents(ctx: Context<{ batchSize?: number }>) {
    const adapter = await this.getAdapter(ctx);
    const knex: Knex = adapter.client;
    const batchSize = ctx.params.batchSize || 20000;

    const { rows: bounds } = await knex.raw(
      `SELECT min(id)::bigint AS min, max(id)::bigint AS max FROM events`,
    );
    const min = Number(bounds[0]?.min ?? 0);
    const max = Number(bounds[0]?.max ?? -1);
    if (max < min) {
      return { updated: 0, batches: 0, note: 'no events' };
    }

    let updated = 0;
    let batches = 0;
    for (let lo = min; lo <= max; lo += batchSize) {
      const hi = lo + batchSize - 1;
      const { rowCount } = await knex.raw(
        `UPDATE events e
         SET municipality_id = sub.municipality_id
         FROM (
           SELECT e2.id AS event_id, m.id AS municipality_id
           FROM events e2
           CROSS JOIN LATERAL (
             SELECT m.id
             FROM municipalities m
             WHERE ST_Intersects(m.geom, ST_PointOnSurface(e2.geom))
             LIMIT 1
           ) m
           WHERE e2.id BETWEEN ? AND ?
             AND e2.municipality_id IS NULL
             AND e2.geom IS NOT NULL
         ) sub
         WHERE e.id = sub.event_id`,
        [lo, hi],
      );
      updated += rowCount || 0;
      batches++;
      if (batches % 10 === 0) {
        this.logger.info(
          `[municipalities.backfillEvents] id<=${hi}/${max}, updated so far=${updated}`,
        );
      }
    }

    this.logger.info(`[municipalities.backfillEvents] done: updated=${updated} batches=${batches}`);
    return { updated, batches, min, max };
  }
}
