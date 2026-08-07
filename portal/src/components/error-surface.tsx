import actionLinkStyles from './ui/action-link.module.css';
import { StatusSurface } from './ui/status-surface';

/**
 * Global error-boundary surface (docs/29 §7). Used by both the top-level
 * React error boundary and the router's route-error element, so every
 * unexpected failure lands on the same calm, recoverable state. Uses a plain
 * anchor: the top-level boundary may render with no router available.
 */
export function ErrorSurface() {
  return (
    <StatusSurface
      title="Something went wrong"
      actions={
        <a className={actionLinkStyles.actionLink} href="/">
          Go to the portal
        </a>
      }
    >
      <p>
        The portal hit an unexpected problem. Try again — and if it keeps happening, contact
        Himma support.
      </p>
    </StatusSurface>
  );
}
