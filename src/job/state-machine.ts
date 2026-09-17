import { ALLOWED_TRANSITIONS } from "./types.js";
import type { JobStatus } from "./types.js";

export class InvalidStateTransitionError extends Error {
  public readonly code = "INVALID_STATE_TRANSITION";
  constructor(
    public readonly currentStatus: JobStatus,
    public readonly targetStatus: JobStatus,
    message?: string,
  ) {
    super(
      message ??
        `Invalid transition from ${currentStatus} to ${targetStatus}`,
    );
    this.name = "InvalidStateTransitionError";
  }
}

export class JobStateMachine {
  static canTransition(from: JobStatus, to: JobStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  static validateTransition(from: JobStatus, to: JobStatus): void {
    if (!JobStateMachine.canTransition(from, to)) {
      throw new InvalidStateTransitionError(from, to);
    }
  }

  static calculateDuration(
    lastTransitionTimestamp: string,
    nowTimestamp: string,
  ): number {
    const start = Date.parse(lastTransitionTimestamp);
    const end = Date.parse(nowTimestamp);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return 0;
    }
    return Math.max(0, end - start);
  }
}