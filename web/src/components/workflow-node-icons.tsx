import type { ReactNode } from 'react'
import { Activity, Boxes, Bot, CheckCircle2, ClipboardList, Clock, FileInput, GitBranch, Layers3, Mail, Plug, Radio, Sparkles, SquarePlus, Users, Workflow } from 'lucide-react'

const nodeIcons: Record<string, ReactNode> = {
  http: <Activity size={15} />,
  noop: <SquarePlus size={15} />,
  transform: <GitBranch size={15} />,
  loop: <Workflow size={15} />,
  condition: <CheckCircle2 size={15} />,
  webhook: <Activity size={15} />,
  schedule: <Clock size={15} />,
  approval: <Users size={15} />,
  human_form: <ClipboardList size={15} />,
  ai: <Sparkles size={15} />,
  tool: <Boxes size={15} />,
  mcp_tool: <Plug size={15} />,
  agent: <Bot size={15} />,
  agent_reflection: <Activity size={15} />,
  multi_agent: <Layers3 size={15} />,
  router: <GitBranch size={15} />,
  router_llm: <Sparkles size={15} />,
  webhook_received: <Activity size={15} />,
  email_received: <Mail size={15} />,
  file_dropped: <FileInput size={15} />,
  mcp_server_event: <Radio size={15} />,
}

/** Icon for a workflow step type, shared by the canvas and the recipe cards. */
export function workflowNodeIcon(type: string): ReactNode {
  return nodeIcons[type] ?? <SquarePlus size={15} />
}
