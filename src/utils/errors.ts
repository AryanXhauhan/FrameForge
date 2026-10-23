export class AppError extends Error {
  public readonly isRetryable: boolean;
  public readonly statusCode: number;
  public readonly errorCode: string;

  constructor(message: string, statusCode: number = 500, errorCode: string = 'INTERNAL_ERROR', isRetryable: boolean = false) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isRetryable = isRetryable;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class RetryableError extends AppError {
  constructor(message: string, errorCode: string = 'TEMPORARY_FAILURE') {
    super(message, 503, errorCode, true);
    this.name = 'RetryableError';
  }
}

export class NonRetryableError extends AppError {
  constructor(message: string, errorCode: string = 'NON_RETRYABLE_ERROR') {
    super(message, 400, errorCode, false);
    this.name = 'NonRetryableError';
  }
}

export class InsufficientCreditsError extends NonRetryableError {
  constructor(message: string = 'Insufficient credits to perform this operation') {
    super(message, 'INSUFFICIENT_CREDITS');
    this.name = 'InsufficientCreditsError';
  }
}

export class InvalidStateTransitionError extends NonRetryableError {
  constructor(fromState: string, toState: string) {
    super(`Cannot transition job from ${fromState} to ${toState}`, 'INVALID_STATE_TRANSITION');
    this.name = 'InvalidStateTransitionError';
  }
}

export class MediaCorruptedError extends NonRetryableError {
  constructor(message: string = 'The media file is invalid or corrupted') {
    super(message, 'CORRUPTED_MEDIA');
    this.name = 'MediaCorruptedError';
  }
}

export class JobCancelledError extends NonRetryableError {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled by user`, 'JOB_CANCELLED');
    this.name = 'JobCancelledError';
  }
}

export function classifyError(error: any): { isRetryable: boolean; errorCode: string; message: string } {
  if (error instanceof AppError) {
    return {
      isRetryable: error.isRetryable,
      errorCode: error.errorCode,
      message: error.message,
    };
  }

  const msg = String(error?.message || error || '');

  // Non-retryable heuristics
  if (
    msg.includes('Invalid data found when processing input') ||
    msg.includes('moov atom not found') ||
    msg.includes('EBADF') ||
    msg.includes('Unsupported codec') ||
    msg.includes('no such file or directory') ||
    msg.includes('INSUFFICIENT_CREDITS') ||
    msg.includes('INVALID_STATE_TRANSITION') ||
    msg.includes('JOB_CANCELLED')
  ) {
    return { isRetryable: false, errorCode: 'INVALID_INPUT', message: msg };
  }

  // Retryable transient conditions
  if (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('SIGKILL') ||
    msg.includes('SIGTERM') ||
    msg.includes('Connection terminated') ||
    msg.includes('Rate limit') ||
    msg.includes('socket hang up') ||
    msg.includes('Lock contention')
  ) {
    return { isRetryable: true, errorCode: 'TRANSIENT_NETWORK_OR_TIMEOUT', message: msg };
  }

  // Default to non-retryable to avoid infinite retry loops on developer bugs
  return { isRetryable: false, errorCode: 'UNHANDLED_EXCEPTION', message: msg };
}
