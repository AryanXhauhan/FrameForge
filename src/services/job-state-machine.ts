import { JobStatus } from '@prisma/client';
import { InvalidStateTransitionError } from '../utils/errors';

export const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  [JobStatus.QUEUED]: [
    JobStatus.PROCESSING,
    JobStatus.CANCELLED,
    JobStatus.FAILED,
  ],
  [JobStatus.PROCESSING]: [
    JobStatus.PROCESSING, // stage / progress updates
    JobStatus.COMPLETED,
    JobStatus.RETRYING,
    JobStatus.FAILED,
    JobStatus.CANCELLING,
    JobStatus.CANCELLED,
  ],
  [JobStatus.RETRYING]: [
    JobStatus.PROCESSING,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
  ],
  [JobStatus.CANCELLING]: [
    JobStatus.CANCELLED,
    JobStatus.FAILED, // if cancellation cleanup errors out
  ],
  [JobStatus.COMPLETED]: [], // Terminal
  [JobStatus.FAILED]: [
    JobStatus.QUEUED, // Manual retry endpoint explicitly re-queues
  ],
  [JobStatus.CANCELLED]: [], // Terminal
};

export class JobStateMachine {
  public static canTransition(from: JobStatus, to: JobStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed) return false;
    return allowed.includes(to);
  }

  public static validateTransition(from: JobStatus, to: JobStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError(from, to);
    }
  }

  public static isTerminal(status: JobStatus): boolean {
    const terminalStates: JobStatus[] = [JobStatus.COMPLETED, JobStatus.CANCELLED, JobStatus.FAILED];
    return terminalStates.includes(status);
  }
}
