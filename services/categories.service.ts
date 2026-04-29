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
import { APP_TYPE, App } from './apps.service';
import { classify, getRegisteredSpecs } from '../utils/classifiers';

interface Fields extends CommonFields {
  code: string;
  name: string;
  parent: number | null;
  appType: string;
  sort: number;
  hidden: boolean;
}

interface Populates extends CommonPopulates {
  parent: Category;
}

export type Category<
  P extends keyof Populates = never,
  F extends keyof (Fields & Populates) = keyof Fields,
> = Table<Fields, Populates, P, F>;

@Service({
  name: 'categories',
  mixins: [
    DbConnection({
      collection: 'categories',
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
      parent: {
        type: 'number',
        columnType: 'integer',
        columnName: 'parentId',
        populate: 'categories.resolve',
      },
      appType: 'string|required',
      sort: {
        type: 'number',
        columnType: 'integer',
        default: 0,
      },
      hidden: {
        type: 'boolean',
        default: false,
      },
      ...COMMON_FIELDS,
    },
    scopes: {
      ...COMMON_SCOPES,
    },
    defaultScopes: [...COMMON_DEFAULT_SCOPES],
  },
  actions: {
    list: { auth: EndpointType.PUBLIC },
    get: { auth: EndpointType.PUBLIC },
    find: { auth: EndpointType.PUBLIC },
    count: { auth: EndpointType.PUBLIC },
    resolve: { auth: EndpointType.PUBLIC },
    // Categories are seeded from the classifier registry. Runtime CRUD is
    // intentionally disabled — schema lives in code, not in a UI.
    create: { rest: null },
    update: { rest: null },
    remove: { rest: null },
  },
})
export default class CategoriesService extends moleculer.Service {
  private backfillRunning = false;

  // Re-classifies existing events in bulk. Internal action — no `rest:` so it
  // can't be triggered by HTTP. Concurrency-locked. Use after seeding categories
  // for the initial population, or after tweaking classifier rules.
  @Action({
    timeout: 0,
    params: {
      pageSize: { type: 'number', optional: true, default: 5000 },
      appType: { type: 'string', optional: true },
    },
  })
  async backfill(ctx: Context<{ pageSize: number; appType?: string }>) {
    if (this.backfillRunning) {
      throw new Error('categories.backfill is already running');
    }
    this.backfillRunning = true;
    try {
      return await this.runBackfill(ctx);
    } finally {
      this.backfillRunning = false;
    }
  }

  private async runBackfill(ctx: Context<{ pageSize: number; appType?: string }>) {
    const { pageSize, appType: filterAppType } = ctx.params;

    // Knex client is connection-scoped, so the categories adapter can query
    // the events table just fine.
    const adapter = await (this as any).getAdapter(ctx);
    const knex: Knex = adapter.client;

    const categories: { id: number; code: string; appType: string }[] = await ctx.call(
      'categories.find',
      { fields: ['id', 'code', 'appType'], scope: false },
    );
    const idByAppTypeCode = new Map<string, Map<string, number>>();
    for (const c of categories) {
      if (!idByAppTypeCode.has(c.appType)) idByAppTypeCode.set(c.appType, new Map());
      idByAppTypeCode.get(c.appType)!.set(c.code, c.id);
    }

    const apps: App[] = await ctx.call('apps.find', { scope: false });
    const appTypeByAppId = new Map<number, string>();
    for (const a of apps) {
      const t = APP_TYPE[a.key];
      if (t) appTypeByAppId.set(a.id, t);
    }

    const wantedAppTypes = new Set(getRegisteredSpecs().map((s) => s.appType));
    if (filterAppType) {
      if (!wantedAppTypes.has(filterAppType)) {
        throw new Error(`No classifier registered for appType=${filterAppType}`);
      }
      wantedAppTypes.clear();
      wantedAppTypes.add(filterAppType);
    }
    const targetAppIds = apps.filter((a) => wantedAppTypes.has(APP_TYPE[a.key])).map((a) => a.id);
    if (!targetAppIds.length) {
      return { processed: 0, updated: 0, skipped: 0 };
    }

    let lastId = 0;
    let processed = 0;
    let updated = 0;
    let skipped = 0;

    while (true) {
      const rows: { id: number; name: string | null; body: string | null; appId: number }[] =
        await knex('events')
          .select('id', 'name', 'body', 'appId')
          .whereIn('appId', targetAppIds)
          .andWhere('id', '>', lastId)
          .whereNull('deletedAt')
          .orderBy('id', 'asc')
          .limit(pageSize);

      if (!rows.length) break;

      const updates: [number, number][] = [];
      for (const row of rows) {
        processed++;
        const appType = appTypeByAppId.get(row.appId);
        if (!appType) {
          skipped++;
          continue;
        }
        const code = classify(appType, { name: row.name, body: row.body });
        if (!code) {
          skipped++;
          continue;
        }
        const catId = idByAppTypeCode.get(appType)?.get(code);
        if (!catId) {
          // Classifier returned a code that isn't seeded — bug in spec/seed sync.
          this.logger.warn(
            `categories.backfill: ${appType}/${code} not in DB (event id=${row.id})`,
          );
          skipped++;
          continue;
        }
        updates.push([row.id, catId]);
      }

      if (updates.length) {
        // UPDATE events SET category_id = v.cat FROM (VALUES ...) v(id, cat) WHERE events.id = v.id
        const valuesSql = updates.map(() => '(?::int, ?::int)').join(', ');
        const bindings = updates.flat();
        await knex.raw(
          `UPDATE events SET category_id = v.cat
             FROM (VALUES ${valuesSql}) AS v(id, cat)
             WHERE events.id = v.id`,
          bindings,
        );
        updated += updates.length;
      }

      lastId = rows[rows.length - 1].id;
      this.logger.info(
        `categories.backfill: processed=${processed} updated=${updated} skipped=${skipped} lastId=${lastId}`,
      );

      if (rows.length < pageSize) break;
    }

    return { processed, updated, skipped };
  }
}
