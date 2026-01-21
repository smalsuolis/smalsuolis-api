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
}

interface AppTypeStats {
  appType: string;
  lastUpdate: Date | null;
  eventCount: number;
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

    const apps: LastUpdateInfo[] = appsLastUpdate.map((row: any) => ({
      app: row.app,
      appId: row.appId,
      appKey: row.appKey,
      appType: APP_TYPE[row.appKey] || 'unknown',
      lastUpdate: row.lastUpdate ? new Date(row.lastUpdate) : null,
      eventCount: parseInt(row.eventCount, 10),
    }));

    // Group by app type and calculate stats
    const appTypeMap = new Map<string, AppTypeStats>();

    apps.forEach((app) => {
      if (!appTypeMap.has(app.appType)) {
        appTypeMap.set(app.appType, {
          appType: app.appType,
          lastUpdate: null,
          eventCount: 0,
          apps: [],
        });
      }

      const typeStats = appTypeMap.get(app.appType)!;
      typeStats.apps.push(app);
      typeStats.eventCount += app.eventCount;

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
