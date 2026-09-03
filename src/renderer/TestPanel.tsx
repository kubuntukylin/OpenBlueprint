// Test Results Panel — shows per-agent test status, failures, fix history
import { useEffect, useState } from 'react'
import { useAgentStore, useProjectStore, useGenerationStore, useNotificationStore } from './stores'
import { api } from './api'

interface TestResult {
  id: string; agent_id: string; session_id: string; phase: string
  status: 'passed' | 'failed' | 'error' | 'pending' | 'running'
  summary_json: string; failures_json: string; logs: string
  duration_ms: number; fix_attempts: number
}

interface TestSession {
  currentPhase: string; message: string
}

const CATEGORY_COLORS: Record<string, string> = {
  compilation: 'text-red-400 bg-red-500/10',
  assertion: 'text-orange-400 bg-orange-500/10',
  timeout: 'text-yellow-400 bg-yellow-500/10',
  runtime: 'text-purple-400 bg-purple-500/10',
  missing_dep: 'text-cyan-400 bg-cyan-500/10',
  unknown: 'text-gray-400 bg-gray-500/10',
}

export default function TestPanel() {
  const agents = useAgentStore(s => s.agents)
  const activeProjectId = useProjectStore(s => s.activeProjectId)
  const [results, setResults] = useState<Record<string, TestResult[]>>({})
  const [sessions, setSessions] = useState<Record<string, TestSession>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const addToast = useNotificationStore(s => s.addToast)

  const projectAgents = activeProjectId ? agents.filter(a => a.projectId === activeProjectId) : agents

  // Load test results for all agents
  useEffect(() => {
    for (const a of projectAgents) {
      api.get<TestResult[]>('/api/agents/' + a.id + '/test-results').then(r => {
        setResults(prev => ({ ...prev, [a.id]: r }))
      }).catch(() => {})
    }
  }, [projectAgents])

  // Listen for real-time test events
  useEffect(() => {
    const u1 = api.on('test:progress', (d: unknown) => {
      const m = d as { agentId: string; phase: string; message: string }
      setSessions(prev => ({ ...prev, [m.agentId]: { currentPhase: m.phase, message: m.message } }))
    })
    const u2 = api.on('test:result', (d: unknown) => {
      const m = d as { agentId: string; phase: string; status: string; summary: Record<string,number>; failures: unknown[] }
      const agentId = m.agentId
      api.get<TestResult[]>('/api/agents/' + agentId + '/test-results').then(r => {
        setResults(prev => ({ ...prev, [agentId]: r }))
      }).catch(() => {})
      setSessions(prev => { const n = { ...prev }; delete n[agentId]; return n })
    })
    const u3 = api.on('test:fix-attempt', (d: unknown) => {
      const m = d as { agentId: string; attempt: number; maxAttempts: number }
      setSessions(prev => ({ ...prev, [m.agentId]: { currentPhase: 'fix', message: `Fix attempt ${m.attempt}/${m.maxAttempts}` } }))
    })
    const u4 = api.on('test:fix-result', (d: unknown) => {
      const m = d as { agentId: string; attempt: number; status: string }
      if (m.status === 'passed') {
        setSessions(prev => { const n = { ...prev }; delete n[m.agentId]; return n })
      }
    })
    const u5 = api.on('test:escalated', (d: unknown) => {
      const m = d as { agentId: string; reason: string }
      addToast({ type: 'error', message: `Tests for agent escalated: ${m.reason}`, duration: 0 })
      setSessions(prev => { const n = { ...prev }; delete n[m.agentId]; return n })
    })
    return () => { u1(); u2(); u3(); u4(); u5() }
  }, [])

  const retryTests = async (agentId: string) => {
    try {
      await api.post<{ sessionId: string }>('/api/agents/' + agentId + '/retry-tests', {})
      addToast({ type: 'info', message: 'Tests restarted', duration: 3000 })
    } catch (e) {
      addToast({ type: 'error', message: 'Failed to retry: ' + (e as Error).message, duration: 5000 })
    }
  }

  if (projectAgents.length === 0) {
    return <div className="h-full flex items-center justify-center bg-[#0d1117]"><p className="text-gray-500 text-sm">No agents to test</p></div>
  }

  return (
    <div className="h-full flex flex-col bg-[#0d1117]">
      <div className="px-4 py-3 border-b border-[#2d3348] flex items-center justify-between flex-shrink-0">
        <h3 className="text-sm font-semibold text-white">Test Results</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-[11px] uppercase tracking-wider border-b border-[#2d3348]">
              <th className="pb-2 pr-2">Agent</th>
              <th className="pb-2 pr-2">Status</th>
              <th className="pb-2 pr-2">Tests</th>
              <th className="pb-2 pr-2">Duration</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {projectAgents.map(a => {
              const agentResults = results[a.id] || []
              const latest = agentResults[0]
              const session = sessions[a.id]
              let statusIcon = '⏳'
              let statusColor = 'text-gray-500'
              if (session) {
                statusIcon = '🔧'; statusColor = 'text-yellow-400'
              } else if (latest) {
                if (latest.status === 'passed') { statusIcon = '✅'; statusColor = 'text-green-400' }
                else if (latest.status === 'failed' || latest.status === 'error') { statusIcon = '❌'; statusColor = 'text-red-400' }
              } else if (a.status === 'validating') {
                statusIcon = '🔄'; statusColor = 'text-blue-400'
              }
              const summary = latest ? JSON.parse(latest.summary_json || '{}') : {}
              const failures = latest ? JSON.parse(latest.failures_json || '[]') : []
              const isExpanded = expanded === a.id

              return (
                <tbody key={a.id}>
                  <tr className={`border-b border-[#2d3348]/50 cursor-pointer hover:bg-white/[0.02] ${isExpanded ? 'bg-white/[0.03]' : ''}`}
                    onClick={() => setExpanded(isExpanded ? null : a.id)}>
                    <td className="py-2 pr-2 text-white">{a.name}</td>
                    <td className="py-2 pr-2"><span className={statusColor}>{statusIcon}</span> {session?.currentPhase || latest?.status || a.status}</td>
                    <td className="py-2 pr-2 text-gray-400">{summary.total ? `${summary.passed || 0}/${summary.total}` : '-'}</td>
                    <td className="py-2 pr-2 text-gray-500">{latest?.duration_ms ? `${(latest.duration_ms / 1000).toFixed(1)}s` : '-'}</td>
                    <td className="py-2 text-right">
                      <button onClick={e => { e.stopPropagation(); retryTests(a.id) }}
                        className="text-[10px] px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded border border-blue-500/20 hover:bg-blue-500/20">
                        Retry
                      </button>
                    </td>
                  </tr>
                  {isExpanded && failures.length > 0 && (
                    <tr>
                      <td colSpan={5} className="pb-3 pl-6">
                        <div className="space-y-1">
                          {failures.map((f: { file: string; line: number; message: string; category: string }, i: number) => (
                            <div key={i} className="text-[11px] py-1.5 px-2 rounded bg-[#1a1d2e] border border-[#2d3348]">
                              <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${CATEGORY_COLORS[f.category] || 'text-gray-400'}`}>
                                {f.category}
                              </span>
                              <span className="text-blue-400 ml-2 font-mono">{f.file}{f.line ? `:${f.line}` : ''}</span>
                              <p className="text-gray-400 mt-1 ml-1">{f.message.slice(0, 200)}</p>
                            </div>
                          ))}
                          {latest?.fix_attempts > 0 && (
                            <p className="text-[10px] text-gray-500 mt-1">Fix attempts: {latest.fix_attempts}</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
