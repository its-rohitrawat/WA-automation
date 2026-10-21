import { listClients, type ClientRow } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { lastActivity } from '../store/messages.ts';
import { listPeople, type PersonRow } from '../store/people.ts';
import { listDecisions, listTasks, type DecisionRow, type TaskRow } from '../store/tasks.ts';
import { istDate } from '../util/time.ts';
import { uniqueSheetNames } from './sheetNames.ts';

export interface HealthLine {
  ok: boolean;
  text: string;
}

export interface ClientView {
  client: ClientRow;
  sheetName: string;
  usOpen: TaskRow[];
  clientOpen: TaskRow[];
  done: TaskRow[];
  decisions: DecisionRow[];
  people: PersonRow[];
  lastActivity: string | null;
  percentDone: number | null;
  overdue: number;
  maybeDone: number;
  nextDeadline: string | null;
}

export interface TrackerView {
  generatedAt: Date;
  today: string;
  health: HealthLine;
  clients: ClientView[];
}

export function isOverdue(t: TaskRow, today: string): boolean {
  return t.status !== 'done' && t.deadline !== null && t.deadline < today;
}

/** Inactive clients stay in the workbook, marked "(inactive)". */
export function loadTrackerView(db: Db, now: Date, health: HealthLine): TrackerView {
  const today = istDate(now);
  const clients = listClients(db, false);
  const names = uniqueSheetNames(clients.map((c) => c.name));
  return {
    generatedAt: now,
    today,
    health,
    clients: clients.map((client, i) => {
      const all = listTasks(db, client.id);
      const notDone = all.filter((t) => t.status !== 'done');
      const deadlines = notDone.map((t) => t.deadline).filter((d): d is string => d !== null).sort();
      return {
        client,
        sheetName: names[i]!,
        usOpen: notDone.filter((t) => t.side === 'us'),
        clientOpen: notDone.filter((t) => t.side === 'client'),
        done: all.filter((t) => t.status === 'done').reverse(),
        decisions: listDecisions(db, client.id),
        people: listPeople(db, client.id),
        lastActivity: lastActivity(db, client.id),
        percentDone: all.length ? Math.round((100 * (all.length - notDone.length)) / all.length) : null,
        overdue: notDone.filter((t) => isOverdue(t, today)).length,
        maybeDone: notDone.filter((t) => t.status === 'maybe_done').length,
        nextDeadline: deadlines[0] ?? null,
      };
    }),
  };
}
