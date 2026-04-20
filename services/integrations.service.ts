'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Event, Service } from 'moleculer-decorators';
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
  firstGlobalEvent: Date | null;
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
  private cachedStats: IntegrationsStats | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  @Action({
    rest: {
      method: 'GET',
      path: '/last-update',
    },
    auth: EndpointType.PUBLIC,
  })
  async getLastUpdate(ctx: Context<{ noCache?: boolean }>): Promise<IntegrationsStats> {
    if (this.cachedStats && Date.now() < this.cacheExpiry && !ctx.params.noCache) {
      return this.cachedStats;
    }

    const adapter = await this.getAdapter(ctx);
    const knex = adapter.client;

    // Use updatedAt (not createdAt) for "last sync" reporting. createdAt is
    // intentionally set to the event's real-world startAt for old/initial
    // imports (so the email digest doesn't resurface historical events); that
    // makes createdAt useless as a "when did this integration last run" signal.
    // updatedAt is auto-set by the DB mixin on every insert/update, so it
    // reflects the actual last time events for this app were touched.
    const appsLastUpdate = await knex
      .select('apps.id as appId', 'apps.name as app', 'apps.key as appKey')
      .max('events.updatedAt as lastUpdate')
      .count('events.id as eventCount')
      .from('apps')
      .leftJoin('events', function () {
        this.on('events.appId', '=', 'apps.id').andOn(knex.raw('events.deleted_at IS NULL'));
      })
      .groupBy('apps.id', 'apps.name', 'apps.key')
      .orderBy('lastUpdate', 'desc');

    // Get the most recent and earliest event across all apps
    const globalLastUpdate = await knex
      .select(knex.raw('MAX(updated_at) as last_update, MIN(start_at) as first_event'))
      .from('events')
      .whereNull('deletedAt')
      .first();

    // Get count of events touched in the last sync (events on same date as the latest updatedAt per app)
    let lastUpdateCountMap = new Map<number, number>();
    try {
      const lastUpdateCountResult = await knex.raw(`
        WITH last_updates AS (
          SELECT app_id, MAX(updated_at) as last_update_time
          FROM events
          WHERE deleted_at IS NULL
          GROUP BY app_id
        )
        SELECT e.app_id as "appId", COUNT(e.id) as count
        FROM events e
        JOIN last_updates lu ON e.app_id = lu.app_id AND DATE(e.updated_at) = DATE(lu.last_update_time)
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

    const result: IntegrationsStats = {
      lastGlobalUpdate: globalLastUpdate?.last_update
        ? new Date(globalLastUpdate.last_update)
        : null,
      firstGlobalEvent: globalLastUpdate?.first_event
        ? new Date(globalLastUpdate.first_event)
        : null,
      byAppType,
      apps,
    };

    this.cachedStats = result;
    this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;

    return result;
  }

  // Auto-invalidate the 6h cache whenever any integration finishes a sync so
  // the stats page shows fresh data without users having to wait out the TTL.
  @Event({ name: 'integrations.sync.finished' })
  onIntegrationsSyncFinished() {
    this.cachedStats = null;
    this.cacheExpiry = 0;
  }
}
