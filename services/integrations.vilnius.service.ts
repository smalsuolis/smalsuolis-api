'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import wkx from 'wkx';
import * as turf from '@turf/turf';
import { Feature } from 'geojsonjs';
import puppeteer, { Browser, Page } from 'puppeteer';
// @ts-ignore
import Cron from '@r2d2bzh/moleculer-cron';

import { App, APP_KEYS } from './apps.service';
import { Event, toEventBodyMarkdown } from './events.service';
import { IntegrationsMixin } from '../mixins/integrations.mixin';
import { parcelsSearch } from '../utils/boundaries';

interface VilniusItem {
  link: string;
  title: string;
  date: string | null;
  cadastrals: string[];
  geom?: any;
}

// Cadastral number format used in titles, same as the existing zpdris
// integration: e.g. `0101/0039:1330`. Anchored to digits-only segments
// separated by `/` and `:`.
const CADASTRAL_PATTERN = /\d+\/\d+:\d+/g;

// Vilnius news category 65 = "Prašymų pakeisti/nustatyti žemės sklypo
// pagrindinę žemės naudojimo paskirtį..." — the planned-change announcements
// the client wants surfaced before they hit the post-approval zpdris feed.
const LISTING_BASE = 'https://vilnius.lt/naujienos?categories=65';
const ARTICLE_BASE = 'https://vilnius.lt';

// Hard upper bound on pagination — there are ~282 cards as of writing,
// and the loop also bails as soon as a page returns no new items, so this
// is a safety net not an expected limit.
const MAX_PAGES = 50;

@Service({
  name: 'integrations.vilnius',
  mixins: [Cron, IntegrationsMixin()],
  crons: [
    {
      name: 'integrationsVilnius',
      // Daily at 06:00 EEST — after the existing 05:00 zpdris cron.
      cronTime: '0 6 * * *',
      timeZone: 'Europe/Vilnius',
      async onTick() {
        await this.call('integrations.vilnius.getData');
      },
    },
  ],
})
export default class IntegrationsVilniusService extends moleculer.Service {
  @Action({
    timeout: 0,
    params: {
      limit: { type: 'number', optional: true, default: 0 },
      initial: { type: 'boolean', optional: true, default: false },
    },
  })
  async getData(ctx: Context<{ limit: number; initial: boolean }>) {
    this.startIntegration();

    const { limit, initial } = ctx.params;

    const app: App = await ctx.call('apps.findOne', {
      query: { key: APP_KEYS.savivaldybesZemetvarkaVilnius },
    });
    if (!app?.id) return;

    try {
      const items = await this.scrapeListing(limit);
      const itemsWithGeom = await this.attachGeometries(items);

      const events: Partial<Event>[] = itemsWithGeom.map((item) => ({
        name: item.title,
        body: toEventBodyMarkdown([
          { title: 'Kadastro Nr.', value: item.cadastrals.join(', ') },
          { title: 'Data', value: item.date || '-' },
          { title: 'Šaltinis', value: `${ARTICLE_BASE}${item.link}` },
        ]),
        url: `${ARTICLE_BASE}${item.link}`,
        startAt: item.date ? new Date(item.date) : new Date(),
        geom: item.geom,
        app: app.id,
        isFullDay: true,
        // Article slug is the stable id Vilnius assigns; cadastral is in it
        // but the slug is what won't change if the body gets edited.
        externalId: item.link,
      }));

      await this.createOrUpdateEvents(ctx, app, events, initial);
      await this.cleanupInvalidEvents(ctx, app);
      await this.recordRunSuccess(ctx, app);
      return this.finishIntegration();
    } catch (err: any) {
      await this.recordRunFailure(ctx, app, err);
      return this.finishIntegration();
    }
  }

  @Method
  async getBrowser(): Promise<Browser> {
    return await puppeteer.connect({
      browserWSEndpoint: process.env.CHROME_WS_ENDPOINT || 'ws://localhost:9321',
      acceptInsecureCerts: true,
    });
  }

  @Method
  async scrapeListing(limit: number): Promise<VilniusItem[]> {
    const maxRetries = 3;
    let browser: Browser | undefined;
    let lastErr: any;
    for (let i = 0; i < maxRetries; i++) {
      try {
        browser = await this.getBrowser();
        if (browser) break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!browser) throw lastErr || new Error('Could not connect to browser');

    const page = await browser.newPage();
    try {
      const collected: VilniusItem[] = [];
      const seenLinks = new Set<string>();

      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        const url = `${LISTING_BASE}&page=${pageNum}`;
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
        // Cards are React-rendered. If none ever appear we treat as end-of-list.
        const found = await page
          .waitForSelector('[data-test="news-card"]', { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (!found) break;

        const items: VilniusItem[] = await page.evaluate((pattern: string) => {
          const re = new RegExp(pattern, 'g');
          const cards = Array.from(document.querySelectorAll('[data-test="news-card"]'));
          return cards.map((card) => {
            const a = card.querySelector('a[href^="/naujienos/"]');
            const link = a?.getAttribute('href') || '';
            // Card title text — there's an h2/h3/heading-like element; the
            // outermost text content of the card is the most resilient grab.
            const text = (card as HTMLElement).innerText || '';
            // Date appears as YYYY-MM-DD on the card.
            const dateMatch = text.match(/\d{4}-\d{2}-\d{2}/);
            // Title is the visible non-date, non-tag text — pull h2/h3/strong
            // first; fall back to the longest line that isn't the date.
            const heading = card.querySelector('h2, h3, [class*="title"], a [class*="title"]');
            let title = heading?.textContent?.trim() || '';
            if (!title) {
              const lines = text
                .split('\n')
                .map((s: string) => s.trim())
                .filter((s: string) => s && !/^\d{4}-\d{2}-\d{2}$/.test(s));
              title = lines.sort((a: string, b: string) => b.length - a.length)[0] || '';
            }
            const cadastrals = title.match(re) || [];
            return {
              link,
              title,
              date: dateMatch ? dateMatch[0] : null,
              cadastrals: cadastrals as string[],
            };
          });
        }, CADASTRAL_PATTERN.source);

        let appendedThisPage = 0;
        for (const item of items) {
          if (!item.link || seenLinks.has(item.link)) continue;
          seenLinks.add(item.link);
          collected.push(item);
          appendedThisPage++;
          if (limit && collected.length >= limit) break;
        }

        if (limit && collected.length >= limit) break;
        // No new items on this page → either end-of-list, or `?page=` doesn't
        // paginate the way we expect (vilnius.lt is Next.js, server may just
        // re-render the first page). Either way, stop walking.
        if (appendedThisPage === 0) break;
      }

      return collected;
    } finally {
      await page.close().catch(() => null);
      // `disconnect` returns the browser to the remote pool without closing it.
      try {
        await browser.disconnect();
      } catch {
        /* noop */
      }
    }
  }

  // Same lookup pattern as integrations.landManagementPlanning — chunk the
  // cadastral numbers to stay within the boundaries API page limit, parse
  // the WKB geometry and tag with EPSG:4326.
  @Method
  async getGeometryData(cadastralNumbers: string[]): Promise<Map<string, Feature>> {
    const geomMap = new Map<string, Feature>();
    const chunkSize = 100;
    for (let i = 0; i < cadastralNumbers.length; i += chunkSize) {
      const chunk = cadastralNumbers.slice(i, i + chunkSize);
      const filters = chunk.map((cadastralNumber) => ({
        parcels: { cadastral_number: { exact: cadastralNumber } },
      }));
      try {
        const data = await parcelsSearch({
          requestBody: { filters },
          size: chunkSize,
          srid: 4326,
        });
        data.items?.forEach((item: any) => {
          if (!item?.geometry?.data || !item?.cadastral_number) return;
          const geometry = wkx.Geometry.parse(item.geometry.data).toGeoJSON();
          geomMap.set(item.cadastral_number, { type: 'Feature', geometry } as Feature);
        });
      } catch (err: any) {
        this.broker.logger.warn(
          `[integrations.vilnius] parcelsSearch chunk failed (${chunk.length} cadastrals): ${
            err?.message ?? err
          }`,
        );
      }
    }
    return geomMap;
  }

  // Drops items without resolvable geometry — without coords the event has
  // nothing to plot on the map and can't intersect any subscription, so it'd
  // be dead weight. Logged so we can see how often this happens.
  @Method
  async attachGeometries(items: VilniusItem[]): Promise<VilniusItem[]> {
    const itemsWithCadastral = items.filter((i) => i.cadastrals.length > 0);
    if (itemsWithCadastral.length < items.length) {
      this.broker.logger.info(
        `[integrations.vilnius] ${items.length - itemsWithCadastral.length}/${
          items.length
        } items dropped: no cadastral in title`,
      );
    }
    const uniqueCadastrals = [...new Set(itemsWithCadastral.flatMap((i) => i.cadastrals))];
    if (!uniqueCadastrals.length) return [];

    const geomMap = await this.getGeometryData(uniqueCadastrals);

    const result: VilniusItem[] = [];
    for (const item of itemsWithCadastral) {
      const geometries = item.cadastrals
        .map((c) => geomMap.get(c))
        .filter((g): g is Feature => !!g?.geometry);
      if (!geometries.length) continue;

      const combined: any =
        geometries.length === 1
          ? geometries[0]
          : turf.union(turf.featureCollection(geometries as any));
      if (!combined?.geometry) continue;
      combined.geometry.crs = 'EPSG:4326';
      result.push({ ...item, geom: combined });
    }

    if (result.length < itemsWithCadastral.length) {
      this.broker.logger.info(
        `[integrations.vilnius] ${itemsWithCadastral.length - result.length}/${
          itemsWithCadastral.length
        } items dropped: cadastral not found in parcels API`,
      );
    }

    return result;
  }
}
