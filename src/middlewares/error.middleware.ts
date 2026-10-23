import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { appLogger } from '../utils/logger';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  const logger = appLogger.child('HTTPError');

  if (err instanceof AppError) {
    logger.warn(`API Error: ${err.message}`, {
      statusCode: err.statusCode,
      errorCode: err.errorCode,
      path: req.originalUrl,
    });

    return res.status(err.statusCode).json({
      error: {
        code: err.errorCode,
        message: err.message,
        isRetryable: err.isRetryable,
      },
    });
  }

  if (err.name === 'PrismaClientKnownRequestError' && (err.code === '40001' || err.message?.includes('could not serialize access'))) {
    logger.warn(`Database concurrency conflict at ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(409).json({
      error: {
        code: 'CONCURRENT_UPDATE_CONFLICT',
        message: 'A concurrent update conflict occurred. Please retry the request.',
        isRetryable: true,
      },
    });
  }

  // Multer error handling
  if (err.name === 'MulterError') {
    return res.status(400).json({
      error: {
        code: 'FILE_UPLOAD_ERROR',
        message: err.message,
      },
    });
  }

  logger.error(`Unhandled Exception at ${req.method} ${req.originalUrl}`, err);

  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    },
  });
}
