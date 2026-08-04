export interface JobCreatedEvent {
  type: 'job.created';
  projectId: string;
  jobId: string;
}

export interface JobProgressEvent {
  type: 'job.progress';
  projectId: string;
  jobId: string;
}

export interface JobCompletedEvent {
  type: 'job.completed';
  projectId: string;
  jobId: string;
}

export type AppEvent = JobCreatedEvent | JobProgressEvent | JobCompletedEvent;
