import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { AppEvent } from './event.types';

@Injectable()
export class EventBusService {
  private readonly subject = new Subject<AppEvent>();

  emit(event: AppEvent): void {
    this.subject.next(event);
  }

  on<T extends AppEvent['type']>(type: T): Observable<Extract<AppEvent, { type: T }>> {
    return this.subject.pipe(
      filter((event): event is Extract<AppEvent, { type: T }> => event.type === type),
    );
  }

  onAny(): Observable<AppEvent> {
    return this.subject.asObservable();
  }
}
