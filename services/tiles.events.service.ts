'use strict';

import moleculer, { Context, GenericObject } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';
import PostgisMixin from 'moleculer-postgis';
import DbConnection from '../mixins/database.mixin';
import {
  COMMON_DEFAULT_SCOPES,
  COMMON_SCOPES,
  CommonFields,
  CommonPopulates,
  EndpointType,
  Table,
  throwNotFoundError,
} from '../types';
import Supercluster from 'supercluster';
// @ts-ignore
import vtpbf from 'vt-pbf';
import _ from 'lodash';
import { LKS_SRID, parseToJsonIfNeeded } from '../utils';
import { applyEventsQueryBySubscriptions } from './events.service';
import { Subscription } from './subscriptions.service';
import { Knex } from 'knex';

interface Fields extends CommonFields {
  name: string;
  body: string;
  url: string;
  appName: string;
  geom: any;
  startAt: Date;
  endAt?: Date;
  isFullDay: boolean;
  externalId: string;
}

interface Populates extends CommonPopulates {}

export type TilesEvent<
  P extends keyof Populates = never,
  F extends keyof (Fields & Populates) = keyof Fields,
> = Table<Fields, Populates, P, F>;

const superclusterOpts = {
  radius: 64,
  extent: 512,
  generateId: true,
  reduce: (acc: any, props: any) => acc,
};

const isLocalDevelopment = process.env.NODE_ENV === 'local';
const WGS_SRID = 4326;

function getSuperclusterHash(query: any = {}) {
  if (typeof query !== 'string') {
    query = JSON.stringify(query);
  }
  return query || 'default';
}

@Service({
  name: 'tiles.events',
  mixins: [
    DbConnection({
      collection: 'events',
      createActions: {
        create: false,
        update: false,
        createMany: false,
        remove: false,
      },
    }),
    PostgisMixin({
      srid: WGS_SRID,
      geojson: {
        maxDecimalDigits: 5,
      },
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
      name: 'string',
      geom: {
        type: 'any',
        geom: {
          properties: ['id'],
        },
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
      category: {
        type: 'number',
        columnType: 'integer',
        columnName: 'categoryId',
      },
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
    find: {
      rest: null,
    },
    count: {
      rest: null,
    },
  },
  hooks: {
    before: {
      list: ['applyFilters'],
      find: ['applyFilters'],
      get: ['applyFilters'],
      resolve: ['applyFilters'],
      getEventsFeatureCollection: ['applyFilters'],
    },
  },
})
export default class TilesEventsService extends moleculer.Service {
  @Action({
    rest: 'GET /:z/:x/:y',
    params: {
      x: 'number|convert|min:0|integer',
      z: 'number|convert|min:0|integer',
      y: 'number|convert|min:0|integer',
      query: ['object|optional', 'string|optional'],
    },
    auth: EndpointType.PUBLIC,

    timeout: 0,
  })
  async getTile(
    ctx: Context<
      { x: number; y: number; z: number; query: string | GenericObject },
      { $responseHeaders: any; $responseType: string }
    >,
  ) {
    const { x, y, z } = ctx.params;

    ctx.params.query = parseToJsonIfNeeded(ctx.params.query);
    ctx.meta.$responseType = 'application/x-protobuf';

    // make clusters
    if (z <= 12) {
      const supercluster: Supercluster = await this.getSupercluster(ctx);

      const tileEvents = supercluster.getTile(z, x, y);

      const layers: any = {};

      if (tileEvents) {
        layers.events = tileEvents;
      }

      return Buffer.from(vtpbf.fromGeojsonVt(layers, { extent: superclusterOpts.extent }));
    }

    // show real geometries
    const tileData = await this.getMVTTiles(ctx);
    return tileData.tile;
  }

  @Action({
    rest: 'GET /cluster/:cluster/items',
    params: {
      cluster: 'number|convert|positive|integer',
      page: 'number|convert|positive|integer|optional',
      pageSize: 'number|convert|positive|integer|optional',
    },

    auth: EndpointType.PUBLIC,
  })
  async getTileItems(
    ctx: Context<
      {
        cluster: number;
        query: string | GenericObject;
        page?: number;
        pageSize?: number;
        populate?: string | string[];
        sort?: string | string[];
      },
      { $responseHeaders: any; $responseType: string }
    >,
  ) {
    const { cluster } = ctx.params;
    const page = ctx.params.page || 1;
    const pageSize = ctx.params.pageSize || 10;
    const { sort, populate } = ctx.params;
    const supercluster: Supercluster = await this.getSupercluster(ctx);

    if (!supercluster) throwNotFoundError('No items!');

    const ids = supercluster.getLeaves(cluster, Infinity).map((i) => i.properties.id);

    if (!ids?.length) {
      return {
        rows: [],
        total: 0,
        page,
        pageSize,
        totalPages: 0,
      };
    }

    return ctx.call('tiles.events.list', {
      query: {
        // knex support for `$in` is limited to 30K or smth
        $raw: `id IN ('${ids.join("', '")}')`,
      },
      populate,
      page,
      pageSize,
      sort,
    });
  }

  @Method
  async getMVTTiles(ctx: Context<{ query: any; x: number; y: number; z: number }>) {
    ctx = await this.applyFilters(ctx);
    const adapter = await this.getAdapter(ctx);
    const table = adapter.getTable();
    const knex: Knex = adapter.client;

    const query = await this.getComputedQuery(ctx);

    const fields = ['id'];
    const { x, y, z } = ctx.params;

    const WM_SRID = 3857;
    const envelopeQuery = `ST_TileEnvelope(${z}, ${x}, ${y})`;
    const transformedEnvelopeQuery = `ST_Transform(${envelopeQuery}, ${LKS_SRID})`;
    const transformedGeomQuery = `ST_Transform(ST_CurveToLine("geom"), ${WM_SRID})`;

    const asMvtGeomQuery = adapter
      .computeQuery(table, query)
      .whereRaw(`ST_Intersects(events.geom, ${transformedEnvelopeQuery})`)
      .select(
        ...fields,
        knex.raw(`ST_AsMVTGeom(${transformedGeomQuery}, ${envelopeQuery}, 4096, 64, true) AS geom`),
      );

    const tileQuery = knex
      .select(knex.raw(`ST_AsMVT(tile, 'events', 4096, 'geom') as tile`))
      .from(asMvtGeomQuery.as('tile'))
      .whereNotNull('geom');

    return tileQuery.first();
  }

  @Action({
    timeout: 0,
  })
  async getEventsFeatureCollection(ctx: Context<{ query: any }>) {
    const adapter = await this.getAdapter(ctx);
    const table = adapter.getTable();
    const knex = adapter.client;

    const query = await this.getComputedQuery(ctx);
    const fields = ['id'];

    const eventsQuery = adapter
      .computeQuery(table, query)
      .select(...fields, knex.raw(`ST_Transform(ST_PointOnSurface(geom), ${WGS_SRID}) as geom`));

    const res = await knex
      .select(knex.raw(`ST_AsGeoJSON(e)::json as feature`))
      .from(eventsQuery.as('e'));

    return {
      type: 'FeatureCollection',
      features: res.map((i: any) => i.feature),
    };
  }

  @Method
  async getComputedQuery(ctx: Context<{ query: any }>) {
    let { params } = ctx;
    params = this.sanitizeParams(params);
    params = await this._applyScopes(params, ctx);
    params = this.paramsFieldNameConversion(params);

    return parseToJsonIfNeeded(params.query) || {};
  }

  @Method
  async getSupercluster(ctx: Context<{ query: any }>) {
    const hash = getSuperclusterHash(ctx.params.query);

    if (!this.superclusters?.[hash]) {
      await this.renewSuperclusterIndex(ctx.params.query);
    }

    return this.superclusters[hash];
  }

  @Method
  async renewSuperclusterIndex(query: any = {}) {
    // TODO: apply to all superclusters (if exists)
    const hash = getSuperclusterHash(query);

    const supercluster = new Supercluster(superclusterOpts);

    // Singleton!
    if (this.superclustersPromises[hash]) {
      return this.superclustersPromises[hash];
    }

    this.superclustersPromises[hash] = this.actions.getEventsFeatureCollection({ query });
    const featureCollection: any = await this.superclustersPromises[hash];

    supercluster.load(featureCollection.features || []);
    this.superclusters[hash] = supercluster;

    delete this.superclustersPromises[hash];
  }

  @Method
  async applyFilters(ctx: Context<any>) {
    ctx.params.query = parseToJsonIfNeeded(ctx.params.query) || {};

    if (ctx.params.query.subscription) {
      const subscriptions: Subscription[] = await ctx.call('subscriptions.find', {
        query: { id: ctx.params.query.subscription },
        populate: 'geomWithBuffer',
      });
      // Mirror events.service.ts: subscription.categories may be at any level
      // (the user picks coarse codes; events have leaf category_ids). Expand
      // each via the cached descendant index before passing to the SQL builder.
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

    // `categoryGroup` mirrors events.service.ts behavior so the map view's
    // tile requests honor the category filter — same expansion semantics:
    // single id or an array, each one walked via categories.descendants and
    // unioned into a flat leaf-id list.
    if (ctx.params.query.categoryGroup) {
      const raw = ctx.params.query.categoryGroup;
      const groups = (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Number.isFinite);
      if (groups.length) {
        const sets: number[][] = await Promise.all(
          groups.map((id) => ctx.call<number[], { id: number }>('categories.descendants', { id })),
        );
        const ids = [...new Set(sets.flat())];
        ctx.params.query.category = { $in: ids.length ? ids : [-1] };
      }
      delete ctx.params.query.categoryGroup;
    }

    return ctx;
  }

  @Event()
  async '$broker.started'() {
    this.superclusters = {};
    this.superclustersPromises = {};
    // This takes time
    if (!isLocalDevelopment) {
      try {
        await this.renewSuperclusterIndex();
      } catch (err) {
        console.error('Cannot create super clusters', err);
      }
    }
  }

  @Event()
  async 'cache.clean.tiles.events'() {
    await this.broker.cacher?.clean(`${this.fullName}.**`);
  }

  @Event()
  async 'integrations.sync.finished'() {
    // Every cached cluster index has to go, not just the promises. They are
    // keyed by the query they were built for, and the map always sends one —
    // the user's app filter — so the index the map actually reads is never the
    // unfiltered one rebuilt below. Clearing only the promises left every
    // filtered index holding the events it was first built from: after an
    // import that took an app from 76 events to 12,000, the map still drew 76
    // while the counts beside it read 12,000. It affected every app's filtered
    // view, and only a restart cleared it.
    this.superclusters = {};
    this.superclustersPromises = {};
    // Rebuilt eagerly for the unfiltered view; filtered ones rebuild lazily on
    // the next tile request for that query.
    await this.renewSuperclusterIndex();
  }

  started() {
    this.superclusters = {};
    this.superclustersPromises = {};
  }
}
