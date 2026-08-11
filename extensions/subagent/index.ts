import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_wait', 'subagent_supervisor', 'intercom'])

export default function lazySubagents(pi: ExtensionAPI) {
  let subagentsLoaded = false

  const hideSubagents = () => {
    if (subagentsLoaded) return
    pi.setActiveTools(pi.getActiveTools().filter((name) => !SUBAGENT_TOOLS.has(name)))
  }

  pi.registerTool({
    name: 'load_subagents',
    label: 'Load Subagents',
    description: 'Enable subagent orchestration tools for this session',
    parameters: Type.Object({}),
    async execute() {
      subagentsLoaded = true
      const available = new Set(pi.getAllTools().map(({ name }) => name))
      const tools = [...SUBAGENT_TOOLS].filter((name) => available.has(name))
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...tools])])

      return {
        content: [{ type: 'text', text: `Loaded tools: ${tools.join(', ')}` }],
        details: { tools },
      }
    },
  })

  pi.on('session_start', () => {
    subagentsLoaded = false
    hideSubagents()
    queueMicrotask(hideSubagents)
  })

  pi.on('before_agent_start', hideSubagents)
}
