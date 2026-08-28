'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
// @ts-ignore
import Cron from '@r2d2bzh/moleculer-cron';

import { App, APP_KEYS } from './apps.service';
import { Event, toEventBodyMarkdown } from './events.service';
import { IntegrationsMixin } from '../mixins/integrations.mixin';
import { buildGeometry, resolveParcels } from '../utils/savivaldybeZemetvarka/parcels';
import { ParcelIds } from '../utils/savivaldybeZemetvarka/cadastral';
import {
  MunicipalityRunStats,
  SourceRecord,
  fetchPortalRecords,
  findParserGaps,
} from '../utils/savivaldybeZemetvarka/sources';
import {
  fetchMunicipalSource,
  municipalCleanupPrefix,
} from '../utils/savivaldybeZemetvarka/municipal';
import {
  MUNICIPAL_SOURCES,
  MUNICIPAL_SOURCE_SLUGS,
} from '../utils/savivaldybeZemetvarka/municipalSources';
import { assertNotBlocked } from '../utils/savivaldybeZemetvarka/blocked';

/**
 * Land-use-change notices from every municipality.
 *
 * One app, one integration, several sources. The central portal
 * (planuojustatau.lt) carries 59 of the 60 municipalities; the rest are read
 * from municipality sites, either because the portal never received their
 * notices (Rietavas), because they stopped sending them (Alytaus r.), or
 * because the portal's copy drops the parcel number the notice is identified by
 * (Klaipėdos m.).
 *
 * Sources are namespaced by externalId prefix so each is cleaned up
 * independently — a source that fails must not take another's events with it.
 */

const PORTAL_PREFIX = 'portal:';

const REQUEST_TIMEOUT_MS = 120_000;

@Service({
  name: 'integrations.savivaldybeZemetvarka',
  mixins: [Cron, IntegrationsMixin()],
  crons: [
    {
      name: 'integrationsSavivaldybeZemetvarka',
      cronTime: '0 5 * * *',
      timeZone: 'Europe/Vilnius',
      async onTick() {
        await this.call('integrations.savivaldybeZemetvarka.getData');
      },
    },
  ],
})
export default class IntegrationsSavivaldybeZemetvarkaService extends moleculer.Service {
  @Action({
    timeout: 0,
    params: {
      initial: { type: 'boolean', optional: true, default: false },
    },
  })
  async getData(ctx: Context<{ initial: boolean }>) {
    this.startIntegration();

    const app: App = await ctx.call('apps.findOne', {
      query: { key: APP_KEYS.savivaldybesZemetvarka },
    });
    if (!app?.id) {
      this.finishIntegration();
      throw new Error(`no app row for key ${APP_KEYS.savivaldybesZemetvarka} — refusing to run`);
    }

    try {
      // The portal is the base. Municipalities it fails are read from their own
      // site instead, and skipped here so the same notice is not collected
      // twice under two ids.
      const { records, stats } = await fetchPortalRecords((url) => this.fetchHtml(ctx, url), {
        skipSlugs: MUNICIPAL_SOURCE_SLUGS,
        onProgress: (line) => this.broker.logger.info(`[${this.name}] ${line}`),
      });

      // A run that collected nothing is a broken run, not an empty country.
      // Proceeding to cleanup here would soft-delete every portal event.
      if (!records.length) {
        throw new Error('portal returned 0 records — aborting to preserve existing events');
      }

      this.reportRunQuality(stats);
      await this.writeEvents(ctx, app, records, PORTAL_PREFIX, ctx.params.initial);

      await this.runMunicipalSources(ctx, app, ctx.params.initial);

      await this.recordRunSuccess(ctx, app);
      return this.finishIntegration();
    } catch (err: any) {
      await this.recordRunFailure(ctx, app, err);
      return this.finishIntegration();
    }
  }

  /**
   * Say which of the three silences each municipality is in.
   *
   * "Nothing new" means the municipality has no requests, or it moved
   * elsewhere, or the parser stopped seeing what is there. Only the third is a
   * bug, and without this it looks exactly like the first.
   */
  @Method
  reportRunQuality(stats: MunicipalityRunStats[]) {
    const gaps = findParserGaps(stats);
    if (gaps.length) {
      this.broker.logger.warn(
        `[${this.name}] ${gaps.length} municipalities publish dates we produced no record for: ` +
          gaps
            .map(
              (g) => `${g.slug}(page=${g.newestDateOnPage} parsed=${g.newestRecordDate ?? 'none'})`,
            )
            .join(', '),
      );
    }

    const failed = stats.filter((s) => s.error);
    if (failed.length) {
      this.broker.logger.warn(
        `[${this.name}] ${failed.length} municipalities failed: ${failed
          .map((s) => `${s.slug} (${s.error})`)
          .join(', ')}`,
      );
    }
  }

  /**
   * Read each municipality that the portal does not serve.
   *
   * Each is written and cleaned up on its own: one refusing site must not cost
   * another its events, nor abort the portal's work that already succeeded.
   */
  @Method
  async runMunicipalSources(ctx: Context, app: App, initial: boolean) {
    for (const source of MUNICIPAL_SOURCES) {
      try {
        const { records, stats } = await fetchMunicipalSource(source, (url) =>
          this.fetchHtml(ctx, url),
        );
        const stat = stats[0];
        if (stat?.error) {
          // Reported, not thrown: a partial read still carries real notices,
          // and the count is what makes the shortfall visible.
          this.broker.logger.warn(`[${this.name}] ${source.slug}: ${stat.error}`);
        }
        this.broker.logger.info(
          `[${this.name}] ${source.slug}: records=${records.length} newest=${
            stat?.newestRecordDate ?? 'none'
          }`,
        );

        // Nothing collected means the site was not observed, not that the
        // municipality fell silent — cleaning up on that would delete the lot.
        if (!records.length) {
          this.broker.logger.warn(`[${this.name}] ${source.slug}: 0 records — skipping cleanup`);
          continue;
        }

        await this.writeEvents(ctx, app, records, municipalCleanupPrefix(source.slug), initial);
      } catch (err: any) {
        this.broker.logger.error(
          `[${this.name}] ${source.slug} failed: ${err?.message ?? err} — other sources continue`,
        );
      }
    }
  }

  /** Turn one source's records into events, then retire what it no longer lists. */
  @Method
  async writeEvents(
    ctx: Context,
    app: App,
    records: SourceRecord[],
    cleanupPrefix: string,
    initial: boolean,
  ) {
    const events = await this.toEvents(ctx, app, this.dedupe(records));
    await this.createOrUpdateEvents(ctx, app, events, initial);
    await this.cleanupInvalidEvents(ctx, app, cleanupPrefix);
  }

  @Method
  async fetchHtml(ctx: Context, url: string): Promise<string> {
    const html: string = await ctx.call(
      'http.get',
      { url, opt: { responseType: 'text' } },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    return assertNotBlocked(html, url);
  }

  /**
   * Collapse records describing the same notice.
   *
   * Vilnius is read twice — by the portal and by its own integration — and the
   * same parcels published on the same day are one notice, not two. The record
   * carrying a comment deadline wins, since that is the field a reader can act
   * on and only the municipality's own page states it.
   */
  @Method
  dedupe(records: SourceRecord[]): SourceRecord[] {
    const byNotice = new Map<string, SourceRecord>();
    for (const record of records) {
      const parcels = [...record.parcels.cadastrals, ...record.parcels.uniqueNumbers].join(',');
      const key = `${parcels}|${record.publishedAt ?? ''}|${record.kind}`;
      const existing = byNotice.get(key);
      if (!existing || (!existing.deadlineAt && record.deadlineAt)) {
        byNotice.set(key, record);
      }
    }
    return [...byNotice.values()];
  }

  @Method
  async toEvents(ctx: Context, app: App, records: SourceRecord[]): Promise<Partial<Event>[]> {
    const all: ParcelIds = {
      cadastrals: [...new Set(records.flatMap((r) => r.parcels.cadastrals))],
      uniqueNumbers: [...new Set(records.flatMap((r) => r.parcels.uniqueNumbers))],
    };
    this.broker.logger.info(
      `[${this.name}] resolving ${all.cadastrals.length} cadastral and ` +
        `${all.uniqueNumbers.length} unique numbers`,
    );
    const lookup = await resolveParcels(all, (m) => this.broker.logger.warn(`[${this.name}] ${m}`));

    const events: Partial<Event>[] = [];
    let withoutGeometry = 0;
    let withoutDate = 0;

    for (const record of records) {
      const geometry = buildGeometry(record.parcels, lookup);
      if (!geometry) {
        withoutGeometry++;
        continue;
      }
      // A notice we cannot date would be stamped with today's date and reach
      // subscribers as breaking news however old it is. Better omitted than
      // misdated.
      if (!record.publishedAt) {
        withoutDate++;
        continue;
      }

      events.push({
        name: record.title,
        body: toEventBodyMarkdown([
          { title: 'Savivaldybė', value: record.municipalityName },
          { title: 'Tipas', value: record.kind === 'decision' ? 'Sprendimas' : 'Prašymas' },
          { title: 'Kadastro Nr.', value: geometry.cadastralNumbers.join(', ') },
          { title: 'Paskelbta', value: record.publishedAt },
          { title: 'Pasiūlymai iki', value: record.deadlineAt || '-' },
          { title: 'Šaltinis', value: record.url },
        ]),
        url: record.url,
        startAt: new Date(record.publishedAt),
        endAt: record.deadlineAt ? new Date(record.deadlineAt) : undefined,
        geom: geometry.geom,
        app: app.id,
        isFullDay: true,
        externalId: record.externalId,
      });
    }

    this.broker.logger.info(
      `[${this.name}] ${events.length} events from ${records.length} records ` +
        `(dropped ${withoutGeometry} without geometry, ${withoutDate} without a date)`,
    );
    return events;
  }
}
