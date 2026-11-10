/**
 * The local provider middleware as one request handler, for hosting the built
 * app on Vercel (api/gev.js). The same plugins the Vite server installs are
 * mounted on a minimal connect-style router.
 *
 * What does not change: every route keeps its own gates. Cost-bearing and
 * key-brokering routes (voice, typed chat, Provider Settings) refuse requests
 * that arrive through a reverse proxy, so on Vercel they stay off; the globe
 * and the keyless data layers work.
 *
 * Vercel's deployment filesystem is read-only, so disk caches that live under
 * the working directory are redirected to /tmp: the process runs in a /tmp
 * mirror of the deployment whose entries are symlinks, plus a writable
 * `.gev-cache`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const deployRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function useWritableWorkingDirectory() {
  const mirror = path.join('/tmp', 'gev-root');
  try {
    fs.mkdirSync(path.join(mirror, '.gev-cache'), { recursive: true });
    for (const name of fs.readdirSync(deployRoot)) {
      if (name === '.gev-cache') continue;
      const link = path.join(mirror, name);
      if (!fs.existsSync(link))
        fs.symlinkSync(path.join(deployRoot, name), link);
    }
    process.chdir(mirror);
  } catch (error) {
    console.warn('[vercel] writable cache unavailable', error?.message);
  }
  return mirror;
}

/** Connect-style mounting: use(fn) or use('/prefix', fn), prefix stripped. */
function createRouter() {
  const stack = [];
  const router = (req, res, done) => {
    const original = req.url;
    req.originalUrl ??= original;
    let index = 0;
    const next = (error) => {
      req.url = original;
      const layer = stack[index++];
      if (!layer) return done(error);
      const { route, handle } = layer;
      const pathname = original.split('?')[0];
      if (
        route &&
        !(
          pathname === route ||
          pathname.startsWith(route.endsWith('/') ? route : `${route}/`)
        )
      )
        return next(error);
      if (route) {
        const rest = original.slice(route.length) || '/';
        req.url = rest.startsWith('/') ? rest : `/${rest}`;
      }
      try {
        if (error) {
          if (handle.length === 4) return handle(error, req, res, next);
          return next(error);
        }
        if (handle.length === 4) return next();
        const result = handle(req, res, next);
        if (result && typeof result.catch === 'function')
          result.catch((failure) => next(failure));
      } catch (failure) {
        next(failure);
      }
    };
    next();
  };
  router.use = (route, handle) => {
    if (typeof route === 'function') stack.push({ route: '', handle: route });
    else stack.push({ route: String(route).replace(/\/$/, '') || '', handle });
    return router;
  };
  return router;
}

let handlerPromise;

async function buildHandler() {
  const mirror = useWritableWorkingDirectory();
  // Same-site gates admit only configured hosts; name this deployment's own.
  const ownHosts = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ].filter(Boolean);
  if (ownHosts.length)
    process.env.GEV_ALLOWED_HOSTS = [process.env.GEV_ALLOWED_HOSTS, ...ownHosts]
      .filter(Boolean)
      .join(',');

  const { localProviderPlugins } = await import('../providers/local.js');
  const { apiNotFoundPlugin } = await import('../standalone/api-not-found.js');
  const { googleTokenUnavailablePlugin } =
    await import('../standalone/google-token-unavailable.js');
  const { standaloneVoiceTools } = await import('../standalone/voiceTools.js');
  const tools = standaloneVoiceTools();
  const plugins = [
    ...localProviderPlugins({
      realtime: { tools },
      gemini: { tools },
      nominatimStorageDir: path.join(mirror, '.gev-cache', 'nominatim'),
    }),
    googleTokenUnavailablePlugin(),
    apiNotFoundPlugin(),
  ];
  const router = createRouter();
  const server = {
    middlewares: router,
    httpServer: null,
    config: { server: {}, preview: {}, root: process.cwd() },
  };
  for (const plugin of plugins) {
    const install = plugin.configurePreviewServer ?? plugin.configureServer;
    if (typeof install !== 'function') continue;
    const after = await install.call(plugin, server);
    if (typeof after === 'function') await after();
  }
  return router;
}

/** Vercel Node handler. `__gevpath` carries the original /api path. */
export default async function handler(req, res) {
  handlerPromise ??= buildHandler();
  const router = await handlerPromise;
  const url = new URL(req.url, 'http://local');
  const original = url.searchParams.get('__gevpath');
  if (original) {
    url.searchParams.delete('__gevpath');
    const query = url.searchParams.toString();
    req.url = `${original}${query ? `?${query}` : ''}`;
  }
  router(req, res, (error) => {
    if (res.headersSent || res.writableEnded) return;
    res.statusCode = error ? 500 : 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error ? 'Server error' : 'Not found' }));
  });
}
