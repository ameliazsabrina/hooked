import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Last-line catch so a render throw never leaves the user on a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    console.error("[error-boundary] uncaught render error:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          background: "#0b1e36",
          color: "#f5faff",
          fontFamily: "'VT323', sans-serif",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 28, color: "#ffe066" }}>
          Something went wrong.
        </div>
        <div style={{ maxWidth: 480, opacity: 0.8 }}>
          {this.state.error.message || "Unknown error"}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 20px",
            background: "#2a7a8a",
            color: "#f5faff",
            border: "1px solid #4fd4d4",
            borderRadius: 4,
            fontFamily: "inherit",
            fontSize: 18,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
