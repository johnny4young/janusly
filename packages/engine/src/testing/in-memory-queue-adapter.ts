import type {
  EnqueueNodeInput,
  QueueAdapter,
  TerminalFailureInput,
} from "../core/types";
import { InMemoryExecutionStore } from "./in-memory-execution-store";

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

/** Queue/DLQ test adapter that records publications and commits failures into the in-memory store. */
export class InMemoryQueueAdapter implements QueueAdapter {
  private readonly pendingPublications: EnqueueNodeInput[] = [];
  private readonly publicationLog: EnqueueNodeInput[] = [];
  private readonly terminalFailureLog: TerminalFailureInput[] = [];

  constructor(private readonly store: InMemoryExecutionStore) {}

  async enqueueNode(input: EnqueueNodeInput): Promise<void> {
    this.pendingPublications.push(cloneValue(input));
    this.publicationLog.push(cloneValue(input));
  }

  async persistTerminalFailure(input: TerminalFailureInput): Promise<boolean> {
    const persisted = await this.store.persistTerminalFailure(input);
    if (persisted) this.terminalFailureLog.push(cloneValue(input));
    return persisted;
  }

  takeNext(): EnqueueNodeInput | null {
    const next = this.pendingPublications.shift();
    return next ? cloneValue(next) : null;
  }

  listEnqueued(): EnqueueNodeInput[] {
    return this.publicationLog.map((input) => cloneValue(input));
  }

  listPending(): EnqueueNodeInput[] {
    return this.pendingPublications.map((input) => cloneValue(input));
  }

  listTerminalFailures(): TerminalFailureInput[] {
    return this.terminalFailureLog.map((input) => cloneValue(input));
  }
}
