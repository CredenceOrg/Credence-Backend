import request from 'supertest';
import express, { Request, Response } from 'express';
import { metricsMiddleware } from '../metrics.js';

test('req.metrics namespace is isolated per request', async () => {
  const app = express();
  app.use(metricsMiddleware);

  // Route that mutates req.metrics
  app.get('/set', (req: Request, res: Response) => {
    (req as any).metrics.foo = 'bar';
    res.json({ set: true });
  });

  // Route that checks for the existence of the property
  app.get('/check', (req: Request, res: Response) => {
    const hasFoo = Object.prototype.hasOwnProperty.call((req as any).metrics, 'foo');
    res.json({ hasFoo });
  });

  // First request sets the property
  await request(app).get('/set').expect(200, { set: true });

  // Second request should NOT see the property set in the previous request
  const response = await request(app).get('/check').expect(200);
  expect(response.body.hasFoo).toBe(false);
});
