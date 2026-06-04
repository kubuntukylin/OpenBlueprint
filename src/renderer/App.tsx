import { useEffect } from 'react'
import { useUIStore, useAgentStore, useGenerationStore } from './stores'
import { api } from './api'
import Sidebar from './Sidebar'
import ChatPanel from './ChatPanel'
import AgentGraph from './AgentGraph'
import ProcessPanel from './ProcessPanel'
import HelpPanel from './HelpPanel'
import SkillsPanel from './SkillsPanel'
import SettingsPanel from './SettingsPanel'
import StatusBar from './StatusBar'

const tabs = [
  { id: 'chat' as const, label: 'Chat', icon: '💬' },
  { id: 'skills' as const, label: 'Skills', icon: '📋' },
  { id: 'agents' as const, label: 'Agents', icon: '🔗' },
  { id: 'process' as const, label: 'Process', icon: '⚡' },
  { id: 'help' as const, label: 'Help', icon: '📖' },
]

export default function App() {
  const { activeTab, setActiveTab, settingsOpen, setSettingsOpen, theme } = useUIStore()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  // Track generation sessions at App level (survives tab switches)
  useEffect(() => {
    const gs = useGenerationStore.getState
    const agents = () => useAgentStore.getState().agents
    const u1 = api.on('generation:worker', (d: unknown) => {
      const msg = d as Record<string, unknown>
      const agentId = msg.agentId as string
      if (msg.type === 'progress') {
        const a = agents().find(x => x.id === agentId)
        const existing = gs().sessions[agentId]
        gs().upsertSession({ agentId, agentName: a?.name || agentId, startTime: existing?.startTime || Date.now(), status: 'generating', files: existing?.files || [] })
        const pt = `[${msg.phase}] ${msg.message}\n`
        gs().appendTerminalText(pt)
        gs().appendAgentTerminalText(agentId, pt)
      } else if (msg.type === 'terminal') {
        const tt = msg.text as string || ''
        gs().appendTerminalText(tt)
        gs().appendAgentTerminalText(agentId, tt)
      } else if (msg.type === 'file:generated') {
        const cur = gs().sessions[agentId]
        gs().updateSession(agentId, { files: [...(cur?.files || []), (msg.path as string).split('/').pop() || ''] })
      } else if (msg.type === 'result') {
        gs().updateSession(agentId, { status: msg.success ? 'completed' : 'failed', files: (msg.files as string[]) || [], error: (msg.error as string) || '' })
      }
    })
    const u2 = api.on('generation:done', (d: unknown) => {
      const msg = d as Record<string, unknown>
      gs().updateSession(msg.agentId as string, { status: (msg.status as 'completed'|'failed') || 'failed', error: (msg.error as string) || '' })
    })
    return () => { u1(); u2() }
  }, [])

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      <div className="flex-1 min-h-0 flex">
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab Bar */}
          <div className="h-9 border-b border-border flex items-center px-1 flex-shrink-0 bg-bg-secondary">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`h-8 px-4 text-[12px] font-medium border-b-2 transition-colors ${
                  activeTab === t.id
                    ? 'border-accent text-text'
                    : 'border-transparent text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <span className="mr-1.5">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          {/* Content — panels stay mounted, visibility controlled by CSS to preserve state */}
          <div className="flex-1 min-h-0">
            <div className={activeTab === 'chat' ? 'h-full' : 'hidden'}><ChatPanel /></div>
            <div className={activeTab === 'skills' ? 'h-full' : 'hidden'}><SkillsPanel /></div>
            <div className={activeTab === 'agents' ? 'h-full' : 'hidden'}><AgentGraph /></div>
            <div className={activeTab === 'process' ? 'h-full' : 'hidden'}><ProcessPanel /></div>
            <div className={activeTab === 'help' ? 'h-full' : 'hidden'}><HelpPanel /></div>
          </div>
        </div>
      </div>
      <StatusBar />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
