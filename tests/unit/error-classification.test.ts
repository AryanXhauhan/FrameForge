import { classifyError, RetryableError, NonRetryableError, InsufficientCreditsError } from '../../src/utils/errors';

describe('Error Classification Unit Tests', () => {
  test('correctly identifies explicit AppError subtypes', () => {
    const retryable = new RetryableError('Temporary network timeout');
    const nonRetryable = new InsufficientCreditsError();

    const class1 = classifyError(retryable);
    expect(class1.isRetryable).toBe(true);
    expect(class1.errorCode).toBe('TEMPORARY_FAILURE');

    const class2 = classifyError(nonRetryable);
    expect(class2.isRetryable).toBe(false);
    expect(class2.errorCode).toBe('INSUFFICIENT_CREDITS');
  });

  test('correctly classifies media corruption strings as non-retryable', () => {
    const err = new Error('Invalid data found when processing input');
    const result = classifyError(err);
    expect(result.isRetryable).toBe(false);
    expect(result.errorCode).toBe('INVALID_INPUT');
  });

  test('correctly classifies connection resets as retryable', () => {
    const err = new Error('read ECONNRESET');
    const result = classifyError(err);
    expect(result.isRetryable).toBe(true);
    expect(result.errorCode).toBe('TRANSIENT_NETWORK_OR_TIMEOUT');
  });
});
