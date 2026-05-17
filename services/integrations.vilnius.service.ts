'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import wkx from 'wkx';
import * as turf from '@turf/turf';
import { Feature } from 'geojsonjs';
// @ts-ignore
import Cron from '@r2d2bzh/moleculer-cron';

import { App, APP_KEYS } from './apps.service';
import { Event, toEventBodyMarkdown } from './events.service';
import { IntegrationsMixin } from '../mixins/integrations.mixin';
import { parcelsSearch } from '../utils/boundaries';
import { buildJumpHttpsOpt } from '../utils/lt-jump';

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

// parcelsSearch matches the last segment exactly and expects it
// zero-padded to 4 digits. Vilnius's headings occasionally drop the
// leading zeros (`:146` instead of `:0146`), so normalize before lookup.
function normalizeCadastral(c: string): string {
  const m = c.match(/^(\d+)\/(\d+):(\d+)$/);
  if (!m) return c;
  return `${m[1]}/${m[2]}:${m[3].padStart(4, '0')}`;
}

// Vilnius news category 65 = "Prašymų pakeisti/nustatyti žemės sklypo
// pagrindinę žemės naudojimo paskirtį..." — the planned-change announcements
// the client wants surfaced before they hit the post-approval zpdris feed.
const CATEGORY_QUERY = 'categories=65';
const ARTICLE_BASE = 'https://vilnius.lt';

// Hard upper bound on pagination — there are ~282 cards as of writing,
// and the loop also bails as soon as a page returns no cards, so this
// is a safety net not an expected limit.
const MAX_PAGES = 50;

@Service({
  name: 'integrations.vilnius',
  settings: {
    // Direct upstream from LT, jump-proxy URL from prod env. The proxy preserves
    // query string via nginx `$is_args$args`, so we append the same way either way.
    listingUrl: process.env.SAVIVALDYBE_JUMP_URL
      ? `${process.env.SAVIVALDYBE_JUMP_URL}/vilnius-naujienos`
      : `${ARTICLE_BASE}/naujienos`,
  },
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
      const items = await this.scrapeListing(ctx, limit);
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
  async fetchPage(ctx: Context, pageNum: number): Promise<string> {
    const url = `${this.settings.listingUrl}?${CATEGORY_QUERY}&page=${pageNum}`;
    return await ctx.call(
      'http.get',
      {
        url,
        opt: { responseType: 'text', ...buildJumpHttpsOpt() },
      },
      { timeout: 30_000 },
    );
  }

  // Parse the SSR HTML. Cards are delimited by `data-test="news-card"`; inside
  // each chunk we pull link/heading/date with simple regex. The markup is stable
  // — Next.js SSR with named hooks — so this is more reliable than a full DOM
  // parser would be at smaller cost.
  @Method
  parseCards(html: string): VilniusItem[] {
    const cardMarker = /data-test="news-card"/g;
    const chunks: string[] = [];
    let lastIdx = -1;
    let m: RegExpExecArray | null;
    while ((m = cardMarker.exec(html))) {
      if (lastIdx >= 0) chunks.push(html.slice(lastIdx, m.index));
      lastIdx = m.index;
    }
    if (lastIdx >= 0) chunks.push(html.slice(lastIdx, lastIdx + 4000));

    const items: VilniusItem[] = [];
    for (const chunk of chunks) {
      const linkMatch = chunk.match(/href="(\/naujienos\/[^"]+)"/);
      const link = linkMatch?.[1] || '';
      if (!link) continue;

      const headingMatch = chunk.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/);
      const title = (headingMatch?.[1] || '').replace(/<[^>]+>/g, '').trim();

      const dateMatch = chunk.match(/\d{4}-\d{2}-\d{2}/);
      const date = dateMatch?.[0] || null;

      const cadastrals = title.match(CADASTRAL_PATTERN) || [];
      items.push({ link, title, date, cadastrals });
    }
    return items;
  }

  @Method
  async scrapeListing(ctx: Context, limit: number): Promise<VilniusItem[]> {
    const collected: VilniusItem[] = [];
    const seenLinks = new Set<string>();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      let html: string;
      try {
        html = await this.fetchPage(ctx, pageNum);
      } catch (err: any) {
        this.broker.logger.warn(
          `[integrations.vilnius] page ${pageNum}: fetch failed: ${err?.message ?? err}`,
        );
        break;
      }

      const items = this.parseCards(html);
      let appendedThisPage = 0;
      let withCadastral = 0;
      for (const item of items) {
        if (!item.link || seenLinks.has(item.link)) continue;
        seenLinks.add(item.link);
        collected.push(item);
        appendedThisPage++;
        if (item.cadastrals.length) withCadastral++;
        if (limit && collected.length >= limit) break;
      }

      this.broker.logger.info(
        `[integrations.vilnius] page ${pageNum}: cards=${
          items.length
        } new=${appendedThisPage} withCadastral=${withCadastral} (sample title="${(
          items[0]?.title || ''
        ).slice(0, 80)}")`,
      );

      if (limit && collected.length >= limit) break;
      // No cards on this page = end of list.
      if (items.length === 0) break;
      // No NEW items but page had cards = pagination not advancing (e.g. server
      // re-rendered the first page); stop walking either way.
      if (appendedThisPage === 0) break;
    }

    return collected;
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
    const uniqueCadastrals = [
      ...new Set(itemsWithCadastral.flatMap((i) => i.cadastrals.map(normalizeCadastral))),
    ];
    if (!uniqueCadastrals.length) return [];

    const geomMap = await this.getGeometryData(uniqueCadastrals);

    const result: VilniusItem[] = [];
    for (const item of itemsWithCadastral) {
      const geometries = item.cadastrals
        .map((c) => geomMap.get(normalizeCadastral(c)))
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
