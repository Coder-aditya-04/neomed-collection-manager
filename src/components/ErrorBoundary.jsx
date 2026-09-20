import { Component } from 'react';

/**
 * Keeps one broken screen from taking the whole app with it.
 *
 * Without this, any error thrown during render unmounts the entire tree and
 * React leaves #root empty — the app becomes a blank dark page with no
 * message, no navigation and nothing to act on. That is the worst possible
 * failure for someone mid-call with a customer: it looks like the product is
 * gone rather than like one panel is unhappy.
 *
 * So the error is caught, named, and shown in place. The sidebar keeps
 * working, every other screen keeps working, and the message says what broke
 * instead of making somebody open the browser console to find out.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Still worth the console: the stack is the only place the component
    // trail survives, and support may ask for it.
    console.error('Screen failed to render:', error, info?.componentStack);
  }

  /*
   * Navigating away should clear the error. Without this the boundary keeps
   * showing the old failure after the user has already moved to a screen that
   * works, and the app appears permanently broken.
   */
  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="animate-screen-in px-[18px] pt-4">
        <div className="panel border-l-[3px] border-l-age-3 p-[16px]">
          <h2 className="text-[14px] font-semibold">This screen could not be drawn</h2>
          <p className="mt-2 max-w-[80ch] text-[12.5px] text-pretty text-mute">
            The rest of the app is still working — pick another screen from the sidebar.
            If it keeps happening, send this line to whoever maintains the system.
          </p>
          <pre className="mt-3 overflow-auto whitespace-pre-wrap border border-hair bg-surface-2 p-[10px] font-mono text-[11.5px]">
            {String(error?.message || error)}
          </pre>
          <button type="button" className="btn btn-secondary mt-3" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
      </div>
    );
  }
}
