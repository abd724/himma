import { useLocation } from 'react-router-dom';
import { safeReturnTo } from '../../auth/return-to';

/**
 * Access-zone navigation helpers: the validated internal destination a
 * completed sign-in/MFA/step-up should land on. `/` lets the protected zone
 * pick the first accessible workspace.
 */
export function useReturnTo(): string | null {
  const location = useLocation();
  return safeReturnTo(new URLSearchParams(location.search).get('returnTo'));
}

export function accessDestination(returnTo: string | null): string {
  return returnTo ?? '/';
}

export function withReturnTo(path: string, returnTo: string | null): string {
  return returnTo ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path;
}
