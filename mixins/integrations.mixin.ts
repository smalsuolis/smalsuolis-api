import { differenceInDays, formatDuration, intervalToDuration } from 'date-fns';
import { Context } from 'moleculer';
import { App, APP_TYPE } from '../services/apps.service';
import { Event } from '../services/events.service';
import { Tag } from '../services/tags.service';
import { Category } from '../services/categories.service';
import { DBPagination } from '../types';
import { classify } from '../utils/classifiers';
import { externalIdPrefixClause } from '../utils/externalIdPrefix';

// Cached at module level so all integration services share the same lookup —
// categories are seed-only (rest:null) so this never needs invalidation.
const categoryIdByAppType = new Map<string, Map<string, number>>();

async function loadCategoryIdMap(ctx: Context, appType: string): Promise<Map<string, number>> {
  let map = categoryIdByAppType.get(appType);
  if (map) return map;
  const rows: Category[] = await ctx.call('categories.find', {
    query: { appType },
    fields: ['id', 'code'],
    scope: false,
  });
  map = new Map(rows.map((r) => [r.code, r.id]));
  categoryIdByAppType.set(appType, map);
  return map;
}

async function stampCategory(ctx: Context, app: App, event: Partial<Event>) {
  if (event.category) return; // caller pre-set it; respect that
  const appType = APP_TYPE[app.key];
  if (!appType) return;
  const code = classify(appType, { name: event.name, body: event.body });
  if (!code) return; // no classifier registered for this appType
  const idMap = await loadCategoryIdMap(ctx, appType);
  const id = idMap.get(code);
  if (id) event.category = id;
}

export type IntegrationStats = {
  total: number;
  valid: {
    total: number;
    inserted: number;
    updated: number;
  };
  invalid: {
    total: number;
  };
  startTime?: Date;
  endDate?: Date;
  duration?: String;
};

export function IntegrationsMixin() {
  const schema = {
    actions: {
      sync: {
        rest: 'POST /sync',
        timeout: 0,
        handler(ctx: Context) {
          ctx.call(`${this.name}.getData`);
          return {
            success: true,
          };
        },
      },
    },
    methods: {
      async makeRequestWithRetries(request: Function, retryCount: number = 1) {
        async function staleFor(seconds: number) {
          return new Promise((resolve) => {
            setTimeout(resolve, 1000 * seconds);
          });
        }

        let keepTrying = true;
        let tries = 0;
        let response;
        do {
          tries++;
          try {
            response = await request({ retryCount, tries });
            keepTrying = false;
          } catch (err) {
            await staleFor(tries);
            keepTrying = true;
          }
        } while (tries < retryCount && keepTrying);

        if (!response) throw Error('No response');
        return response;
      },
      calcProgression(count: number, total: number, startTime: Date) {
        const currentTime = new Date();
        const percentage = Math.round((count / total) * 10000) / 100;

        const estimatedEndTime = new Date(
          (currentTime.getTime() - startTime.getTime()) / (percentage / 100) + startTime.getTime(),
        );
        const duration = formatDuration(intervalToDuration({ start: startTime, end: currentTime }));
        const estimatedDuration = formatDuration(
          intervalToDuration({ start: startTime, end: estimatedEndTime }),
        );
        return {
          count,
          total,
          percentage,
          duration,
          estimatedDuration,
          text: `${count} of ${total} (${percentage}%) - ${duration} (est. ${estimatedDuration})`,
        };
      },
      async createOrUpdateEvent(
        ctx: Context,
        app: App,
        event: Partial<Event>,
        initial: boolean = false,
      ) {
        this.addTotal();

        if (!event.externalId) {
          this.addInvalid();
          return;
        }

        // Per-record fault tolerance: a transient ctx.call timeout on one
        // record (broker queue overload, slow downstream, etc.) used to throw
        // out of the integration's loop and kill the whole nightly sync. That
        // left lastRunError stuck for days even though the next run usually
        // works. Now we swallow the per-record error, log it, count it as
        // invalid, and keep going so the sync as a whole can complete.
        // Bumped timeout to 60s so the 10s default doesn't bite under load.
        try {
          await stampCategory(ctx, app, event);

          const existingEvent: Event = await ctx.call(
            'events.findOne',
            {
              query: {
                externalId: event.externalId,
                app: app.id,
              },
            },
            { timeout: 60_000 },
          );

          // Let's save old events (older than 30 days) as initial events
          // Don't set createdAt in the future though
          initial = initial || differenceInDays(new Date(), event.startAt) > 30;

          if (initial) {
            if (event.startAt && event.startAt <= new Date()) {
              event.createdAt = event.startAt;
            } else {
              event.createdAt = new Date();
            }
          } else if (!existingEvent?.id) {
            event.createdAt = new Date();
          }

          this.validExternalIds.add(event.externalId);

          if (existingEvent?.id) {
            await ctx.call(
              'events.update',
              { id: Number(existingEvent.id), ...event },
              { timeout: 60_000 },
            );
            this.stats.valid.updated++;
            this.stats.valid.total++;
          } else {
            await ctx.call('events.create', event, { timeout: 60_000 });
            this.stats.valid.inserted++;
            this.stats.valid.total++;
          }
        } catch (err: any) {
          this.broker.logger.error(
            `[${this.name}] createOrUpdateEvent failed for externalId=${event.externalId}: ${
              err?.message ?? err
            }`,
          );
          this.addInvalid();
          // Mark valid so cleanupInvalidEvents doesn't soft-delete the existing
          // row just because we momentarily couldn't update it.
          if (event.externalId) this.validExternalIds.add(event.externalId);
        }
      },

      async createOrUpdateEvents(
        ctx: Context,
        apps: App | App[],
        events: Partial<Event>[],
        initial: boolean = false,
      ) {
        if (!Array.isArray(apps)) {
          apps = [apps];
        }

        this.addTotal(events.length);

        const externalIds = events.map((e) => e.externalId).filter((id) => id);
        const existingEventsMap: { [key: string]: Event } = await ctx.call('events.find', {
          mapping: 'externalId',
          query: {
            externalId: { $in: externalIds },
            app: { $in: apps.map((a) => a.id) },
          },
        });

        for (const event of events) {
          if (!event.externalId) {
            this.addInvalid();
            continue;
          }

          // Per-record fault tolerance — see createOrUpdateEvent above.
          try {
            // Resolved one event at a time; the loadCategoryIdMap call inside
            // is cached after first hit per appType so this stays cheap.
            const eventApp = apps.find((a) => a.id === event.app) ?? apps[0];
            await stampCategory(ctx, eventApp, event);

            // Let's save old events (older than 30 days) as initial events
            initial = initial || differenceInDays(new Date(), event.startAt) > 30;
            if (initial) {
              if (event.startAt && event.startAt <= new Date()) {
                event.createdAt = event.startAt;
              } else {
                event.createdAt = new Date();
              }
            } else if (!existingEventsMap[event.externalId]) {
              event.createdAt = new Date();
            }

            this.validExternalIds.add(event.externalId);

            const existingEvent = existingEventsMap[event.externalId];

            if (existingEvent?.id) {
              await ctx.call(
                'events.update',
                { id: Number(existingEvent.id), ...event },
                { timeout: 60_000 },
              );
              this.stats.valid.updated++;
              this.stats.valid.total++;
            } else {
              await ctx.call('events.create', event, { timeout: 60_000 });
              this.stats.valid.inserted++;
              this.stats.valid.total++;
            }
          } catch (err: any) {
            this.broker.logger.error(
              `[${this.name}] createOrUpdateEvents failed for externalId=${event.externalId}: ${
                err?.message ?? err
              }`,
            );
            this.addInvalid();
            if (event.externalId) this.validExternalIds.add(event.externalId);
          }
        }
      },

      /**
       * Soft-delete the app's events that this run did not re-confirm.
       *
       * `externalIdPrefix` narrows that to one source's own events. Several
       * integrations now feed a single app — the land-use notices arrive from
       * the central portal and from individual municipality sites — and each
       * only knows the ids it collected itself. Without the prefix, whichever
       * ran last would delete every event the others had just written.
       */
      async cleanupInvalidEvents(ctx: Context, apps: App | App[], externalIdPrefix?: string) {
        if (!Array.isArray(apps)) {
          apps = [apps];
        }

        const validExternalIds = this.validExternalIds || new Set();
        const query: any = {
          app: { $in: apps.map((a) => a.id) },
        };
        if (externalIdPrefix) {
          // $raw, not $like: the knex adapter implements only
          // $eq/$ne/$in/$nin/$gt/$gte/$lt/$lte/$exists/$raw, and an unknown
          // operator is not rejected — it is treated as a literal value, so a
          // $like here would match nothing and quietly delete the lot.
          query.$raw = externalIdPrefixClause(externalIdPrefix);
        }

        const totalCount: number = await ctx.call('events.count', { query, scope: false });
        this.stats.invalid.removed = 0;
        const startTime = new Date();

        const fields = ['id', 'deletedAt', 'externalId'];

        const pageSize = 5000;

        for (let page = 1; page <= Math.ceil(totalCount / pageSize); page++) {
          const eventsPage: DBPagination<Event<null, 'id' | 'deletedAt' | 'externalId'>> =
            await ctx.call('events.list', {
              query,
              pageSize,
              page,
              fields,
              sort: 'id',
              scope: false, // needed for not skipping any events
            });

          if (!eventsPage.rows.length) {
            continue;
          }

          const invalidEventsIds = eventsPage.rows
            .filter(
              (item) => !validExternalIds.has(item.externalId) && !item.deletedAt && !!item.id,
            )
            .map((e) => e.id);

          const invalidEventsCount = invalidEventsIds?.length || 0;

          if (invalidEventsCount) {
            await ctx.call('events.removeMany', { id: invalidEventsIds });
            this.addTotal(invalidEventsCount);
            this.addInvalid(invalidEventsCount);
            this.stats.invalid.removed += invalidEventsCount;
          }

          const progress = this.calcProgression(page * pageSize, totalCount, startTime);
          this.broker.logger.info(`${this.name} removing in progress: ${progress.text}`);
        }
      },
      addTotal(count: number = 1) {
        this.stats.total += count;
      },
      addInvalid(count: number = 1) {
        this.stats.invalid.total += count;
      },
      startIntegration(): IntegrationStats {
        this.validExternalIds = new Set();
        this.stats = {
          total: 0,
          valid: {
            total: 0,
            inserted: 0,
            updated: 0,
          },
          invalid: {
            total: 0,
          },
          startTime: new Date(),
        };
        return this.stats;
      },
      finishIntegration(): IntegrationStats {
        this.broker.emit('integrations.sync.finished');
        this.stats.endTime = new Date();
        this.stats.duration = formatDuration(
          intervalToDuration({ start: this.stats.startTime, end: this.stats.endTime }),
        );

        this.broker.logger.info(`${this.name} sync finish`, this.stats);

        return this.stats;
      },
      /**
       * Persist a successful integration run timestamp to every app row
       * involved, and clear any previously-recorded error. Call at the end
       * of a successful getData() in each integration service.
       */
      async recordRunSuccess(ctx: Context, apps: App[] | App) {
        const list = Array.isArray(apps) ? apps : [apps];
        const durationMs = this.stats?.startTime
          ? Date.now() - new Date(this.stats.startTime).getTime()
          : null;
        for (const app of list) {
          if (!app?.id) continue;
          try {
            // Long timeout so this bookkeeping write doesn't fall victim to
            // the same broker-overload-after-heavy-sync that this method is
            // supposed to record. Default 10s used to silently fail under
            // load, leaving lastRunError stuck for days (memory's known bug).
            await ctx.call(
              'apps.update',
              {
                id: app.id,
                lastRunAt: new Date(),
                lastRunError: null,
                lastRunDurationMs: durationMs,
              },
              { timeout: 60_000 },
            );
          } catch (err: any) {
            this.broker.logger.error(
              `recordRunSuccess failed for app ${app.id}: ${err?.message ?? err}`,
            );
          }
        }
      },
      /**
       * Persist a failed integration run to every app row involved so the
       * watchdog (and stats page) can surface the error immediately — no
       * waiting on staleness. Truncated to avoid huge stacks in the DB.
       */
      async recordRunFailure(ctx: Context, apps: App[] | App, error: any) {
        const list = Array.isArray(apps) ? apps : [apps];
        const message = (error?.message ?? String(error ?? 'unknown error')).slice(0, 500);
        const durationMs = this.stats?.startTime
          ? Date.now() - new Date(this.stats.startTime).getTime()
          : null;
        this.broker.logger.error(
          `${this.name} run failed for ${list.map((a) => a.key).join(', ')}: ${message}`,
        );
        for (const app of list) {
          if (!app?.id) continue;
          try {
            // See recordRunSuccess — same broker-overload concern. Long
            // timeout so the failure ALWAYS gets recorded, even when the
            // broker is the thing that flaked.
            await ctx.call(
              'apps.update',
              {
                id: app.id,
                lastRunAt: new Date(),
                lastRunError: message,
                lastRunDurationMs: durationMs,
              },
              { timeout: 60_000 },
            );
          } catch (err: any) {
            this.broker.logger.error(
              `recordRunFailure failed for app ${app.id}: ${err?.message ?? err}`,
            );
          }
        }
      },
      async findOrCreateTags(ctx: Context, names: string[], appKey: string) {
        this.tags = this.tags || {};

        const appType = APP_TYPE[appKey];

        if (!Object.keys(this.tags).length) {
          this.tags = await ctx.call('tags.find', {
            query: { appType },
            mapping: 'name',
          });
        }

        const tagsIds: number[] = [];

        names = names.filter((n) => !!n);

        if (!names.length) return tagsIds;

        for (const name of names) {
          if (!this.tags[name]) {
            const tag: Tag = await ctx.call('tags.create', {
              appType,
              name,
            });

            this.tags[name] = tag;
          }

          if (this.tags[name]) {
            tagsIds.push(this.tags[name].id);
          }
        }

        return tagsIds;
      },
    },
  };

  return schema;
}
