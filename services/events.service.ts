'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';
import PostgisMixin, { intersectsQuery } from 'moleculer-postgis';
import DbConnection from '../mixins/database.mixin';
import {
  CommonFields,
  CommonPopulates,
  COMMON_DEFAULT_SCOPES,
  COMMON_FIELDS,
  COMMON_SCOPES,
  EndpointType,
  Table,
  UserAuthMeta,
  QueryObject,
} from '../types';
import { App, APP_TYPE } from './apps.service';
import { LKS_SRID, parseToJsonIfNeeded } from '../utils';
import { Subscription } from './subscriptions.service';
import { Tag } from './tags.service';
import { Category } from './categories.service';
import { Knex } from 'knex';
import _ from 'lodash';

interface Fields extends CommonFields {
  app: number;
  name: string;
  type: string;
  geom: any;
  url: string;
  body: string;
  startAt: Date;
  endAt?: Date;
  isFullDay: boolean;
  externalId: string;
  tags: number[];
  tagsData: { id: Tag['id']; name: string; value: number }[];
  category?: number | null;
}

export type EventBodyJSON = {
  title: String;
  value: String;
};

export function toEventBodyMarkdown(data: EventBodyJSON[]) {
  return data.map((i) => `**${i.title}**: ${i.value || '-'}`).join('\n\n');
}

interface Populates extends CommonPopulates {
  app: App;
  tags: Tag[];
  category: Category;
}

export type Event<
  P extends keyof Populates = never,
  F extends keyof (Fields & Populates) = keyof Fields,
> = Table<Fields, Populates, P, F>;

// returns query with apps and geom filtering based on provided subscriptions.
export function applyEventsQueryBySubscriptions(query: QueryObject, subscriptions: Subscription[]) {
  if (!subscriptions?.length) {
    return query;
  }

  const subscriptionQuery = subscriptions.map((subscription) => {
    const condition: any = {
      ...(!!subscription.apps?.length && { app: { $in: subscription.apps } }),
      $raw: intersectsQuery('geom', subscription.geomWithBuffer, LKS_SRID),
    };

    if (subscription.textFilter) {
      const escaped = subscription.textFilter.replace(/'/g, "''");
      const textCondition = `(name ILIKE '%${escaped}%' OR body ILIKE '%${escaped}%')`;
      condition.$raw = condition.$raw ? `(${condition.$raw}) AND ${textCondition}` : textCondition;
    }

    // Categories only exist for infostatyba events; other apps' events have
    // category_id = NULL. Apply the filter PERMISSIVELY: events without a
    // category pass through, and categorized events must match. So a sub with
    // apps=[infostatyba, miškai] and categories=[gyvenamieji] keeps all miškai
    // events flowing while narrowing the infostatyba subset.
    // `categories` here is expected to already be expanded to leaf ids by the
    // caller (see events.applyFilters) — user picks any-level codes,
    // expansion happens via categories.descendants and is cached in-memory.
    if (subscription.categories?.length) {
      const ids = subscription.categories
        .map((id) => Number(id))
        .filter(Number.isFinite)
        .join(',');
      if (ids) {
        const catCondition = `(category_id IS NULL OR category_id IN (${ids}))`;
        condition.$raw = condition.$raw ? `(${condition.$raw}) AND ${catCondition}` : catCondition;
      }
    }

    return condition;
  });

  if (query?.$or) {
    query.$and = [query?.$or, { $or: subscriptionQuery }];
    delete query?.$or;
  } else {
    query.$or = subscriptionQuery;
  }

  return query;
}

@Service({
  name: 'events',
  mixins: [
    DbConnection({
      collection: 'events',
    }),
    PostgisMixin({ srid: LKS_SRID, geojson: { maxDecimalDigits: 2 } }),
  ],
  settings: {
    fields: {
      id: {
        type: 'number',
        columnType: 'integer',
        primaryKey: true,
        secure: true,
      },
      externalId: 'string',
      name: 'string|required',
      geom: {
        type: 'any',
        geom: true,
      },
      app: {
        type: 'number',
        columnType: 'integer',
        columnName: 'appId',
        populate: 'apps.resolve',
      },
      url: 'string',
      body: 'string',
      startAt: {
        type: 'date',
        required: true,
        columnType: 'datetime',
      },
      endAt: {
        type: 'date',
        required: false,
        columnType: 'datetime',
      },
      isFullDay: {
        type: 'boolean',
        default: false,
      },
      tags: {
        type: 'array',
        populate: {
          action: 'tags.resolve',
          params: {
            fields: ['id', 'name'],
          },
        },
        default: [],
      },
      tagsData: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: 'number',
            name: 'string',
            value: 'number',
          },
        },
      },
      category: {
        type: 'number',
        columnType: 'integer',
        columnName: 'categoryId',
        populate: 'categories.resolve',
      },
      municipality: {
        type: 'number',
        columnType: 'integer',
        columnName: 'municipalityId',
        populate: 'municipalities.resolve',
      },
      ...COMMON_FIELDS,
    },
    scopes: {
      ...COMMON_SCOPES,
    },
    defaultScopes: [...COMMON_DEFAULT_SCOPES],
  },
  actions: {
    list: {
      auth: EndpointType.PUBLIC,
    },
    get: {
      auth: EndpointType.PUBLIC,
    },
    count: {
      auth: EndpointType.PUBLIC,
    },
    find: {
      rest: null,
    },
    create: {
      rest: null,
    },
    update: {
      rest: null,
    },
    remove: {
      rest: null,
    },
  },
  hooks: {
    before: {
      list: ['applyFilters'],
      find: ['applyFilters'],
      count: ['applyFilters'],
      get: ['applyFilters'],
      resolve: ['applyFilters'],
    },
    after: {
      create: 'assignMunicipality',
      update: 'assignMunicipality',
    },
  },
})
export default class EventsService extends moleculer.Service {
  private statsCache = new Map<string, { data: any; expiry: number }>();
  private readonly STATS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  private readonly STATS_CACHE_MAX_ENTRIES = 2000;

  @Action({
    rest: {
      method: 'GET',
      path: '/',
      basePath: '/stats',
    },
    auth: EndpointType.PUBLIC,
    timeout: 3 * 60 * 1000,
  })
  async stats(ctx: Context<{ query: any; noCache?: boolean }>) {
    const cacheKey = JSON.stringify(ctx.params.query ?? null);
    const cached = this.statsCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry && !ctx.params.noCache) {
      return cached.data;
    }
    const adapter = await this.getAdapter(ctx);
    const table = adapter.getTable();
    const knex: Knex = adapter.client;

    const query = await this.getComputedQuery(ctx);
    const eventsQuery = adapter.computeQuery(table, query);
    const tagsById: { [key: string]: Tag } = await ctx.call('tags.find', { mapping: 'id' });

    const appTypeCaseWhenClause = Object.keys(APP_TYPE).map(
      (key: string) => `WHEN apps.key = '${key}' THEN '${APP_TYPE[key]}'`,
    );

    const appTypeCaseClause = `CASE ${appTypeCaseWhenClause.join(' ')} END AS app_type`;

    const eventsCountByAppType = await knex
      .select('ecat.appType')
      .count('ecat.id')
      .from(
        knex
          .select('events.id', knex.raw(appTypeCaseClause))
          .from(eventsQuery.as('events'))
          .leftJoin('apps', 'events.appId', 'apps.id')
          .as('ecat'),
      )
      .groupBy('ecat.appType');

    const eventsCountByTagId = await knex
      .select(knex.raw('jsonb_array_elements(events.tags)::numeric as tag_id'))
      .count('events.id')
      .from(eventsQuery.as('events'))
      .groupBy('tagId');

    // Per-app, per-category breakdown. Uses category_id directly (not tags
    // jsonb), so it's a simple GROUP BY join. The `apps.key` is what the web
    // already keys `byApp` on, and `categories.code` is the stable identifier
    // we want exposed (the web side maps codes → display names).
    const eventsCountByCategory = await knex
      .select('apps.key as appKey', 'categories.code as code')
      .count('events.id')
      .from(eventsQuery.as('events'))
      .innerJoin('apps', 'events.appId', 'apps.id')
      .innerJoin('categories', 'events.categoryId', 'categories.id')
      .groupBy('apps.key', 'categories.code');

    // Per-municipality, per-appType breakdown — feeds the "Akyviausi miestai"
    // cards (top cities with a per-app split). innerJoin on municipalities drops
    // events with no municipality (geom outside every polygon), matching how
    // byCategory/byTag exclude unmatched events. Ordered/limited on the web side.
    const eventsCountByMunicipality = await knex
      .select('municipalities.name as municipality', 'apps.key as appKey')
      .count('events.id')
      .from(eventsQuery.as('events'))
      .innerJoin('municipalities', 'events.municipalityId', 'municipalities.id')
      .leftJoin('apps', 'events.appId', 'apps.id')
      .groupBy('municipalities.name', 'apps.key');

    const eventsCountByTagData = await knex
      .select(knex.raw('td.tag_id::numeric'), 'td.tagName')
      .sum({
        count: knex.raw("(NULLIF(regexp_replace(td.tag_value, '[^0-9.]', '', 'g'), ''))::numeric"),
      })
      .sum({ area: knex.raw('td.tag_value_area::numeric') })
      .from(
        knex
          .select(
            'elem.tag_id',
            'elem.tag_name',
            'elem.tag_value',
            knex.raw(`
              CASE 
                WHEN elem.tag_name IN ('Plynas', 'Plynas sanitarinis', 'Lydimo') THEN 
                  (NULLIF(regexp_replace(elem.tag_value, '[^0-9.]', '', 'g'), ''))::numeric * 1
                WHEN elem.tag_name = 'Atvejiniai' THEN 
                  (NULLIF(regexp_replace(elem.tag_value, '[^0-9.]', '', 'g'), ''))::numeric * 0.5
                ELSE 
                  (NULLIF(regexp_replace(elem.tag_value, '[^0-9.]', '', 'g'), ''))::numeric * 0.25
              END as tag_value_area
            `),
          )
          .from(
            knex
              .select(
                knex.raw(`jsonb_array_elements(events.tags_data)->>'id' as tag_id`),
                knex.raw(`jsonb_array_elements(events.tags_data)->>'name' as tag_name`),
                knex.raw(`jsonb_array_elements(events.tags_data)->>'value' as tag_value`),
              )
              .from(eventsQuery.as('events'))
              .whereNotNull('events.tagsData')
              .as('elem'),
          )
          .as('td'),
      )
      .groupBy(['tagId', 'tagName']);

    const stats: {
      count: number;

      byApp: {
        [key: App['key']]: {
          count: number;
          byTag?: { [key: Tag['name']]: { count: number; [key: string]: number } };
          byCategory?: { [key: string]: { count: number } };
        };
      };
      byMunicipality: {
        [name: string]: {
          count: number;
          byApp: { [appType: string]: number };
        };
      };
    } = {
      byApp: {},
      byMunicipality: {},
      count: 0,
    };

    eventsCountByAppType?.forEach((item) => {
      const count = Number(item.count);
      const path = ['byApp', item.appType, 'count'];
      const existingCount = _.get(stats, path, 0);
      _.set(stats, path, existingCount + count);
      stats.count += count;
    });

    eventsCountByTagId?.forEach((item) => {
      const tag = tagsById[item.tagId];
      const count = Number(item.count);

      // Web expects the tag name as the key, with an object containing count
      const path = ['byApp', tag.appType, 'byTag', tag.name, 'count'];
      const existingCount = _.get(stats, path, 0);
      _.set(stats, path, existingCount + count);
    });

    // byCategory: existing `byApp` is keyed by APP_TYPE (e.g. 'infostatyba'),
    // not by app.key — same convention applies here. Multiple apps share an
    // appType (e.g. infostatyba-naujas + infostatyba-remontas → 'infostatyba'),
    // so counts get summed across them.
    eventsCountByCategory?.forEach((item: { appKey: string; code: string; count: any }) => {
      const appType = APP_TYPE[item.appKey];
      if (!appType || !item.code) return;
      const count = Number(item.count);
      const path = ['byApp', appType, 'byCategory', item.code, 'count'];
      const existingCount = _.get(stats, path, 0);
      _.set(stats, path, existingCount + count);
    });

    // byMunicipality: keyed by municipality name; each has a total count plus a
    // per-appType split (app.key → APP_TYPE, same mapping as byCategory).
    eventsCountByMunicipality?.forEach((item: { municipality: string; appKey: string; count: any }) => {
      if (!item.municipality) return;
      const appType = APP_TYPE[item.appKey];
      const count = Number(item.count);

      const totalPath = ['byMunicipality', item.municipality, 'count'];
      _.set(stats, totalPath, _.get(stats, totalPath, 0) + count);

      if (appType) {
        const appPath = ['byMunicipality', item.municipality, 'byApp', appType];
        _.set(stats, appPath, _.get(stats, appPath, 0) + count);
      }
    });

    eventsCountByTagData?.forEach((item) => {
      const tag = tagsById[item.tagId];
      const count = Number(item.count || 0);
      const area = Number(item.area || 0);

      const categoryAreaPath = ['byApp', tag.appType, 'byTag', tag.name, 'area'];
      const categoryCalculatedAreaPath = [
        'byApp',
        tag.appType,
        'byTag',
        tag.name,
        'calculatedArea',
      ];

      const existingArea = _.get(stats, categoryAreaPath, 0);
      const existingCalculatedArea = _.get(stats, categoryCalculatedAreaPath, 0);

      _.set(stats, categoryAreaPath, existingArea + count);
      _.set(stats, categoryCalculatedAreaPath, existingCalculatedArea + area);
    });

    if (this.statsCache.size >= this.STATS_CACHE_MAX_ENTRIES) {
      this.statsCache.delete(this.statsCache.keys().next().value);
    }
    this.statsCache.set(cacheKey, { data: stats, expiry: Date.now() + this.STATS_CACHE_TTL_MS });

    return stats;
  }

  // Events within `radius` metres of a point (lng/lat, EPSG:4326 — as returned
  // by the address suggest endpoint). Powers the map's address-lookup popup:
  // returns the total count in the circle plus the most recent `limit` events.
  // Uses ST_DWithin on events.geom (SRID 3346, GIST-indexed) after projecting
  // the point, so it uses the spatial index. Public — the map page is public.
  @Action({
    rest: {
      method: 'GET',
      path: '/near',
      basePath: '/events',
    },
    auth: EndpointType.PUBLIC,
    params: {
      lng: { type: 'number', convert: true },
      lat: { type: 'number', convert: true },
      radius: { type: 'number', convert: true, optional: true, default: 2000 },
      limit: { type: 'number', convert: true, optional: true, default: 5 },
    },
    timeout: 30 * 1000,
  })
  async near(
    ctx: Context<{ lng: number; lat: number; radius?: number; limit?: number }>,
  ) {
    const { lng, lat } = ctx.params;
    const radius = ctx.params.radius ?? 2000;
    const limit = ctx.params.limit ?? 5;

    const adapter = await this.getAdapter(ctx);
    const knex: Knex = adapter.client;

    // Point in the events' CRS (3346). `pt` is reused by both queries.
    const pointSql = `ST_Transform(ST_SetSRID(ST_MakePoint(?, ?), 4326), ${LKS_SRID})`;

    const countResult = await knex.raw(
      `SELECT count(*)::int AS count
       FROM events
       WHERE deleted_at IS NULL
         AND geom IS NOT NULL
         AND ST_DWithin(geom, ${pointSql}, ?)`,
      [lng, lat, radius],
    );
    const count = countResult.rows?.[0]?.count ?? 0;

    const eventsResult = await knex.raw(
      `SELECT e.id, e.name, e.start_at AS "startAt", e.url, e.app_id AS "appId",
              apps.name AS "appName", apps.key AS "appKey"
       FROM events e
       LEFT JOIN apps ON apps.id = e.app_id
       WHERE e.deleted_at IS NULL
         AND e.geom IS NOT NULL
         AND ST_DWithin(e.geom, ${pointSql}, ?)
       ORDER BY e.start_at DESC
       LIMIT ?`,
      [lng, lat, radius, limit],
    );

    return { count, radius, events: eventsResult.rows ?? [] };
  }

  @Method
  async applyFilters(ctx: Context<any, UserAuthMeta>) {
    ctx.params.query = parseToJsonIfNeeded(ctx.params.query) || {};

    if (ctx.params.query.subscription) {
      const subscriptions: Subscription[] = await ctx.call('subscriptions.find', {
        query: { id: ctx.params.query.subscription },
        populate: 'geomWithBuffer',
      });
      // Expand subscription.categories (which can be at any level) to flat leaf
      // ids before passing into the query. Done here so the query builder gets
      // a simple `category $in [...leafIds]` instead of needing to walk the tree.
      for (const sub of subscriptions) {
        if (!sub.categories?.length) continue;
        const expanded: number[][] = await Promise.all(
          sub.categories.map((id) =>
            ctx.call<number[], { id: number }>('categories.descendants', { id }),
          ),
        );
        sub.categories = [...new Set(expanded.flat())];
      }
      ctx.params.query = applyEventsQueryBySubscriptions(ctx.params.query, subscriptions);
      delete ctx.params.query.subscription;
    }

    // Expand `categoryGroup=<id|id[]>` into "any event under those subtrees"
    // by walking the category descendant index and rewriting as `category $in`.
    // Accepts either a single id or an array; an array unions the subtrees.
    // Caller can also pass `category=<id>` directly; both are supported.
    if (ctx.params.query.categoryGroup) {
      const raw = ctx.params.query.categoryGroup;
      const groups = (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Number.isFinite);
      if (groups.length) {
        const sets: number[][] = await Promise.all(
          groups.map((id) => ctx.call<number[], { id: number }>('categories.descendants', { id })),
        );
        const ids = [...new Set(sets.flat())];
        // Empty union (group ids didn't match anything) → guarantee an empty
        // result instead of silently falling through to all events.
        ctx.params.query.category = { $in: ids.length ? ids : [-1] };
      }
      delete ctx.params.query.categoryGroup;
    }

    return ctx;
  }

  @Method
  async getComputedQuery(ctx: Context<{ query: any }>) {
    let { params } = ctx;
    params = this.sanitizeParams(params);
    params = await this._applyScopes(params, ctx);
    params = this.paramsFieldNameConversion(params);

    return parseToJsonIfNeeded(params.query) || {};
  }

  // Derive municipalityId from the event's geom on create/update, so newly
  // ingested events stay assigned without a periodic backfill. Runs as an AFTER
  // hook: by this point the geom is already stored in the events table in SRID
  // 3346, so we reuse the exact same ST_PointOnSurface join as the one-off
  // backfill — no need to replicate the postgis mixin's incoming-CRS handling
  // (integrations pass GeoJSON in EPSG:4326, sometimes as a Feature). Matches
  // the municipality whose polygon contains the geom's representative point, so
  // a POLYGON straddling a border maps to exactly one municipality. Unmatched or
  // missing geoms stay null, which stats simply omit. Best-effort: a failure
  // here must never break event ingestion, so the created/updated entity is
  // always returned unchanged and errors are only logged.
  @Method
  async assignMunicipality(ctx: Context, res: any) {
    const id = res?.id;
    if (!id) return res;

    try {
      const adapter = await this.getAdapter(ctx);
      const knex: Knex = adapter.client;
      await knex.raw(
        `UPDATE events e
         SET municipality_id = (
           SELECT m.id
           FROM municipalities m
           WHERE ST_Intersects(m.geom, ST_PointOnSurface(e.geom))
           LIMIT 1
         )
         WHERE e.id = ? AND e.geom IS NOT NULL`,
        [id],
      );
    } catch (err) {
      this.logger.warn('[events.assignMunicipality] lookup failed', err);
    }
    return res;
  }

  // The stats window the public homepage requests. Must be byte-identical to
  // what the web client sends (api.getStats wraps the ALL_TIME range in
  // `{ startAt }` and JSON-stringifies it) so warming here populates the exact
  // same cacheKey the incoming request will look up.
  private readonly HOMEPAGE_STATS_QUERY = JSON.stringify({
    startAt: { $gte: '2000-01-01 00:00', $lt: '2099-12-31 23:59' },
  });

  // Recompute the homepage stats through the real action so the cache is
  // populated under the request's cacheKey. Best-effort: a failure here must
  // never take the service down — the next request just recomputes lazily.
  @Method
  async warmHomepageStats() {
    try {
      await this.actions.stats({ query: this.HOMEPAGE_STATS_QUERY, noCache: true });
    } catch (err) {
      this.logger.warn('Failed to warm homepage stats cache', err);
    }
  }

  // Warm on boot so the very first homepage load is never cold.
  async started() {
    await this.warmHomepageStats();
  }

  // Stats only change when new events land, which happens once per day as the
  // integration syncs finish (infostatyba 00:00 → savivaldybė 06:00). On that
  // signal, drop the stale cache and immediately recompute the homepage window
  // so it's warm again the instant the sync completes — no lazy cold-hit, no
  // time-based guessing. Firing after each of the several nightly syncs is
  // harmless: each just refreshes the same entry.
  @Event({ name: 'integrations.sync.finished' })
  async onIntegrationsSyncFinished() {
    this.statsCache.clear();
    await this.warmHomepageStats();
  }
}
