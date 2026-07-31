/**
 * lib/agents/anthropic.ts — minimal typings for the Anthropic Messages API
 * tool-use loop (we call the REST endpoint via fetch, no SDK). Only the shapes
 * the runner needs are modelled.
 */

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type ContentBlock = TextBlock | ToolUseBlock

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

interface AssistantMessage { role: 'assistant'; content: ContentBlock[] }
interface UserMessage { role: 'user'; content: string | ToolResultBlock[] }
export type Message = AssistantMessage | UserMessage

export interface ModelResponse {
  content: ContentBlock[]
  stop_reason: string | null
}

/** A function that runs one Anthropic turn — injected so the runner is transport-agnostic and testable. */
export type CallModel = (messages: Message[]) => Promise<ModelResponse>
