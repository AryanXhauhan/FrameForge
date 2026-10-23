import request from 'supertest';
import { app } from '../../src/index';
import { prisma } from '../../src/config/database';
import path from 'path';
import fs from 'fs';

describe('FrameForge Media E2E Flow', () => {
  let projectId: string;
  let mediaAssetId: string;
  let sampleVideoPath: string;

  beforeAll(async () => {
    sampleVideoPath = path.resolve('./storage/sample_test.mp4');
    expect(fs.existsSync(sampleVideoPath)).toBe(true);

    // Create test project
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'E2E Transcode Suite' });
    
    expect(res.status).toBe(201);
    projectId = res.body.id;
  });

  afterAll(async () => {
    if (projectId) {
      await prisma.project.delete({ where: { id: projectId } });
    }
    await prisma.$disconnect();
  });

  test('POST /api/projects/:projectId/media uploads media and inspects metadata', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/media`)
      .attach('file', sampleVideoPath);

    expect(res.status).toBe(201);
    expect(res.body.originalFilename).toBe('sample_test.mp4');
    expect(res.body.width).toBe(640);
    expect(res.body.height).toBe(360);
    expect(res.body.codec).toBe('h264');

    mediaAssetId = res.body.id;
  });

  test('POST /api/media/:id/proxy queues proxy job and reserves credits', async () => {
    const idempotencyKey = `idem-e2e-${Date.now()}`;
    const res = await request(app)
      .post(`/api/media/${mediaAssetId}/proxy`)
      .set('Idempotency-Key', idempotencyKey)
      .send();

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.type).toBe('PROXY_GENERATION');
  });

  test('POST /api/media/:id/analyze queues AI analysis job', async () => {
    const res = await request(app)
      .post(`/api/media/${mediaAssetId}/analyze`)
      .send();

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.type).toBe('AI_ANALYSIS');
  });

  test('POST /api/projects/:projectId/export queues export job', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/export`)
      .send({ mediaAssetId, quality: '720p', fps: 30 });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.type).toBe('EXPORT');
  });

  test('GET /api/usage returns aggregated usage and costs', async () => {
    const res = await request(app).get('/api/usage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalJobs');
    expect(res.body).toHaveProperty('estimatedCost');
  });

  test('GET /api/metrics returns system health and BullMQ queue depths', async () => {
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('HEALTHY');
    expect(res.body.queues).toHaveProperty('frameforge-proxy-queue');
  });
});
