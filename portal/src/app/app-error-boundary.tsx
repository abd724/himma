import { Component, type ReactNode } from 'react';
import { ErrorSurface } from '../components/error-surface';

/**
 * Top-level error boundary: the last line between an unexpected render
 * failure and a blank page. Route-level errors are handled by the router's
 * errorElement with the same surface.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return <ErrorSurface />;
    }
    return this.props.children;
  }
}
