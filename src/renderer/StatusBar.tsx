import { useEffect, useState } from 'react'
import { api } from './api'
import { useUIStore } from './stores'
import { APP_NAME } from '../shared/constants'

export default function StatusBar() {
  const [info, setInfo] = useState({ provider: '', model: '', hasKey: false, loaded: false })
  const [skillStats, setSkillStats] = useState({ total: 0, active: 0 })
  const setActiveTab = useUIStore(s => s.setActiveTab)

  useEffect(() => {
    api.llm.list().then(configs => {
      const d = configs.find((c: Record<string,unknown>) => (c.isDefault || c.is_default) === 1) || configs[0]
      if (d) setInfo({ provider: (d.provider as string) || '', model: ((d.modelName || d.model_name) as string) || '', hasKey: !!((d.apiKey || d.api_key) as string), loaded: true })
      else setInfo(p => ({ ...p, loaded: true }))
    }).catch(() => setInfo(p => ({ ...p, loaded: true })))
  }, [])

  useEffect(() => {
    api.get<Record<string,unknown>[]>('/api/skills').then(skills => {
      const active = skills.filter((s: Record<string,unknown>) => (s.isActive !== undefined ? s.isActive : s.is_active) !== 0).length
      setSkillStats({ total: skills.length, active })
    }).catch(() => {})
  }, [])

  return (
    <div className="h-6 bg-bg-secondary border-t border-border flex items-center px-3 text-[11px] flex-shrink-0 select-none">
      <div className="flex items-center gap-1.5 text-text-secondary">
        <span className={`w-1.5 h-1.5 rounded-full ${info.loaded ? (info.hasKey ? 'bg-success' : 'bg-warning') : 'bg-text-tertiary'}`} />
        {info.loaded ? (
          <span>{info.provider} <span className="text-text-tertiary">{info.model}</span></span>
        ) : (
          <span className="text-text-tertiary">Loading...</span>
        )}
      </div>
      <div className="flex-1" />
      {skillStats.total > 0 && (
        <button onClick={() => setActiveTab('skills')}
          className="flex items-center gap-2 text-text-secondary hover:text-text transition-colors mr-3">
          <span>Skills</span>
          <span className="text-success">{skillStats.active} on</span>
          <span className="text-text-tertiary">/</span>
          <span className="text-text-tertiary">{skillStats.total - skillStats.active} off</span>
        </button>
      )}
      <span className="text-text-tertiary">{APP_NAME}</span>
    </div>
  )
}
