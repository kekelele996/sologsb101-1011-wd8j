/** 水位流量关系点据：参与幂函数定线的实测点 */
export interface Rating {
  id: string
  /** 所属测站 */
  stationId: string
  /** 水位（m） */
  stageM: number
  /** 流量（m³/s） */
  flowM3s: number
  /** 定线号：同一定线号的点据参与同一组拟合 */
  lineNo: string
  /** 点据来源测次号 */
  measureNo: string
  /** 点据时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 幂函数定线结果：Q = a * (H - H0)^b */
export interface RatingFitResult {
  lineNo: string
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（由点据自动搜索获得） */
  h0: number
  /** 参与拟合的点数 */
  sampleCount: number
  /** 拟合残差（相对误差绝对值均值，%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R²（对数域） */
  r2: number
  /** 是否可定线（点数 ≥ 3 且 b 为正） */
  valid: boolean
  /** 不可定线时的说明 */
  message: string
}

/**
 * 偏离点据挑出口径：
 * - once：先用全部点据定一条基准线，把超过限值的一次挑完；
 * - iterative：从残差最偏的一个起逐个挑，每挑一个重定一次线，直到没有点超限。
 */
export type ExclusionStrategy = 'once' | 'iterative'

/** 挑点口径的中文名称（页面展示共用） */
export const EXCLUSION_STRATEGY_LABELS: Record<ExclusionStrategy, string> = {
  once: '基准线一次挑完',
  iterative: '逐个挑出逐次重定'
}

/** 挑点后定线状态 */
export type ExclusionStatus = 'normal' | 'rolledback' | 'invalid'

/**
 * 定线状态（按定线号持久化到 lineStates 表）：
 * 记录被挑出不参与拟合的点据、所用口径与挑点说明；
 * 被挑出的点据仍保留在 ratings 表中，可随时查询。
 */
export interface LineState {
  /** 主键：定线号 */
  lineNo: string
  /** 被挑出、不再参与拟合的点据 id（按挑出先后排列） */
  excludedIds: string[]
  /** 本次挑点所用口径 */
  strategy: ExclusionStrategy
  /** 定线员在页面写明的挑点说明（口径、结果或保留上一版线的原因） */
  note: string
  /** 最近一次挑点后的状态 */
  status: ExclusionStatus
  updatedAt: number
}

/** 挑点方案：由固定口径对候选点据推演得到，页面据此执行与写明 */
export interface ExclusionPlan {
  lineNo: string
  strategy: ExclusionStrategy
  /** 建议挑出的点据 id（按挑出先后排列） */
  excludedIds: string[]
  /** 基准线上超限值的点据 id */
  candidateIds: string[]
  /** 是否应用本方案（false 表示保留上一版线） */
  applied: boolean
  /** 推演后的定线状态 */
  status: ExclusionStatus
  /** 页面写明的说明 */
  note: string
  /** 逐轮信息（逐个挑口径） */
  rounds: Array<{
    round: number
    removedId: string
    residualPct: number
    remaining: number
  }>
}

/** 关系点据页筛选条件（存于 ratingStore） */
export interface RatingFilterState {
  keyword: string
  stationIds: string[]
  lineNos: string[]
  verdicts: Array<'合格' | '超限'>
}

export function createEmptyRatingFilter(): RatingFilterState {
  return {
    keyword: '',
    stationIds: [],
    lineNos: [],
    verdicts: []
  }
}

/** 构造一条线的默认定线状态 */
export function createEmptyLineState(lineNo: string): LineState {
  return {
    lineNo,
    excludedIds: [],
    strategy: 'iterative',
    note: '',
    status: 'normal',
    updatedAt: 0
  }
}

/** 对 ln(Q) 与 ln(H - H0) 做最小二乘直线拟合，给定 H0 返回参数与残差 */
function fitWithBase(
  samples: Array<{ stageM: number; flowM3s: number }>,
  h0: number
): { a: number; b: number; residuals: number[] } | null {
  const points = samples.map((point) => ({
    x: Math.log(Math.max(point.stageM - h0, 1e-6)),
    y: Math.log(point.flowM3s)
  }))
  const n = points.length
  const sumX = points.reduce((sum, item) => sum + item.x, 0)
  const sumY = points.reduce((sum, item) => sum + item.y, 0)
  const sumXY = points.reduce((sum, item) => sum + item.x * item.y, 0)
  const sumXX = points.reduce((sum, item) => sum + item.x * item.x, 0)
  const denominator = n * sumXX - sumX * sumX
  if (Math.abs(denominator) < 1e-9) return null
  const b = (n * sumXY - sumX * sumY) / denominator
  const lnA = (sumY - b * sumX) / n
  const a = Math.exp(lnA)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null
  const residuals = samples.map((point) => {
    const predicted = a * Math.pow(Math.max(point.stageM - h0, 1e-6), b)
    return Math.abs((predicted - point.flowM3s) / point.flowM3s) * 100
  })
  return { a, b, residuals }
}

/**
 * 幂函数定线：Q = a×(H - H0)^b。
 * 在 [Hmin - 0.9×(Hmax-Hmin) , Hmin - 0.02] 区间内以 0.01 m 步长搜索 H0，
 * 取平均相对残差最小的一组参数，避免「基线贴近最低水位」造成幂函数畸变。
 */
export function fitPowerCurve(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo = 'A'
): RatingFitResult {
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const base: RatingFitResult = {
    lineNo,
    a: 0,
    b: 0,
    h0: 0,
    sampleCount: usable.length,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message: ''
  }
  if (usable.length < 3) {
    return { ...base, message: '点据少于 3 个，无法定线（至少需要 3 个实测点）' }
  }
  const stageMin = Math.min(...usable.map((point) => point.stageM))
  const stageMax = Math.max(...usable.map((point) => point.stageM))
  const spread = Math.max(stageMax - stageMin, 0.05)
  const lowerH0 = stageMin - spread * 0.9
  const upperH0 = stageMin - 0.02

  let best: { a: number; b: number; h0: number; residuals: number[]; mean: number } | null = null
  const steps = Math.max(1, Math.round((upperH0 - lowerH0) / 0.01))
  for (let index = 0; index <= steps; index += 1) {
    const h0 = Number((lowerH0 + (index * (upperH0 - lowerH0)) / steps).toFixed(4))
    const candidate = fitWithBase(usable, h0)
    if (!candidate) continue
    const mean = candidate.residuals.reduce((sum, value) => sum + value, 0) / candidate.residuals.length
    if (!best || mean < best.mean) {
      best = { ...candidate, h0, mean }
    }
  }
  if (!best) {
    return { ...base, message: '水位点据过于集中，无法求解幂函数指数' }
  }

  // 对数域决定系数 R²
  const lnFlows = usable.map((point) => Math.log(point.flowM3s))
  const meanLnFlow = lnFlows.reduce((sum, value) => sum + value, 0) / lnFlows.length
  const totalSs = lnFlows.reduce((sum, value) => sum + (value - meanLnFlow) ** 2, 0)
  const residualSs = usable.reduce((sum, point) => {
    const predicted = best.a * Math.pow(Math.max(point.stageM - best.h0, 1e-6), best.b)
    const diff = Math.log(point.flowM3s) - Math.log(Math.max(predicted, 1e-6))
    return sum + diff * diff
  }, 0)
  const r2 = totalSs < 1e-9 ? 1 : Number(Math.max(0, 1 - residualSs / totalSs).toFixed(4))

  const valid = best.b > 0 && Number.isFinite(best.a)
  return {
    lineNo,
    a: Number(best.a.toFixed(4)),
    b: Number(best.b.toFixed(3)),
    h0: Number(best.h0.toFixed(3)),
    sampleCount: usable.length,
    meanResidualPct: Number(best.mean.toFixed(2)),
    maxResidualPct: Number(Math.max(...best.residuals).toFixed(2)),
    r2,
    valid,
    message: valid ? '定线有效' : '指数 b ≤ 0，点据趋势异常，请检查水位与流量的对应关系'
  }
}

/** 由定线参数计算曲线流量 */
export function curveFlow(fit: RatingFitResult, stageM: number): number {
  if (!fit.valid) return 0
  const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
  return Number(value.toFixed(2))
}

/** 点据相对某条定线的带符号残差（%）：(实测 - 曲线) / 实测 × 100 */
export function signedResidualPct(
  fit: RatingFitResult,
  point: { stageM: number; flowM3s: number }
): number {
  if (!fit.valid || point.flowM3s <= 0) return 0
  const predicted = curveFlow(fit, point.stageM)
  return Number((((point.flowM3s - predicted) / point.flowM3s) * 100).toFixed(2))
}

/** 定线至少需要的点据数；挑点后少于该数量必须保留上一版线 */
export const MIN_FIT_POINTS = 3

/**
 * 按固定口径推演偏离点据挑出方案。
 * - once：全部点据先定基准线，残差超限值的一次挑完，再用剩余点据重定线；
 * - iterative：从基准线上最偏的一个起逐个挑，每挑一个用剩余点据重定线，
 *   直到没有点超限。
 * 挑完剩余点据不足 3 个（或基准线本身无效）时不应用方案，保留上一版线并写明原因。
 */
export function planExclusion(
  points: Rating[],
  strategy: ExclusionStrategy,
  limitPct: number,
  lineNo = 'A'
): ExclusionPlan {
  const label = EXCLUSION_STRATEGY_LABELS[strategy]
  const baseline = fitPowerCurve(
    points.map((point) => ({ stageM: point.stageM, flowM3s: point.flowM3s })),
    lineNo
  )

  // 基准线无效（不足 3 点或趋势异常）：没有可用的「上一版线」判定依据，不挑点
  if (!baseline.valid) {
    return {
      lineNo,
      strategy,
      excludedIds: [],
      candidateIds: [],
      applied: false,
      status: 'invalid',
      note: `「${label}」未能执行：${baseline.message || '全部点据无法定出基准线'}，保留上一版线。`,
      rounds: []
    }
  }

  const residualMap = (
    fit: RatingFitResult,
    list: Rating[]
  ): Array<{ point: Rating; residual: number }> =>
    list.map((point) => ({ point, residual: signedResidualPct(fit, point) }))

  const baselineRows = residualMap(baseline, points)
  const candidates = baselineRows
    .filter((row) => Math.abs(row.residual) > limitPct)
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual))
  const candidateIds = candidates.map((row) => row.point.id)

  if (candidateIds.length === 0) {
    return {
      lineNo,
      strategy,
      excludedIds: [],
      candidateIds: [],
      applied: true,
      status: 'normal',
      note: `按「${label}」口径用全部 ${points.length} 个点据定基准线，残差均未超过限值 ${limitPct}%，无需挑点。`,
      rounds: []
    }
  }

  if (strategy === 'once') {
    // 一次挑完：剩余点据不足 3 个时整批不挑，保留基准线（上一版线）
    if (points.length - candidateIds.length < MIN_FIT_POINTS) {
      return {
        lineNo,
        strategy,
        excludedIds: [],
        candidateIds,
        applied: false,
        status: 'rolledback',
        note:
          `「${label}」：基准线（全部 ${points.length} 点）上有 ${candidateIds.length} 个点残差超过 ${limitPct}%，` +
          `一次挑出后仅剩 ${points.length - candidateIds.length} 点，不足 ${MIN_FIT_POINTS} 点无法重定线，` +
          `该批点据不予挑出，保留上一版线（基准线）。`,
        rounds: []
      }
    }
    return {
      lineNo,
      strategy,
      excludedIds: candidateIds,
      candidateIds,
      applied: true,
      status: 'normal',
      note:
        `「${label}」：先用全部 ${points.length} 个点据定基准线，残差超过限值 ${limitPct}% 的 ${candidateIds.length} 个点一次挑出，` +
        `改用其余 ${points.length - candidateIds.length} 个点据重定线；被挑出点据仅挂红留查，不参与拟合。`,
      rounds: []
    }
  }

  // iterative：从最偏的一个起逐个挑，每挑一个重定一次线
  const working = [...points]
  const excludedIds: string[] = []
  const rounds: ExclusionPlan['rounds'] = []
  let current = baseline
  let round = 0
  // 先按基准线挑最偏点；之后每轮按新线重新找最偏点
  // 每次挑之前检查：挑完是否会少于 3 点
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 上一轮重定的新线无效时无法再判定偏离，直接中止并回滚
    if (!current.valid) {
      return {
        lineNo,
        strategy,
        excludedIds: [],
        candidateIds,
        applied: false,
        status: 'rolledback',
        note:
          `「${label}」：逐个挑出 ${excludedIds.length} 个点后，剩余 ${working.length} 个点据重定线失败` +
          `（${current.message || '幂函数无解'}），挑点中止，已挑出的点全部恢复，保留上一版线。`,
        rounds
      }
    }
    const worst = residualMap(current, working)
      .filter((row) => Math.abs(row.residual) > limitPct)
      .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual))[0]
    if (!worst) break
    if (working.length - 1 < MIN_FIT_POINTS) {
      return {
        lineNo,
        strategy,
        excludedIds: [],
        candidateIds,
        applied: false,
        status: 'rolledback',
        note:
          `「${label}」：基准线（全部 ${points.length} 点）上有 ${candidateIds.length} 个点残差超过 ${limitPct}%；` +
          `逐个挑至第 ${round + 1} 个（水位 ${worst.point.stageM.toFixed(2)} m，残差 ${worst.residual.toFixed(2)}%）时，` +
          `挑出后仅剩 ${working.length - 1} 点，不足 ${MIN_FIT_POINTS} 点无法重定线，挑点中止，` +
          `已挑出的 ${excludedIds.length} 个点全部恢复，保留上一版线。`,
        rounds
      }
    }
    round += 1
    const index = working.findIndex((item) => item.id === worst.point.id)
    working.splice(index, 1)
    excludedIds.push(worst.point.id)
    rounds.push({
      round,
      removedId: worst.point.id,
      residualPct: worst.residual,
      remaining: working.length
    })
    current = fitPowerCurve(
      working.map((point) => ({ stageM: point.stageM, flowM3s: point.flowM3s })),
      lineNo
    )
  }

  return {
    lineNo,
    strategy,
    excludedIds,
    candidateIds,
    applied: true,
    status: 'normal',
    note:
      `「${label}」：基准线（全部 ${points.length} 点）上有 ${candidateIds.length} 个点残差超过 ${limitPct}%；` +
      `从最偏点起逐个挑出并重定线，共 ${rounds.length} 轮挑出 ${excludedIds.length} 个点，` +
      `改用其余 ${working.length} 个点据重定至无点超限；被挑出点据仅挂红留查，不参与拟合。`,
    rounds
  }
}
