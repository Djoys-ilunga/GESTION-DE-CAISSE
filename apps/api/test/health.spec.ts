import 'reflect-metadata';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { HealthController } from '../src/health.controller';
import { READINESS_DATABASE } from '../src/database.port';
import { configureApp } from '../src/app';
describe('Disponibilité HTTP avec double de base', () => {
  let app: INestApplication;
  const count = vi.fn();
  beforeEach(async () => {
    process.env.API_DEPLOYMENT_ID = 'test';
    count.mockResolvedValue(1);
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: READINESS_DATABASE, useValue: { ready: count } }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app, ['http://127.0.0.1:1420']);
    await app.init();
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    await app.close();
  });
  it('renvoie un contrat public et interdit la mise en cache', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(r.body).toEqual({
      service: 'caissepro-api',
      protocolVersion: 1,
      deploymentId: 'test',
      status: 'ready',
    });
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('signale une base indisponible sans exposer ses erreurs', async () => {
    count.mockRejectedValueOnce(new Error('postgresql://secret'));
    const r = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
  it('n’expose aucune route de confirmation financière', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments')
      .send({ amount: '1.00' })
      .expect(404);
  });
  it('borne les origines CORS', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .set('Origin', 'https://untrusted.example')
      .expect(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});
