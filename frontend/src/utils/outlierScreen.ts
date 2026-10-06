/**
 * 偏离点据挑除：按固定口径，从参与拟合的点据中挑出相对残差超过限值的点。
 * 两种口径都在这里实现，关系点据页通过参数二选一：
 *  - 基准线一次挑完（oneshot）：先用全部点据定基准线，把超限点一次全部挑出；
 *  - 逐个重定挑出（iterative）：每轮挑最偏的一个超限点，随即重定线，直到无人超限。
 *
 * 挑点只返回「应剔除哪些点」，不直接改数据；是否落库、是否重定由 store 决定。
 * 剩余点据少于 MIN_FIT_POINTS（3）时，调用方应放弃本次改动并保留上一版线。
 */
import {
  curveFlow,
  fitPowerCurve,
  type RatingFitResult
} from '@/types/rating'
import { MIN_FIT_POINTS, type ExcludeMethod } from '@/types/ratingLine'

export interface ScreenablePoint {
  id: string
  stageM: number
  flowM3s: number
}

/** 单轮挑点过程记录（页面可展示「每挑一个重定一次」的轨迹） */
export interface ScreenStep {
  /** 本轮拟合前参与点数 */
  fitCount: number
  /** 本轮定线结果 */
  fit: RatingFitResult
  /** 本轮被挑出的点据 id（oneshot 可能多个，iterative 至多一个） */
  pickedIds: string[]
  /** 本轮各点相对残差（%），key 为点据 id */
  residuals: Record<string, number>
}

export interface ScreenResult {
  method: ExcludeMethod
  /** 建议剔除的点据 id（与当前已剔除集合取并集后落库） */
  pickedIds: string[]
  /** 剔除后剩余、用于重定线的点据 */
  retained: ScreenablePoint[]
  /** 被挑出的点据 */
  picked: ScreenablePoint[]
  /** 最终用剩余点据重定的线（可能无效） */
  finalFit: RatingFitResult
  /** 逐轮记录 */
  steps: ScreenStep[]
  /** 剩余点数是否不足 3：此时调用方必须保留上一版线 */
  tooFew: boolean
  /** 说明文案 */
  message: string
}

/** 计算一组点据对某条线的相对残差（%），与页面残差口径一致：(实测-曲线)/实测×100 */
export function residualMap(
  points: ScreenablePoint[],
  fit: RatingFitResult
): Record<string, number> {
  const map: Record<string, number> = {}
  points.forEach((point) => {
    if (!fit.valid || point.flowM3s <= 0) {
      map[point.id] = 0
      return
    }
    const predicted = curveFlow(fit, point.stageM)
    map[point.id] = Number((((point.flowM3s - predicted) / point.flowM3s) * 100).toFixed(2))
  })
  return map
}

/**
 * 执行偏离点据挑除。
 * @param points 当前参与拟合的候选点据（应已排除历史被挑出的点）
 * @param method 口径：基准线一次挑完 / 逐个重定挑出
 * @param limitPct 残差限值（%），严格大于限值才算超限
 * @param lineNo 定线号
 */
export function screenOutliers(
  points: ScreenablePoint[],
  method: Extract<ExcludeMethod, '基准线一次挑完' | '逐个重定挑出'>,
  limitPct: number,
  lineNo: string
): ScreenResult {
  const steps: ScreenStep[] = []
  const pickedIds: string[] = []
  let working = [...points]

  if (method === '基准线一次挑完') {
    const baseFit = fitPowerCurve(working, lineNo)
    const residuals = residualMap(working, baseFit)
    const over = working.filter((point) => Math.abs(residuals[point.id] ?? 0) > limitPct)
    steps.push({ fitCount: working.length, fit: baseFit, pickedIds: over.map((p) => p.id), residuals })
    over.forEach((point) => pickedIds.push(point.id))
    working = working.filter((point) => !pickedIds.includes(point.id))
  } else {
    // 逐个重定挑出：每轮挑出相对残差最大且超过限值的一个点，再重定线
    for (;;) {
      const fit = fitPowerCurve(working, lineNo)
      const residuals = residualMap(working, fit)
      let worstId: string | null = null
      let worstAbs = limitPct
      working.forEach((point) => {
        const abs = Math.abs(residuals[point.id] ?? 0)
        if (abs > worstAbs) {
          worstAbs = abs
          worstId = point.id
        }
      })
      if (worstId === null || !fit.valid) break
      const worstPoint = working.find((point) => point.id === worstId)
      if (!worstPoint) break
      pickedIds.push(worstPoint.id)
      steps.push({ fitCount: working.length, fit, pickedIds: [worstPoint.id], residuals })
      working = working.filter((point) => point.id !== worstId)
      if (working.length < MIN_FIT_POINTS) break
    }
  }

  const picked = points.filter((point) => pickedIds.includes(point.id))
  const retained = points.filter((point) => !pickedIds.includes(point.id))
  const tooFew = retained.length < MIN_FIT_POINTS
  const finalFit = tooFew ? fitPowerCurve([], lineNo) : fitPowerCurve(retained, lineNo)

  let message: string
  if (pickedIds.length === 0) {
    message = `按「${method}」口径检查，没有相对残差超过 ${limitPct}% 的点据，保持原线不变。`
  } else if (tooFew) {
    message =
      `按「${method}」口径将挑出 ${pickedIds.length} 个点据，剔除后仅剩 ${retained.length} 个（少于 ${MIN_FIT_POINTS} 个），` +
      `无法重定线，已保留上一版线、本次挑点不生效。`
  } else {
    message =
      `按「${method}」口径挑出 ${pickedIds.length} 个超限点据，使用剩余 ${retained.length} 个点据重定线。`
  }

  return { method, pickedIds, retained, picked, finalFit, steps, tooFew, message }
}
