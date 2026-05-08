'use strict';

import { FeatureCollection, parse } from 'geojsonjs';
import _ from 'lodash';
import moleculer, { Context, GenericObject } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';
import PostgisMixin, { asGeoJsonQuery, intersectsQuery } from 'moleculer-postgis';
import { PopulateHandlerFn } from 'moleculer-postgis/src/mixin';
import DbConnection from '../mixins/database.mixin';
import {
  CommonFields,
  CommonPopulates,
  COMMON_DEFAULT_SCOPES,
  COMMON_FIELDS,
  COMMON_SCOPES,
  EndpointType,
  FieldHookCallback,
  Frequency,
  Table,
  throwNoRightsError,
  UserAuthMeta,
  EntityChangedParams,
} from '../types';
import { LKS_SRID } from '../utils';
import { App } from './apps.service';
import { Category } from './categories.service';
import { User } from './users.service';

interface Fields extends CommonFields {
  name: string;
  user: User['id'];
  apps: number[];
  categories: number[];
  geom: FeatureCollection;
  frequency: Frequency;
  active: boolean;
  textFilter?: string;
  geomWithBuffer?: FeatureCollection;
  eventsCount?: {
    allTime: number;
    new: number;
  };
}

interface Populates extends CommonPopulates {
  apps: App[];
  categories: Category[];
  user: User;
}

export type Subscription<
  P extends keyof Populates = never,
  F extends keyof (Fields & Populates) = keyof Fields,
> = Table<Fields, Populates, P, F>;

@Service({
  name: 'subscriptions',
  mixins: [
    DbConnection({
      collection: 'subscriptions',
    }),
    PostgisMixin({ srid: LKS_SRID }),
  ],
  settings: {
    fields: {
      id: {
        type: 'string',
        columnType: 'integer',
        primaryKey: true,
        secure: true,
      },
      name: 'string|required',
      user: {
        //subscriber
        type: 'number',
        required: true,
        columnType: 'integer',
        columnName: 'userId',
        immutable: true,
        readonly: true,
        populate: 'users.resolve',
        onCreate: async ({ ctx }: FieldHookCallback) => ctx.meta.user?.id,
        onUpdate: async ({ ctx, entity }: FieldHookCallback) => {
          // Allow service updates
          if (!ctx.meta?.user?.id) {
            return entity.userId;
          }

          if (entity.userId !== ctx.meta.user.id) {
            return throwNoRightsError('Unauthorized');
          }

          return entity.userId;
        },
      },
      apps: {
        //apps subscribed to
        type: 'array',
        required: true,
        items: { type: 'number' },
        columnName: 'apps',
        validate: 'validateApps',
        populate(ctx: any, _values: any, items: Subscription[]) {
          return Promise.all(
            items.map((item: Subscription) => {
              if (!item.apps) return [];
              if (typeof item.apps === 'string') item.apps = JSON.parse(item.apps);
              return ctx.call('apps.resolve', { id: item.apps });
            }),
          );
        },
      },
      // User-selected category ids — can be at any level of the hierarchy.
      // Subtree expansion happens at query time (see events.applyFilters),
      // so picking 'pastatai' transparently matches all leaves under it.
      // Empty/missing array = no category restriction (matches everything).
      categories: {
        type: 'array',
        items: { type: 'number' },
        columnName: 'categories',
        default: [],
        validate: 'validateCategories',
        populate(ctx: any, _values: any, items: Subscription[]) {
          return Promise.all(
            items.map((item: Subscription) => {
              if (!item.categories) return [];
              if (typeof item.categories === 'string')
                item.categories = JSON.parse(item.categories);
              if (!item.categories.length) return [];
              return ctx.call('categories.resolve', { id: item.categories });
            }),
          );
        },
      },
      geom: {
        type: 'any',
        geom: {
          type: 'geom',
          properties: {
            bufferSize: 'geomBufferSize',
          },
        },
        required: true,
      },

      geomBufferSize: {
        // radius in meters
        type: 'number',
        set({ params }: any) {
          const bufferSizes = this._getPropertiesFromFeatureCollection(params.geom, 'bufferSize');
          if (!bufferSizes || !bufferSizes?.length) return;
          return bufferSizes[0] || 1000;
        },
        hidden: 'byDefault',
      },

      geomWithBuffer: {
        virtual: true,
        populate: {
          keyField: 'id',
          handler: PopulateHandlerFn('subscriptions.getGeomWithBuffer'),
          params: {
            mapping: true,
          },
        },
      },

      eventsCount: {
        type: 'any',
        readonly: true,
        set: () => null,
      },

      frequency: {
        // email sending frequency
        type: 'enum',
        values: Object.values(Frequency),
      },
      active: { type: 'boolean', default: true }, // is subscription active
      textFilter: 'string',
      ...COMMON_FIELDS,
    },
    scopes: {
      user(query: any, ctx: Context<null, UserAuthMeta>, params: any) {
        if (!ctx?.meta?.user?.id) return query;
        const { user } = ctx.meta;
        query.user = user.id;
        return query;
      },
      ...COMMON_SCOPES,
    },
    defaultScopes: [...COMMON_DEFAULT_SCOPES, 'user'],
  },
  actions: {
    create: {
      auth: EndpointType.USER,
    },
    update: {
      auth: EndpointType.USER,
    },
    list: {
      auth: EndpointType.USER,
    },
    find: {
      auth: EndpointType.USER,
    },
    get: {
      auth: EndpointType.USER,
    },
    count: {
      auth: EndpointType.USER,
    },
    remove: {
      auth: EndpointType.USER,
    },
  },
  hooks: {
    before: {
      remove: ['beforeRemove'],
    },
  },
})
export default class SubscriptionsService extends moleculer.Service {
  @Action({
    params: {
      id: [
        'number|convert',
        {
          type: 'array',
          items: 'number|convert',
        },
      ],
      mapping: 'boolean|optional',
    },
  })
  async getGeomWithBuffer(
    ctx: Context<{
      id: number | number[];
      mapping: boolean;
    }>,
  ) {
    const adapter = await this.getAdapter(ctx);
    const table = adapter.getTable();

    const { id, mapping } = ctx.params;
    const multi = Array.isArray(id);

    const geomField = _.snakeCase('geom');
    const geomBufferField = _.snakeCase('geomBufferSize');

    const transformGeomQuery = `
      CASE
        WHEN ST_GeometryType(${geomField}) IN (
          'ST_Point',
          'ST_LineString',
          'ST_MultiPoint',
          'ST_MultiLineString'
        ) THEN ST_Buffer(${geomField}, ${geomBufferField})
        WHEN ST_GeometryType(${geomField}) IN ('ST_Polygon', 'ST_MultiPolygon') THEN ${geomField}
      END
    `;

    const query = table.select(
      'id',
      table.client.raw(
        asGeoJsonQuery(transformGeomQuery, 'geom', LKS_SRID, {
          digits: 3,
          options: 0,
        }),
      ),
    );

    query[multi ? 'whereIn' : 'where']('id', id);

    const res: any[] = (await query).map((el: any) => ({
      id: el.id,
      geom: parse(el.geom),
    }));

    if (!mapping) return res;

    const result = res.reduce(
      (acc: { [key: string]: any }, item) => ({ ...acc, [`${item.id}`]: item.geom }),
      {},
    );

    return result;
  }

  @Action({
    rest: 'GET /:id/events/count',
    params: {
      id: ['number|convert', { type: 'array', items: 'number|convert' }],
      mapping: 'boolean|optional',
    },
    timeout: 0,
  })
  async getEventsCount(ctx: Context<{ id: number | number[]; mapping?: boolean }>) {
    const { id, mapping } = ctx.params;
    const ids = Array.isArray(id) ? id : [id];

    await this.resolveEntities(ctx, { id: ids, throwIfNotExist: true });

    const adapter = await this.getAdapter(ctx);

    const knex = adapter.client;

    // Pre-expand each subscription's category selections to leaf ids so the
    // count query honors the categories filter. Subscription.categories may
    // be at any level (1, 2, or 3); events have leaf-level category_ids, so
    // a level-2 selection like 'gyvenamieji' has to fan out to its children.
    // categories.descendants is cached in-memory after first hit, so this is
    // just a handful of map lookups even when called for all subscriptions.
    const subsForExpansion: Array<{ id: number; categories: any }> = await knex('subscriptions')
      .select('id', 'categories')
      .modify((qb: any) => {
        if (ids?.length) qb.whereIn('id', ids);
      });

    const uniqueCategoryIds = new Set<number>();
    const subToCategoryIds = new Map<number, number[]>();
    for (const sub of subsForExpansion) {
      let cats: number[] = [];
      if (typeof sub.categories === 'string') {
        try {
          cats = JSON.parse(sub.categories);
        } catch {
          cats = [];
        }
      } else if (Array.isArray(sub.categories)) {
        cats = sub.categories;
      }
      const numericCats = (cats || []).map(Number).filter(Number.isFinite);
      if (!numericCats.length) continue;
      subToCategoryIds.set(sub.id, numericCats);
      numericCats.forEach((c) => uniqueCategoryIds.add(c));
    }

    const descendantsById = new Map<number, number[]>();
    for (const cid of uniqueCategoryIds) {
      const desc: number[] = await ctx.call('categories.descendants', { id: cid });
      descendantsById.set(cid, desc);
    }

    // Build a per-subscription CASE clause. Permissive matching: events with
    // no category_id (non-statyba apps) pass through regardless, so a sub
    // with apps=[infostatyba, miškai] and a category filter still gets the
    // miškai events. Mirrors applyEventsQueryBySubscriptions.
    const categoryCases: string[] = [];
    for (const [subId, catIds] of subToCategoryIds.entries()) {
      const leafIds = [...new Set(catIds.flatMap((c) => descendantsById.get(c) ?? []))].filter(
        Number.isFinite,
      );
      if (!leafIds.length) continue;
      categoryCases.push(
        `WHEN s.id = ${subId} THEN (e.category_id IS NULL OR e.category_id IN (${leafIds.join(
          ',',
        )}))`,
      );
    }
    const categoryClause = categoryCases.length
      ? `CASE ${categoryCases.join(' ')} ELSE TRUE END`
      : 'TRUE';

    const convertedSubscriptions = knex
      .select(
        'id',
        knex.raw(`
          ST_Transform(
            ST_Multi(
              CASE
                WHEN ST_GeometryType(geom) IN (
                  'ST_Point',
                  'ST_LineString',
                  'ST_MultiPoint',
                  'ST_MultiLineString'
                ) THEN ST_Buffer(geom, geom_buffer_size)
                WHEN ST_GeometryType(geom) IN ('ST_Polygon', 'ST_MultiPolygon') THEN geom
              END
            ),
            3346
          ) :: geometry(multipolygon, 3346) AS geom
        `),
        'apps',
        'frequency',
        'text_filter',
      )
      .from('subscriptions');

    const countBySubscriptionsQuery = knex
      .select(
        's.id',
        knex.raw('count(e.id)::integer as all_time'),
        knex.raw(`
          COUNT(
            CASE
              WHEN e.created_at >= (
                CURRENT_DATE AT TIME ZONE 'UTC' - (
                  SELECT
                    CASE
                      WHEN s.frequency = 'DAY' THEN INTERVAL '1 day'
                      WHEN s.frequency = 'WEEK' THEN INTERVAL '1 week'
                      WHEN s.frequency = 'MONTH' THEN INTERVAL '1 month'
                    END
                )
              ) THEN 1
              ELSE NULL
            END
          )::integer as new
      `),
      )
      .from(convertedSubscriptions.as('s'))
      .leftJoin('events as e', function () {
        this.on(
          knex.raw(`
            ST_Intersects(s.geom, ST_Centroid(e.geom))
        `),
        )
          .andOn(
            knex.raw(`
          CASE
            WHEN jsonb_array_length(s.apps) > 0 THEN e.app_id IN (
              SELECT
                jsonb_array_elements_text(s.apps) :: integer
            )
            ELSE TRUE
          END
          `),
          )
          .andOn(
            knex.raw(`
          CASE
            WHEN s.text_filter IS NOT NULL AND s.text_filter <> '' THEN
              e.name ILIKE '%' || s.text_filter || '%' OR e.body ILIKE '%' || s.text_filter || '%'
            ELSE TRUE
          END
          `),
          )
          .andOn(knex.raw(categoryClause));
      })
      .groupBy('s.id');

    if (ids?.length) {
      convertedSubscriptions.whereIn('id', ids);
    }

    const countBySubscriptions: any[] = await countBySubscriptionsQuery;
    if (mapping) {
      return countBySubscriptions.reduce(
        (acc: GenericObject, item) => ({
          ...acc,
          [item.id]: {
            allTime: item.allTime,
            new: item.new,
          },
        }),
        {},
      );
    }

    if (!Array.isArray(id)) {
      return countBySubscriptions.find((i) => i.id == id);
    }

    return countBySubscriptions;
  }

  @Action({
    rest: 'POST /setActive',
    auth: EndpointType.USER,
    params: {
      ids: { type: 'array', items: 'number|convert', min: 1 },
      active: 'boolean|convert',
    },
  })
  async setActive(ctx: Context<{ ids: number[]; active: boolean }, UserAuthMeta>) {
    const owned: Array<Subscription<null, 'id'>> = await this.findEntities(ctx, {
      query: { id: { $in: ctx.params.ids } },
      fields: ['id'],
    });
    const ownedIds = owned.map((s) => s.id);
    if (!ownedIds.length) return { updated: 0 };

    // Bypass moleculer-db so the eventsCount field setter doesn't nullify
    // the cached count, and the subscriptions.* event doesn't trigger a
    // pointless recalc — `active` doesn't affect counts.
    const adapter = await this.getAdapter(ctx);
    await adapter.client('subscriptions').whereIn('id', ownedIds).update({
      active: ctx.params.active,
      updatedAt: new Date(),
      updatedBy: ctx.meta.user.id,
    });

    // Skipping events also skipped auth's cache invalidation (auth.me caches
    // active-sub count, used to pick landing page). Trigger it explicitly.
    this.broker.broadcast('cache.clean.auth');

    return { updated: ownedIds.length };
  }

  @Action({
    rest: 'POST /removeMany',
    auth: EndpointType.USER,
    params: {
      ids: { type: 'array', items: 'number|convert', min: 1 },
    },
  })
  async removeMany(ctx: Context<{ ids: number[] }, UserAuthMeta>) {
    const owned: Array<Subscription<null, 'id'>> = await this.findEntities(ctx, {
      query: { id: { $in: ctx.params.ids } },
      fields: ['id'],
    });
    await Promise.all(owned.map((s) => this.removeEntity(ctx, { id: s.id })));
    return { removed: owned.length };
  }

  @Method
  cacheEventsCount(ctx: Context, id: Subscription['id'], eventsCount: Subscription['eventsCount']) {
    return this.updateEntity(
      ctx,
      {
        id,
        $set: {
          eventsCount,
        },
      },
      {
        // will set only eventsCount, without modifying updatedBy and other fields
        raw: true,
        // eventsCount - readonly field and modified only there
        permissive: true,
      },
    );
  }

  @Event()
  async 'subscriptions.*'(ctx: Context<EntityChangedParams<Subscription>>) {
    const type = ctx.params.type;
    const subscription = ctx.params.data;
    const id = subscription.id;

    if (!id) return;

    if (subscription.eventsCount) return;

    switch (type) {
      case 'create':
      case 'update':
      case 'replace':
        const eventsCounts = await this.actions.getEventsCount({
          id,
          mapping: true,
        });

        await this.cacheEventsCount(ctx, id, eventsCounts[id]);
        break;
    }
  }

  @Event()
  async 'integrations.sync.finished'(ctx: Context) {
    const allSubscriptions: Array<Subscription<null, 'id'>> = await this.findEntities(ctx, {
      fields: 'id',
    });

    const allIds = allSubscriptions.map((s) => s.id);
    const eventsCounts = await this.actions.getEventsCount({ id: allIds, mapping: true });

    for (const id in eventsCounts) {
      await this.cacheEventsCount(ctx, Number(id), eventsCounts[id]);
    }
  }

  @Method
  async validateApps({ ctx, value, entity }: FieldHookCallback) {
    const apps: App[] = await ctx.call('apps.find', {
      query: {
        id: { $in: value },
      },
    });
    const ids = apps.map((app: App) => app.id);
    const diff = value.filter((id: number) => !ids.includes(id));
    if (apps.length !== value.length) {
      return `Invalid app ids [${diff.toString()}]`;
    }
    return true;
  }

  @Method
  async validateCategories({ ctx, value }: FieldHookCallback) {
    if (!value?.length) return true;
    const cats: Category[] = await ctx.call('categories.find', {
      query: { id: { $in: value } },
    });
    const ids = cats.map((c) => c.id);
    const diff = value.filter((id: number) => !ids.includes(id));
    if (cats.length !== value.length) {
      return `Invalid category ids [${diff.toString()}]`;
    }
    return true;
  }

  @Method
  async beforeRemove(ctx: Context<{ id: number }, UserAuthMeta>) {
    const subscription = await this.findEntity(ctx, { id: ctx.params.id });
    if (subscription?.user !== ctx.meta.user.id) {
      throwNoRightsError();
    }
  }

  async started() {
    const subscriptionsWithoutCache: Array<Subscription<null, 'id'>> = await this.findEntities(
      null,
      {
        query: {
          eventsCount: {
            $exists: false,
          },
        },
        fields: ['id'],
      },
    );

    if (!subscriptionsWithoutCache.length) return;

    const allIds = subscriptionsWithoutCache.map((s) => s.id);
    const eventsCounts = await this.actions.getEventsCount({ id: allIds, mapping: true });

    for (const id in eventsCounts) {
      await this.cacheEventsCount(null, Number(id), eventsCounts[id]);
    }
  }
}
