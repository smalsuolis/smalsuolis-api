'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { App, APP_KEYS } from './apps.service';
// @ts-ignore
import Cron from '@r2d2bzh/moleculer-cron';
import unzipper from 'unzipper';
import stream from 'node:stream';

import { Event, toEventBodyMarkdown } from './events.service';
import { IntegrationsMixin, IntegrationStats } from '../mixins/integrations.mixin';
import { buildLtProxyOpt } from '../utils/lt-proxy';

// got does not retry streams, and a 48 MB download through a residential proxy
// can drop mid-flight — without a retry a single blip costs a full day of data.
const DOWNLOAD_ATTEMPTS = 3;

// The subset of lkmp-data.geojson this integration actually reads.
type LumberingProperties = {
  id: string | number;
  padalinys: string;
  girininkija: string;
  galioja_nuo: string;
  galioja_iki: string;
  kvartalas: string;
  sklypas: string;
  kertamas_plotas: string | number | null;
  kirtimo_rusis: string;
  vyraujantys_medziai: string;
  atkurimo_budas: string;
};

type LumberingFeature = {
  type: string;
  geometry: { type: string; coordinates: unknown; crs?: string };
  properties: LumberingProperties;
};

type LumberingGeojson = { features?: LumberingFeature[] };

@Service({
  name: 'integrations.lumbering',
  settings: {
    zipUrl: 'https://lkmp.alisas.lt/static/lkmp-data.geojson.zip',
    //    zipUrl: 'https://eima.smala.lt/lkmp/static/lkmp-data.geojson.zip',
  },
  mixins: [Cron, IntegrationsMixin()],
  crons: [
    {
      name: 'integrationsLumbering',
      cronTime: '0 4 * * *',
      timeZone: 'Europe/Vilnius',
      async onTick() {
        await this.call('integrations.lumbering.getData', {
          limit: process.env.NODE_ENV === 'local' ? 100 : 0,
        });
      },
    },
  ],
})
export default class IntegrationsLumberingService extends moleculer.Service {
  @Action({
    timeout: 0,
    params: {
      limit: {
        type: 'number',
        optional: true,
        default: 0,
      },
      initial: {
        type: 'boolean',
        optional: true,
        default: false,
      },
    },
  })
  async getData(ctx: Context<{ limit: number; initial: boolean }>) {
    this.startIntegration();

    const app: App = await ctx.call('apps.findOne', {
      query: {
        key: APP_KEYS.miskoKirtimai,
      },
    });

    if (!app?.id) return;

    try {
      return await this.scrape(ctx, app);
    } catch (err: any) {
      // Any source/parse/processing error is caught here so the node process
      // stays alive. recordRunFailure writes the error to the apps table —
      // the watchdog surfaces it to Telegram within minutes, no 7-day wait.
      await this.recordRunFailure(ctx, app, err);
      return this.finishIntegration();
    }
  }

  @Method
  async downloadGeojson(ctx: Context): Promise<LumberingGeojson> {
    const response: stream.Readable = await ctx.call(
      'http.get',
      {
        url: this.settings.zipUrl,
        opt: { isStream: true, ...buildLtProxyOpt() },
      },
      { timeout: 0 },
    );

    return await new Promise<LumberingGeojson>((resolve, reject) => {
      response.on('error', reject);
      const unzipStream = response.pipe(unzipper.Parse());
      unzipStream.on('error', reject);
      const transformStream = unzipStream.pipe(
        new stream.Transform({
          objectMode: true,
          transform(entry, _e, cb) {
            const fileName = entry.path;
            const type = entry.type; // 'Directory' or 'File'

            if (type === 'File' && fileName === 'lkmp-data.geojson') {
              const chunks: Buffer[] = [];
              entry.on('data', (chunk: Buffer) => chunks.push(chunk));
              entry.on('end', () => {
                try {
                  const jsonString = Buffer.concat(chunks).toString('utf-8');
                  resolve(JSON.parse(jsonString));
                } catch (err) {
                  reject(err);
                }
              });
              entry.on('error', reject);
            } else {
              entry.autodrain();
            }
            cb();
          },
        }),
      );
      transformStream.on('error', reject);
      transformStream.on('finish', () =>
        reject(new Error("zip did not contain 'lkmp-data.geojson'")),
      );
    });
  }

  @Method
  async scrape(ctx: Context<{ limit: number; initial: boolean }>, app: App) {
    let geojson: LumberingGeojson | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        geojson = await this.downloadGeojson(ctx);
        break;
      } catch (err: unknown) {
        if (attempt >= DOWNLOAD_ATTEMPTS) throw err;
        this.broker.logger.warn(
          `[integrations.lumbering] download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed: ${
            err instanceof Error ? err.message : String(err)
          } — retrying`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
      }
    }

    if (!geojson?.features) {
      throw new Error('empty geojson — no features field');
    }

    const features: LumberingFeature[] = ctx.params.limit
      ? geojson.features.splice(0, ctx.params.limit)
      : geojson.features;

    for (const feature of features) {
      feature.geometry.crs = 'EPSG:4326';

      const ownershipTypesByDigit: Record<number, string> = {
        1: 'Privati',
        2: 'Valstybinė',
        3: 'Privati',
      };
      const firstIdDigit = Number(`${feature.properties.id}`.slice(0, 1));

      const bodyJSON = [
        { title: 'Struktūrinis padalinys', value: `${feature.properties.padalinys} RP` },
        { title: 'Girininkija', value: `${feature.properties.girininkija} girininkija` },
        {
          title: 'Galioja',
          value: `${feature.properties.galioja_nuo} iki ${feature.properties.galioja_iki}`,
        },
        { title: 'Kvartalas', value: feature.properties.kvartalas },
        { title: 'Sklypas', value: feature.properties.sklypas },
        { title: 'Kertamas plotas', value: `${feature.properties.kertamas_plotas || '-'} ha` },
        { title: 'Kirtimo rūšis', value: feature.properties.kirtimo_rusis },
        { title: 'Vyraujantys medžiai', value: feature.properties.vyraujantys_medziai },
        { title: 'Atkūrimo būdas', value: feature.properties.atkurimo_budas },
        { title: 'Nuosavybės forma', value: ownershipTypesByDigit[firstIdDigit] || '-' },
      ];

      const tagsIds: number[] = await this.findOrCreateTags(
        ctx,
        [feature.properties.kirtimo_rusis],
        APP_KEYS.miskoKirtimai,
      );

      const tagsData = [];

      if (tagsIds.length && feature.properties.kertamas_plotas) {
        const area = Math.round(Number(feature.properties.kertamas_plotas) * 100) / 100;
        tagsData.push({
          id: tagsIds[0],
          name: 'area',
          value: area,
        });
      }

      const event: Partial<Event> = {
        name: `${feature.properties.kirtimo_rusis}, ${feature.properties.girininkija} girininkija, ${feature.properties.padalinys} r.p.`,
        body: toEventBodyMarkdown(bodyJSON),
        startAt: new Date(feature.properties.galioja_nuo),
        endAt: new Date(feature.properties.galioja_iki),
        geom: feature,
        app: app.id,
        isFullDay: true,
        externalId: String(feature.properties.id),
        tags: tagsIds,
        tagsData,
      };

      await this.createOrUpdateEvent(ctx, app, event, !!ctx.params.initial);
    }

    await this.cleanupInvalidEvents(ctx, app);

    await this.recordRunSuccess(ctx, app);
    return this.finishIntegration();
  }
}
