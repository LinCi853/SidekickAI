// installer-tauri/src/components/StepProgress.tsx
// 左侧品牌区竖向步骤条

import type { StepId } from '../types'

export interface StepProgressProps {
  steps: { id: StepId; label: string }[]
  currentIndex: number
}

export default function StepProgress({ steps, currentIndex }: StepProgressProps) {
  return (
    <div className="steps">
      {steps.map((s, i) => {
        const cls = i === currentIndex ? 'step step--active' : i < currentIndex ? 'step step--done' : 'step'
        return (
          <div key={s.id + s.label} className={cls}>
            <div className="step__dot">{i < currentIndex ? '✓' : i + 1}</div>
            <div className="step__label">{s.label}</div>
          </div>
        )
      })}
    </div>
  )
}
