/**
 * Transaction helper (docs/25 §6; boundary rules docs/24 §7).
 *
 * - One PostgreSQL transaction per call; rolled back completely when the
 *   callback throws (Kysely guarantees rollback on throw).
 * - No network calls inside a transaction — the callback must stay on the
 *   database (docs/24 §7: gateway/external calls happen BETWEEN transactions).
 * - Errors crossing this boundary are translated to typed DbError values.
 */
import type { IsolationLevel, Transaction } from 'kysely';

import { translateDbError } from './errors';
import type { DB, Db } from './kysely';

export type Trx = Transaction<DB>;

export interface TransactionOptions {
  isolation?: IsolationLevel;
}

export async function withTransaction<T>(
  db: Db,
  fn: (trx: Trx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  let builder = db.transaction();
  if (options.isolation !== undefined) {
    builder = builder.setIsolationLevel(options.isolation);
  }
  try {
    return await builder.execute(fn);
  } catch (error) {
    throw translateDbError(error);
  }
}
