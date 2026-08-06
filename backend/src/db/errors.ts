/**
 * Database error translation boundary (docs/25 §7).
 *
 * PostgreSQL driver errors are translated to typed DbError values at the
 * database boundary; nothing above the db layer branches on raw SQLSTATE
 * codes. The API layer later maps DbError kinds to the docs/24 §11 typed
 * error vocabulary.
 */
export type DbErrorKind =
  | 'uniqueViolation'
  | 'checkViolation'
  | 'foreignKeyViolation'
  | 'notNullViolation'
  | 'serializationFailure'
  | 'deadlockDetected'
  | 'insufficientPrivilege'
  | 'raisedException'
  | 'unknown';

const SQLSTATE_TO_KIND: Record<string, DbErrorKind> = {
  '23505': 'uniqueViolation',
  '23514': 'checkViolation',
  '23503': 'foreignKeyViolation',
  '23502': 'notNullViolation',
  '40001': 'serializationFailure',
  '40P01': 'deadlockDetected',
  '42501': 'insufficientPrivilege',
  P0001: 'raisedException',
};

interface PgErrorLike {
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  message: string;
}

export class DbError extends Error {
  readonly kind: DbErrorKind;
  readonly code: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;

  constructor(kind: DbErrorKind, pgError: PgErrorLike) {
    super(`[${kind}] ${pgError.message}`);
    this.name = 'DbError';
    this.kind = kind;
    this.code = pgError.code ?? 'unknown';
    if (pgError.constraint !== undefined) this.constraint = pgError.constraint;
    if (pgError.table !== undefined) this.table = pgError.table;
    if (pgError.column !== undefined) this.column = pgError.column;
    this.cause = pgError;
  }
}

function isPgErrorLike(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    'message' in error
  );
}

/** Translates a PostgreSQL error; returns the input unchanged when it is not one. */
export function translateDbError(error: unknown): unknown {
  if (error instanceof DbError) return error;
  if (!isPgErrorLike(error)) return error;
  const code = error.code ?? '';
  const kind =
    SQLSTATE_TO_KIND[code] ??
    // Class 23 = integrity constraint violation; unmapped members stay typed.
    (code.startsWith('23') ? 'checkViolation' : undefined);
  if (kind === undefined) {
    // A pg error we do not classify yet — still surface it as a DbError so
    // callers have one boundary type, with kind 'unknown'.
    return new DbError('unknown', error);
  }
  return new DbError(kind, error);
}

export function isDbError(error: unknown, kind?: DbErrorKind): error is DbError {
  if (!(error instanceof DbError)) return false;
  return kind === undefined || error.kind === kind;
}
