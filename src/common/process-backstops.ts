import { Logger } from '@nestjs/common';

/**
 * The two process-level backstops for fire-and-forget background work.
 *
 * Node's default for either channel is to print the error and **exit**. That is
 * the right default for a request-scoped server behind a supervisor; it is the
 * wrong one for a single-user local tool whose background pollers (`jobs/`) and
 * event-bus subscribers (`events/`) can hit a transient DB blip and would
 * otherwise take the whole API down with them.
 *
 * Both channels are covered deliberately, and they are siblings:
 *
 * - `unhandledRejection` — a `void`-ed async call that rejects. Every such
 *   caller is expected to catch its own errors; this covers the missed one.
 * - `uncaughtException` — the synchronous twin, and the one that was missing
 *   (DEF-007). `EventBusService` is a bare rxjs `Subject`, and rxjs does not
 *   hand a throwing subscriber's error back to the emitter: it calls
 *   `reportUnhandledError`, which re-throws it on a macro task, i.e. here.
 *   One synchronous `throw` in any subscriber was one exiting process.
 *
 * The trade-off is explicit: swallowing `uncaughtException` keeps a process
 * alive whose state may be inconsistent. For this application that is better
 * than exiting mid-index, and it matches the judgement already made for
 * `unhandledRejection` — the asymmetry was the bug, not the policy.
 *
 * Extracted from `main.ts` so it can be tested at all; `main.ts` boots the whole
 * application on import, so nothing in it was reachable from a unit test.
 */
export function installProcessBackstops(
  logger: Pick<Logger, 'error'> = new Logger('Process'),
): void {
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    );
  });

  process.on('uncaughtException', (err: unknown) => {
    logger.error(
      `Uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  });
}
