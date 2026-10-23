import { JobStateMachine } from '../../src/services/job-state-machine';
import { JobStatus } from '@prisma/client';
import { InvalidStateTransitionError } from '../../src/utils/errors';

describe('JobStateMachine Unit Tests', () => {
  test('allows valid forward transitions: QUEUED -> PROCESSING -> COMPLETED', () => {
    expect(JobStateMachine.canTransition(JobStatus.QUEUED, JobStatus.PROCESSING)).toBe(true);
    expect(JobStateMachine.canTransition(JobStatus.PROCESSING, JobStatus.COMPLETED)).toBe(true);
  });

  test('allows failure and retry transitions: PROCESSING -> RETRYING -> PROCESSING', () => {
    expect(JobStateMachine.canTransition(JobStatus.PROCESSING, JobStatus.RETRYING)).toBe(true);
    expect(JobStateMachine.canTransition(JobStatus.RETRYING, JobStatus.PROCESSING)).toBe(true);
  });

  test('allows cancellation from QUEUED or PROCESSING', () => {
    expect(JobStateMachine.canTransition(JobStatus.QUEUED, JobStatus.CANCELLED)).toBe(true);
    expect(JobStateMachine.canTransition(JobStatus.PROCESSING, JobStatus.CANCELLING)).toBe(true);
    expect(JobStateMachine.canTransition(JobStatus.CANCELLING, JobStatus.CANCELLED)).toBe(true);
  });

  test('strictly forbids invalid transitions from terminal COMPLETED', () => {
    expect(JobStateMachine.canTransition(JobStatus.COMPLETED, JobStatus.PROCESSING)).toBe(false);
    expect(JobStateMachine.canTransition(JobStatus.COMPLETED, JobStatus.QUEUED)).toBe(false);
    expect(JobStateMachine.canTransition(JobStatus.COMPLETED, JobStatus.CANCELLED)).toBe(false);

    expect(() => {
      JobStateMachine.validateTransition(JobStatus.COMPLETED, JobStatus.PROCESSING);
    }).toThrow(InvalidStateTransitionError);
  });

  test('identifies terminal states accurately', () => {
    expect(JobStateMachine.isTerminal(JobStatus.COMPLETED)).toBe(true);
    expect(JobStateMachine.isTerminal(JobStatus.FAILED)).toBe(true);
    expect(JobStateMachine.isTerminal(JobStatus.CANCELLED)).toBe(true);
    expect(JobStateMachine.isTerminal(JobStatus.PROCESSING)).toBe(false);
    expect(JobStateMachine.isTerminal(JobStatus.QUEUED)).toBe(false);
  });
});
