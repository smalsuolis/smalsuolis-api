'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
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
        };
      };
    } = {
      byApp: {},
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

  @Method
  async applyFilters(ctx: Context<any, UserAuthMeta>) {
    ctx.params.query = parseToJsonIfNeeded(ctx.params.query) || {};

    if (ctx.params.query.subscription) {
      const subscriptions: Subscription[] = await ctx.call('subscriptions.find', {
        query: { id: ctx.params.query.subscription },
        populate: 'geomWithBuffer',
      });
      ctx.params.query = applyEventsQueryBySubscriptions(ctx.params.query, subscriptions);
      delete ctx.params.query.subscription;
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
}
