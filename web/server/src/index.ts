import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import { FRONTEND_DIST, PORT, PROJECTS_DIR } from './config.js';
import routes from './routes.js';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 64 * 1024 * 1024 });

await app.register(multipart, { limits: { fileSize: 256 * 1024 * 1024 } });
await app.register(routes);

if (FRONTEND_DIST && fs.existsSync(FRONTEND_DIST)) {
  await app.register(fastifyStatic, { root: FRONTEND_DIST });
  // SPA fallback: any non-API GET serves the app shell
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
}

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`projects dir: ${PROJECTS_DIR}`);
  app.log.info(`frontend: ${FRONTEND_DIST || '(dev — use vite)'}`);
});
