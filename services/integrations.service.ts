'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { EndpointType } from '../types';
import DbConnection from '../mixins/database.mixin';
import { APP_TYPE } from './apps.service';

interface LastUpdateInfo {
  app: string;
  appId: number;
  appKey: string;
  appType: string;
  lastUpdate: Date | null;
  eventCount: number;
  lastUpdateCount: number;
}

interface AppTypeStats {
  appType: string;
  lastUpdate: Date | null;
  eventCount: number;
  lastUpdateCount: number;
  apps: LastUpdateInfo[];
}

interface IntegrationsStats {
  lastGlobalUpdate: Date | null;
  byAppType: AppTypeStats[];
  apps: LastUpdateInfo[];
}

@Service({
  name: 'integrations',
  mixins: [
    DbConnection({
      collection: 'events',
    }),
  ],
})
export default class IntegrationsService extends moleculer.Service {
  @Action({
    rest: {
      method: 'GET',
      path: '/last-update',
    },
    auth: EndpointType.PUBLIC,
  })
  async getLastUpdate(ctx: Context): Promise<IntegrationsStats> {
    const adapter = await this.getAdapter(ctx);
    const knex = adapter.client;

    // Get last update time per app
    const appsLastUpdate = await knex
      .select('apps.id as appId', 'apps.name as app', 'apps.key as appKey')
      .max('events.createdAt as lastUpdate')
      .count('events.id as eventCount')
      .from('apps')
      .leftJoin('events', function () {
        this.on('events.appId', '=', 'apps.id').andOn(knex.raw('events.deleted_at IS NULL'));
      })
      .groupBy('apps.id', 'apps.name', 'apps.key')
      .orderBy('lastUpdate', 'desc');

    // Get the most recent update across all apps
    const globalLastUpdate = await knex
      .select(knex.raw('MAX(created_at) as last_update'))
      .from('events')
      .whereNull('deletedAt')
      .first();

    // Get count of events added in the last update batch (events on same date as the latest update per app)
    let lastUpdateCountMap = new Map<number, number>();
    try {
      const lastUpdateCountResult = await knex.raw(`
        WITH last_updates AS (
          SELECT app_id, MAX(created_at) as last_update_time
          FROM events
          WHERE deleted_at IS NULL
          GROUP BY app_id
        )
        SELECT e.app_id as "appId", COUNT(e.id) as count
        FROM events e
        JOIN last_updates lu ON e.app_id = lu.app_id AND DATE(e.created_at) = DATE(lu.last_update_time)
        WHERE e.deleted_at IS NULL
        GROUP BY e.app_id
      `);
      const rows = lastUpdateCountResult?.rows || lastUpdateCountResult || [];
      lastUpdateCountMap = new Map<number, number>(
        rows.map((r: any) => [Number(r.appId ?? r.app_id), parseInt(r.count, 10)]),
      );
    } catch (_e) {
      // non-critical, fall back to zero counts
    }

    const apps: LastUpdateInfo[] = appsLastUpdate.map((row: any) => ({
      app: row.app,
      appId: row.appId,
      appKey: row.appKey,
      appType: APP_TYPE[row.appKey] || 'unknown',
      lastUpdate: row.lastUpdate ? new Date(row.lastUpdate) : null,
      eventCount: parseInt(row.eventCount, 10),
      lastUpdateCount: lastUpdateCountMap.get(row.appId) || 0,
    }));

    // Group by app type and calculate stats
    const appTypeMap = new Map<string, AppTypeStats>();

    apps.forEach((app) => {
      if (!appTypeMap.has(app.appType)) {
        appTypeMap.set(app.appType, {
          appType: app.appType,
          lastUpdate: null,
          eventCount: 0,
          lastUpdateCount: 0,
          apps: [],
        });
      }

      const typeStats = appTypeMap.get(app.appType)!;
      typeStats.apps.push(app);
      typeStats.eventCount += app.eventCount;
      typeStats.lastUpdateCount += app.lastUpdateCount;

      // Update lastUpdate to the most recent one
      if (app.lastUpdate && (!typeStats.lastUpdate || app.lastUpdate > typeStats.lastUpdate)) {
        typeStats.lastUpdate = app.lastUpdate;
      }
    });

    const byAppType = Array.from(appTypeMap.values()).sort((a, b) => {
      if (!a.lastUpdate) return 1;
      if (!b.lastUpdate) return -1;
      return b.lastUpdate.getTime() - a.lastUpdate.getTime();
    });

    return {
      lastGlobalUpdate: globalLastUpdate?.last_update
        ? new Date(globalLastUpdate.last_update)
        : null,
      byAppType,
      apps,
    };
  }
}
