import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { config } from './env';

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: config.databaseUrl.includes('connection_limit')
        ? config.databaseUrl
        : `${config.databaseUrl}&connect_timeout=30&connection_limit=25&pool_timeout=30`,
    },
  },
  log: config.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
});

export const redisConnection = config.redis.url
  ? new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    })
  : new Redis({
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

redisConnection.on('error', (err) => {
  console.error('[Redis Connection Error]', err.message);
});

export const pubClient = redisConnection;
export const subClient = redisConnection.duplicate();
