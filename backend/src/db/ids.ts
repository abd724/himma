/**
 * Opaque identifier generation (docs/24 §6.12).
 *
 * UUIDv7: time-ordered for index locality, with 74 random bits — opaque and
 * non-enumerable. Customer-facing reference codes (later slices) are separate
 * random codes, never derived from ids.
 */
import { v7 as uuidv7, validate as uuidValidate } from 'uuid';

export type Id = string;

export function newId(): Id {
  return uuidv7();
}

export function isId(value: string): boolean {
  return uuidValidate(value);
}
