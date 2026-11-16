import fs from 'node:fs';
import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';

// The OpenAPI spec lives in docs/openapi.yaml (also a submission deliverable) and is served
// as an interactive Swagger UI at /api/docs, with the raw spec at /api/docs.json.
const spec = parse(fs.readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'));

export function docsRouter() {
  const router = Router();

  // Swagger UI needs inline scripts/styles, so relax the CSP for the docs routes only.
  router.use(helmet({ contentSecurityPolicy: false }));

  router.get('/api/docs.json', (_req, res) => res.json(spec));
  router.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Seba API',
      swaggerOptions: { persistAuthorization: true, tryItOutEnabled: true },
    }),
  );
  router.get('/', (_req, res) => res.redirect('/api/docs'));
  return router;
}
