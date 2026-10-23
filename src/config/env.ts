import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/frameforge?schema=public',
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
  },
  jwtSecret: process.env.JWT_SECRET || 'frameforge-jwt-secret-min-32-chars-long!',
  storage: {
    uploadDir: path.resolve(process.env.UPLOAD_DIR || './storage/uploads'),
    outputDir: path.resolve(process.env.OUTPUT_DIR || './storage/outputs'),
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'mock',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
  },
  credits: {
    proxyCost: 2,
    aiCost: 5,
    standardExportCost: 10,
    hqExportCost: 20,
    initialBalance: 100,
  },
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000').split(','),
};
