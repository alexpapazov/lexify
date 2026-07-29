import { createClient } from '@/lib/supabase/client'
import { cachedRead } from '@/lib/readCache'
import type { Pipeline, PipelineStep, UserId } from '@/domain'
import type { PipelineRepository } from './interfaces'

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'

function rowsToPipeline(p: Record<string, unknown>, steps: Record<string, unknown>[]): Pipeline {
  return {
    id:        p.id as string,
    ownerId:   p.owner_id as string | null,
    name:      p.name as string,
    isDefault: p.is_default as boolean,
    steps: steps.map(s => ({
      pipelineId:      s.pipeline_id as string,
      stepOrder:       s.step_order as number,
      stepType:        s.step_type as PipelineStep['stepType'],
      promptSide:      s.prompt_side as PipelineStep['promptSide'],
      answerSide:      s.answer_side as PipelineStep['answerSide'],
      requiredCorrect: s.required_correct as number,
    })).sort((a, b) => a.stepOrder - b.stepOrder),
  }
}

export class SupabasePipelineRepository implements PipelineRepository {
  private get db() { return createClient() }

  async getDefault(): Promise<Pipeline> {
    // The default pipeline is global, effectively static config — safe to serve from the short cache.
    const result = await cachedRead('pipeline:default', () => this.get(DEFAULT_PIPELINE_ID))
    if (!result) throw new Error('Default pipeline not found — did the migration run?')
    return result
  }

  async list(userId: UserId): Promise<Pipeline[]> {
    const { data, error } = await this.db.from('pipelines')
      .select('*, pipeline_steps(*)')
      .or(`owner_id.is.null,owner_id.eq.${userId}`)
      .is('deleted_at', null)
    if (error) throw new Error(error.message)
    return (data ?? []).map(row => rowsToPipeline(row as Record<string, unknown>, (row.pipeline_steps as Record<string, unknown>[]) ?? []))
  }

  async get(pipelineId: string): Promise<Pipeline | null> {
    const { data, error } = await this.db.from('pipelines')
      .select('*, pipeline_steps(*)')
      .eq('id', pipelineId).single()
    if (error) return null
    return rowsToPipeline(data as Record<string, unknown>, (data.pipeline_steps as Record<string, unknown>[]) ?? [])
  }
}
