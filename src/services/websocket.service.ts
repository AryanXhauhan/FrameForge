import { Server as SocketIOServer } from 'socket.io';
import { appLogger } from '../utils/logger';

export interface ProgressEventPayload {
  jobId: string;
  userId: string;
  projectId: string;
  status: string;
  stage: string;
  progress: number;
  etaSeconds?: number;
  elapsedSeconds?: number;
  attempts?: number;
  error?: string;
  metadata?: any;
  timestamp: string;
}

export class WebSocketService {
  private io: SocketIOServer | null = null;
  private logger = appLogger.child('WebSocketService');

  initialize(ioServer: SocketIOServer): void {
    this.io = ioServer;

    this.io.on('connection', (socket) => {
      this.logger.info(`WebSocket client connected: ${socket.id}`);

      socket.on('subscribe:job', (jobId: string) => {
        socket.join(`job:${jobId}`);
        this.logger.debug(`Socket ${socket.id} subscribed to job:${jobId}`);
      });

      socket.on('subscribe:project', (projectId: string) => {
        socket.join(`project:${projectId}`);
        this.logger.debug(`Socket ${socket.id} subscribed to project:${projectId}`);
      });

      socket.on('disconnect', () => {
        this.logger.info(`WebSocket client disconnected: ${socket.id}`);
      });
    });
  }

  broadcastJobProgress(payload: ProgressEventPayload): void {
    if (!this.io) return;

    // Room-specific broadcast
    this.io.to(`job:${payload.jobId}`).emit('job.progress', payload);
    this.io.to(`project:${payload.projectId}`).emit('job.progress', payload);

    // Global dashboard broadcasts
    this.io.emit('job.progress', payload);
    this.io.emit('job.update', payload);
  }

  broadcastJobStatus(payload: ProgressEventPayload): void {
    if (!this.io) return;
    this.io.to(`job:${payload.jobId}`).emit('job.status_change', payload);
    this.io.to(`project:${payload.projectId}`).emit('job.status_change', payload);
    this.io.emit('job.status_change', payload);
    this.io.emit('job.update', payload);
  }
}

export const wsService = new WebSocketService();
