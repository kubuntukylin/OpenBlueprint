// Error Boundary — catches render errors in child panels, shows fallback with retry
import React from 'react'

interface Props { children: React.ReactNode; fallback: React.ReactNode }
interface State { hasError: boolean; error?: Error }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('[ErrorBoundary]', error, info) }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="h-full flex items-center justify-center bg-[#0d1117]">
          <div className="text-center">
            <h3 className="text-lg text-red-400 mb-2">Something went wrong</h3>
            <p className="text-sm text-gray-400 mb-4">{this.state.error?.message}</p>
            <button onClick={() => this.setState({ hasError: false })}
              className="px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg text-sm border border-blue-500/20 hover:bg-blue-500/30">
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
