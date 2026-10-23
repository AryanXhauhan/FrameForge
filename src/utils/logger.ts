export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogContext {
  jobId?: string;
  userId?: string;
  projectId?: string;
  stage?: string;
  [key: string]: any;
}

export class Logger {
  constructor(private context: string = 'System') {}

  private format(level: LogLevel, message: string, ctx?: LogContext): string {
    const timestamp = new Date().toISOString();
    const ctxString = ctx && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : '';
    return `[${timestamp}] [${level}] [${this.context}] ${message}${ctxString}`;
  }

  info(message: string, ctx?: LogContext): void {
    console.log(this.format('INFO', message, ctx));
  }

  warn(message: string, ctx?: LogContext): void {
    console.warn(this.format('WARN', message, ctx));
  }

  error(message: string, error?: any, ctx?: LogContext): void {
    const errorDetails = error instanceof Error ? { errorName: error.name, errorMessage: error.message, stack: error.stack } : { rawError: error };
    console.error(this.format('ERROR', message, { ...ctx, ...errorDetails }));
  }

  debug(message: string, ctx?: LogContext): void {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(this.format('DEBUG', message, ctx));
    }
  }

  child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`);
  }
}

export const appLogger = new Logger('App');
