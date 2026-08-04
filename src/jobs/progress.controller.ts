import { Controller, MessageEvent, Param, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { from, interval, merge, Observable } from 'rxjs';
import { auditTime, concatMap, filter, map } from 'rxjs/operators';
import { JobsService } from './jobs.service';
import { toJobDto } from './jobs.controller';
import { EventBusService } from '../events/event-bus.service';

const HEARTBEAT_MS = 15_000;

@ApiTags('jobs')
@Controller('projects/:projectId/events')
export class ProgressController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly eventBus: EventBusService,
  ) {}

  @Sse()
  stream(@Param('projectId') projectId: string): Observable<MessageEvent> {
    const snapshot$ = this.fetchEvent(projectId, 'snapshot');

    const live$ = this.eventBus.onAny().pipe(
      filter((event) => event.projectId === projectId),
      auditTime(250),
      concatMap(() => this.fetchEvent(projectId, 'progress')),
    );

    const heartbeat$ = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: '' })),
    );

    return merge(snapshot$, live$, heartbeat$);
  }

  private fetchEvent(projectId: string, liveLabel: 'snapshot' | 'progress'): Observable<MessageEvent> {
    return from(this.jobsService.findLatest(projectId)).pipe(
      map((job): MessageEvent => {
        const type =
          liveLabel === 'snapshot' ? 'snapshot' : job && isTerminal(job.status) ? 'done' : 'progress';
        return { type, data: { job: job ? toJobDto(job) : null } };
      }),
    );
  }
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}
