import { User } from '@sentry/types';
import pick from 'lodash/pick';
import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import ApiGateway from 'moleculer-web';
import {
  EndpointType,
  RequestMessage,
  throwUnauthorizedError,
  UserAuthMeta,
  UserType,
} from '../types';

async function withTimeout<T extends { ok: boolean; error?: string }>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await Promise.race<T | never>([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms),
      ),
    ]);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? `${label} check failed` };
  }
}

@Service({
  name: 'api',
  mixins: [ApiGateway],
  // More info about settings: https://moleculer.services/docs/0.14/moleculer-web.html
  settings: {
    port: process.env.PORT || 3000,
    path: '',

    // Global CORS settings for all routes
    cors: {
      // Configures the Access-Control-Allow-Origin CORS header.
      origin: '*',
      // Configures the Access-Control-Allow-Methods CORS header.
      methods: '*',
      // Configures the Access-Control-Allow-Headers CORS header.
      allowedHeaders: '*',
      // Configures the Access-Control-Expose-Headers CORS header.
      exposedHeaders: [],
      // Configures the Access-Control-Allow-Credentials CORS header.
      credentials: false,
      // Configures the Access-Control-Max-Age CORS header.
      maxAge: 3600,
    },

    routes: [
      {
        path: '/openapi',
        authorization: false,
        authentication: false,
        aliases: {
          'GET /openapi.json': 'openapi.generateDocs', // swagger scheme
          'GET /ui': 'openapi.ui', // ui
          'GET /assets/:file': 'openapi.assets', // js/css files
        },
      },
      {
        path: '/',
        whitelist: [
          // Access to any actions in all services under "/" URL
          '**',
        ],

        // Route-level Express middlewares. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Middlewares
        use: [],

        // Enable/disable parameter merging method. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Disable-merging
        mergeParams: true,

        // The auto-alias feature allows you to declare your route alias directly in your services.
        // The gateway will dynamically build the full routes from service schema.
        autoAliases: true,

        aliases: {
          'GET /ping': 'api.ping',
          'GET /health': 'api.health',
        },

        // Enable authentication. Implement the logic into `authenticate` method. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Authentication
        authentication: true,

        // Enable authorization. Implement the logic into `authorize` method. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Authorization
        authorization: true,

        // Calling options. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Calling-options
        callingOptions: {},

        bodyParsers: {
          json: {
            strict: false,
            limit: '1MB',
          },
          urlencoded: {
            extended: true,
            limit: '1MB',
          },
        },

        // Mapping policy setting. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Mapping-policy
        mappingPolicy: 'all', // Available values: "all", "restrict"

        // Enable/disable logging
        logging: true,
      },
    ],
    // Do not log client side errors (does not log an error response when the error.code is 400<=X<500)
    log4XXResponses: false,
    // Logging the request parameters. Set to any log level to enable it. E.g. "info"
    logRequestParams: null,
    // Logging the response data. Set to any log level to enable it. E.g. "info"
    logResponseData: null,
    // Serve assets from "public" folder
    assets: {
      folder: 'public',
      // Options to `server-static` module
      options: {},
    },
  },
})
export default class ApiService extends moleculer.Service {
  @Action({
    auth: EndpointType.PUBLIC,
  })
  ping() {
    return {
      timestamp: Date.now(),
    };
  }

  @Action({
    auth: EndpointType.PUBLIC,
  })
  async health(ctx: Context) {
    const [postgres, redis, auth] = await Promise.all([
      this.checkPostgres(ctx),
      this.checkRedis(),
      this.checkAuthApi(),
    ]);
    const services = { postgres, redis, auth };
    const ok = Object.values(services).every((s) => s.ok);
    return {
      ok,
      timestamp: Date.now(),
      services,
    };
  }

  @Method
  async checkPostgres(ctx: Context): Promise<{ ok: boolean; error?: string }> {
    return withTimeout(
      (async () => {
        await ctx.call('users.count', {}, { timeout: 2000 });
        return { ok: true as const };
      })(),
      3000,
      'postgres',
    );
  }

  @Method
  async checkRedis(): Promise<{ ok: boolean; error?: string }> {
    return withTimeout(
      (async () => {
        const client = (this.broker.cacher as any)?.client;
        if (!client?.ping) return { ok: false, error: 'redis client not initialized' };
        const pong = await client.ping();
        return { ok: pong === 'PONG' };
      })(),
      2000,
      'redis',
    );
  }

  @Method
  async checkAuthApi(): Promise<{ ok: boolean; error?: string }> {
    const host = process.env.AUTH_HOST;
    if (!host) return { ok: false, error: 'AUTH_HOST not set' };
    return withTimeout(
      (async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        try {
          const res = await fetch(`${host}/ping`, { signal: ctrl.signal });
          return { ok: res.ok, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
        } finally {
          clearTimeout(t);
        }
      })(),
      3000,
      'auth',
    );
  }

  @Method
  async rejectAuth(
    ctx: Context<Record<string, unknown>>,
    error: Errors.MoleculerError,
  ): Promise<unknown> {
    const meta = ctx.meta as any;
    if (meta.app) {
      const context = pick(
        ctx,
        'nodeID',
        'id',
        'event',
        'eventName',
        'eventType',
        'eventGroups',
        'parentID',
        'requestID',
        'caller',
        'params',
        'meta',
        'locals',
      );
      const action = pick(ctx.action, 'rawName', 'name', 'params', 'rest');
      const logInfo = {
        action: 'AUTH_FAILURE',
        details: {
          error,
          context,
          action,
          meta,
        },
      };
      this.logger.error(logInfo);
    }
    return Promise.reject(error);
  }

  @Method
  async authenticate(
    ctx: Context<Record<string, unknown>, UserAuthMeta>,
    _route: any,
    req: RequestMessage,
  ): Promise<unknown> {
    const actionAuthType = req.$action.auth;
    const auth = req.headers.authorization;
    const isAnonymousPublic = actionAuthType === EndpointType.PUBLIC && !auth;

    // Resolve the calling app. For an anonymous PUBLIC request this is only
    // informational, so don't let an auth-service outage turn a public endpoint
    // into a 500 — degrade to no app context instead. Authenticated flows still
    // surface the error, since they genuinely depend on it.
    try {
      ctx.meta.app = await ctx.call('auth.apps.resolveToken');
    } catch (err) {
      if (!isAnonymousPublic) throw err;
      ctx.meta.app = undefined;
    }

    if (isAnonymousPublic) {
      return Promise.resolve(null);
    }

    if (auth) {
      const type = auth.split(' ')[0];
      let token: string | undefined;
      if (type === 'Token' || type === 'Bearer') {
        token = auth.split(' ')[1];
      }

      if (token) {
        try {
          const authUser: any = await ctx.call('auth.users.resolveToken', null, {
            meta: { authToken: token },
          });

          const user: User = await ctx.call('users.resolveByAuthUser', {
            authUser: authUser,
          });

          if (user && user.id) {
            ctx.meta.authUser = authUser;
            ctx.meta.authToken = token;
            return Promise.resolve(user);
          }
        } catch (e) {
          return this.rejectAuth(ctx, throwUnauthorizedError(ApiGateway.Errors.ERR_INVALID_TOKEN));
        }
      }

      return this.rejectAuth(ctx, throwUnauthorizedError(ApiGateway.Errors.ERR_INVALID_TOKEN));
    }

    return this.rejectAuth(ctx, throwUnauthorizedError(ApiGateway.Errors.ERR_NO_TOKEN));
  }
  /**
   * Authorize the request.
   *
   * @param {Context} ctx
   * @param {any} route
   * @param {RequestMessage} req
   * @returns {Promise}
   */
  @Method
  async authorize(
    ctx: Context<Record<string, unknown>, UserAuthMeta>,
    route: any,
    req: RequestMessage,
  ): Promise<unknown> {
    const user = ctx.meta.user;

    const auth = req.$action.auth;
    if (auth === EndpointType.PUBLIC) {
      return Promise.resolve(null);
    }

    if (!user) {
      return this.rejectAuth(
        ctx,
        new ApiGateway.Errors.UnAuthorizedError(ApiGateway.Errors.ERR_NO_TOKEN, null),
      );
    }

    const aTypes = Array.isArray(req.$action.types) ? req.$action.types : [req.$action.types];
    const oTypes = Array.isArray(req.$route.opts.types)
      ? req.$route.opts.types
      : [req.$route.opts.types];

    const allTypes = [...aTypes, ...oTypes].filter(Boolean);
    const types = [...new Set(allTypes)];
    const valid = await ctx.call<boolean, { types: UserType[] }>('auth.validateType', { types });

    if (!valid) {
      return this.rejectAuth(
        ctx,
        new ApiGateway.Errors.UnAuthorizedError(ApiGateway.Errors.ERR_INVALID_TOKEN, null),
      );
    }

    return Promise.resolve(ctx);
  }
}
