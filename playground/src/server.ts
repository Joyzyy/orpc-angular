import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { RPCHandler } from '@orpc/server/node';
import { GetMethodCsrfProtectionHandlerPlugin } from '@orpc/server/plugins';
import { hits, router } from './api/router';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

const rpcHandler = new RPCHandler(router, {
  allowMethods: ['GET', 'POST'],
  plugins: [new GetMethodCsrfProtectionHandlerPlugin()],
});

app.use('/rpc{*splat}', async (req, res, next) => {
  const { matched } = await rpcHandler.handle(req, res, { prefix: '/rpc', context: {} });
  if (!matched) next();
});

app.get('/debug/hits', (_req, res) => {
  res.json(hits);
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
