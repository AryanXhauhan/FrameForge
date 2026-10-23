import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config/env';
import apiRouter from './routes/api.routes';
import { errorHandler } from './middlewares/error.middleware';
import { wsService } from './services/websocket.service';
import { appLogger } from './utils/logger';
import { startWorkerProcesses } from './workers/worker-runner';

const app = express();
const server = http.createServer(app);

// Support BigInt serialization in JSON responses (e.g. sizeBytes, storageBytes)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow local development and wildcard origin for demo UI
      callback(null, true);
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static media files (uploaded source & output proxy/exports)
app.use(express.static(path.resolve('./public')));
app.use('/storage/uploads', express.static(path.resolve(config.storage.uploadDir)));
app.use('/storage/outputs', express.static(path.resolve(config.storage.outputDir)));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'FrameForge Video Processing Engine',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Mount Core API Routes
app.use('/api', apiRouter);

// Centralized error handler
app.use(errorHandler);

// Setup Socket.IO
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});
wsService.initialize(io);

// Server startup function
export async function startServer() {
  const PORT = config.port;

  // Start background worker runners concurrently within modular monolith
  try {
    await startWorkerProcesses();
    appLogger.info('Modular Monolith: Background BullMQ workers active.');
  } catch (err: any) {
    appLogger.error('Failed to launch worker runners', err);
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(PORT, () => {
      appLogger.info(`FrameForge API Server running on http://localhost:${PORT}`);
      appLogger.info(`WebSocket Server active on ws://localhost:${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    appLogger.error('Failed to start server', err);
    process.exit(1);
  });
}

export { app, server };
