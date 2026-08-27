'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import wkx from 'wkx';
import * as turf from '@turf/turf';
import { Feature } from 'geojsonjs';
// @ts-ignore
import Cron from '@r2d2bzh/moleculer-cron';

import { parse } from 'node-html-parser';

import { App, APP_KEYS } from './apps.service';
import { Event, toEventBodyMarkdown } from './events.service';
import { IntegrationsMixin } from '../mixins/integrations.mixin';
import { parcelsSearch } from '../utils/boundaries';
import { buildLtProxyOpt } from '../utils/lt-proxy';

interface VilniusArticle {
  currentUse: string | null;
  requestedUse: string | null;
  commentPeriod: string | null;
  commentEndDate: string | null;
}

interface VilniusItem extends VilniusArticle {
  link: string;
  title: string;
  date: string | null;
  cadastrals: string[];
  geom?: any;
}

const CADASTRAL_PATTERN = /\d+\/\d+:\d+/g;

function normalizeCadastral(c: string): string {
  const m = c.match(/^(\d+)\/(\d+):(\d+)$/);
  if (!m) return c;
  return `${m[1]}/${m[2]}:${m[3].padStart(4, '0')}`;
}

const CATEGORY_QUERY = 'categories=65';
const ARTICLE_BASE = 'https://vilnius.lt';
const MAX_PAGES = 50;
// Fetch articles concurrently in small batches to stay polite.
const ARTICLE_CONCURRENCY = 5;
// A run makes hundreds of requests — keep one proxy exit IP for all of them
// instead of hitting vilnius.lt from a fresh residential IP every time.
const PROXY_SESSION = 'vilnius';

@Service({
  name: 'integrations.savivaldybeZemetvarka.vilnius',
  settings: {
    // The proxy tunnels to the real host, so the upstream URL is used as-is.
    baseUrl: ARTICLE_BASE,
  },
  mixins: [Cron, IntegrationsMixin()],
  crons: [
    {
      name: 'integrationsSavivaldybeZemetvarkaVilnius',
      cronTime: '0 6 * * *',
      timeZone: 'Europe/Vilnius',
      async onTick() {
        await this.call('integrations.savivaldybeZemetvarka.vilnius.getData');
      },
    },
  ],
})
export default class IntegrationsSavivaldybeZemetvarkaVilniusService extends moleculer.Service {
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
      query: { key: APP_KEYS.savivaldybesZemetvarka },
    });
    // Returning quietly here used to make a key mismatch invisible: no throw,
    // no lastRunError, so the watchdog saw a healthy integration that had in
    // fact written nothing since the key moved underneath it.
    if (!app?.id) {
      this.finishIntegration();
      throw new Error(`no app row for key ${APP_KEYS.savivaldybesZemetvarka} — refusing to run`);
    }

    try {
      const items = await this.scrapeListing(ctx, limit);

      // If the scrape returned nothing (proxy error, site down, etc.) do NOT
      // proceed to cleanup — that would delete all existing events. Treat it
      // as a failed run instead.
      if (items.length === 0 && !limit) {
        throw new Error('scrape returned 0 items — aborting to preserve existing events');
      }

      const itemsWithGeom = await this.attachGeometries(items);

      const events: Partial<Event>[] = itemsWithGeom.map((item) => ({
        name: item.title,
        body: toEventBodyMarkdown([
          { title: 'Esama paskirtis', value: item.currentUse || '-' },
          { title: 'Pageidaujama paskirtis', value: item.requestedUse || '-' },
          { title: 'Viešinimas', value: item.commentPeriod || '-' },
          { title: 'Kadastro Nr.', value: item.cadastrals.join(', ') },
          { title: 'Data', value: item.date || '-' },
          { title: 'Šaltinis', value: `${ARTICLE_BASE}${item.link}` },
        ]),
        url: `${ARTICLE_BASE}${item.link}`,
        startAt: item.date ? new Date(item.date) : new Date(),
        endAt: item.commentEndDate ? new Date(item.commentEndDate) : undefined,
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
  async fetchHtml(ctx: Context, url: string): Promise<string> {
    return await ctx.call(
      'http.get',
      { url, opt: { responseType: 'text', ...buildLtProxyOpt(PROXY_SESSION) } },
      { timeout: 30_000 },
    );
  }

  @Method
  parseCards(html: string): Omit<VilniusItem, keyof VilniusArticle>[] {
    const root = parse(html);
    const items: Omit<VilniusItem, keyof VilniusArticle>[] = [];

    for (const card of root.querySelectorAll('[data-test="news-card"]')) {
      const link = card.querySelector('a[href^="/naujienos/"]')?.getAttribute('href') || '';
      if (!link) continue;

      const heading = card.querySelector('h1,h2,h3,h4,h5,h6');
      const title = heading?.text.trim() || '';
      const dateMatch = card.text.match(/\d{4}-\d{2}-\d{2}/);
      const date = dateMatch?.[0] || null;
      const cadastrals = title.match(CADASTRAL_PATTERN) || [];
      items.push({ link, title, date, cadastrals });
    }
    return items;
  }

  @Method
  parseArticle(html: string): VilniusArticle {
    const root = parse(html);

    const findPara = (keyword: string) =>
      root
        .querySelectorAll('p')
        .find((p) => p.text.toLowerCase().includes(keyword.toLowerCase())) ?? null;

    const currentEl = findPara('esama pagrindinė žemės naudojimo paskirtis');
    const requestedEl = findPara('pageidaujama pagrindinė žemės naudojimo paskirtis');
    const periodEl = findPara('prašymas viešinamas');

    const stripLabel = (text: string | null, label: string) =>
      text ? text.replace(new RegExp(`.*${label}[^:]*:\\s*`, 'i'), '').trim() : null;

    const currentUse = stripLabel(
      currentEl?.text ?? null,
      'Esama pagrindinė žemės naudojimo paskirtis.*?būdas',
    );
    const requestedUse = stripLabel(
      requestedEl?.text ?? null,
      'Pageidaujama pagrindinė žemės naudojimo paskirtis.*?būdas',
    );

    let commentPeriod: string | null = null;
    let commentEndDate: string | null = null;
    const periodText = periodEl?.text ?? null;
    if (periodText) {
      const LT_MONTHS: Record<string, string> = {
        sausio: '01',
        vasario: '02',
        kovo: '03',
        balandžio: '04',
        gegužės: '05',
        birželio: '06',
        liepos: '07',
        rugpjūčio: '08',
        rugsėjo: '09',
        spalio: '10',
        lapkričio: '11',
        gruodžio: '12',
      };
      const LT_DATE_RE = new RegExp(
        `(\\d{4})\\s+m\\.\\s+(${Object.keys(LT_MONTHS).join('|')})\\s+(\\d{1,2})\\s+d`,
        'gi',
      );
      const ltDates = [...periodText.matchAll(LT_DATE_RE)].map(
        (m) => `${m[1]}-${LT_MONTHS[m[2].toLowerCase()]}-${m[3].padStart(2, '0')}`,
      );
      if (ltDates.length >= 2) {
        commentPeriod = `${ltDates[0]} – ${ltDates[1]}`;
        commentEndDate = ltDates[1];
      } else if (ltDates.length === 1) {
        commentEndDate = ltDates[0];
        commentPeriod = ltDates[0];
      }
    }

    return { currentUse, requestedUse, commentPeriod, commentEndDate };
  }

  @Method
  async scrapeListing(ctx: Context, limit: number): Promise<VilniusItem[]> {
    const collected: Omit<VilniusItem, keyof VilniusArticle>[] = [];
    const seenLinks = new Set<string>();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = `${this.settings.baseUrl}/naujienos?${CATEGORY_QUERY}&page=${pageNum}`;
      let html: string;
      try {
        html = await this.fetchHtml(ctx, url);
      } catch (err: any) {
        this.broker.logger.warn(
          `[integrations.savivaldybeZemetvarka.vilnius] page ${pageNum}: fetch failed: ${
            err?.message ?? err
          }`,
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
        `[integrations.savivaldybeZemetvarka.vilnius] page ${pageNum}: cards=${
          items.length
        } new=${appendedThisPage} withCadastral=${withCadastral} (sample="${(
          items[0]?.title || ''
        ).slice(0, 60)}")`,
      );

      if (limit && collected.length >= limit) break;
      if (items.length === 0 || appendedThisPage === 0) break;
    }

    // Enrich with article details in concurrent batches.
    this.broker.logger.info(
      `[integrations.savivaldybeZemetvarka.vilnius] fetching ${collected.length} articles (concurrency=${ARTICLE_CONCURRENCY})`,
    );
    const enriched: VilniusItem[] = [];
    for (let i = 0; i < collected.length; i += ARTICLE_CONCURRENCY) {
      const batch = collected.slice(i, i + ARTICLE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (item) => {
          const articleUrl = `${this.settings.baseUrl}${item.link}`;
          try {
            const html = await this.fetchHtml(ctx, articleUrl);
            return { ...item, ...this.parseArticle(html) };
          } catch (err: any) {
            this.broker.logger.warn(
              `[integrations.savivaldybeZemetvarka.vilnius] article fetch failed ${item.link}: ${
                err?.message ?? err
              }`,
            );
            return {
              ...item,
              currentUse: null,
              requestedUse: null,
              commentPeriod: null,
              commentEndDate: null,
            };
          }
        }),
      );
      enriched.push(...results);
    }
    this.broker.logger.info(`[integrations.savivaldybeZemetvarka.vilnius] article enrichment done`);

    return enriched;
  }

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
          `[integrations.savivaldybeZemetvarka.vilnius] parcelsSearch chunk failed (${
            chunk.length
          } cadastrals): ${err?.message ?? err}`,
        );
      }
    }
    return geomMap;
  }

  @Method
  async attachGeometries(items: VilniusItem[]): Promise<VilniusItem[]> {
    const itemsWithCadastral = items.filter((i) => i.cadastrals.length > 0);
    if (itemsWithCadastral.length < items.length) {
      this.broker.logger.info(
        `[integrations.savivaldybeZemetvarka.vilnius] ${items.length - itemsWithCadastral.length}/${
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
        `[integrations.savivaldybeZemetvarka.vilnius] ${
          itemsWithCadastral.length - result.length
        }/${itemsWithCadastral.length} items dropped: cadastral not found in parcels API`,
      );
    }

    return result;
  }
}
