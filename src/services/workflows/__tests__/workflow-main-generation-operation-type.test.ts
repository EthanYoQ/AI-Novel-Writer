import { expect, it } from 'vitest'
import type { WorkflowMainGenerationSelection } from '../workflow-main-generation'

type Operation = WorkflowMainGenerationSelection['operation']

it('accepts only operations registered in the stage table (checked by tsc)', () => {
  const registered: Operation[] = ['review-chapter', 'chapter-blueprint-directory', 'generate-field:core-outline']
  // @ts-expect-error 未登记的 operation 必须先写进 src/shared/model-stage-routing.ts 的表
  const unregistered: Operation = 'made-up-operation'
  expect([...registered, unregistered]).toHaveLength(4)
})
