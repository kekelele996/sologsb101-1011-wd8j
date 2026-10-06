/**
 * 定线 store：维护水位流量关系点据、比测记录、定线参数与残差派生值。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 *
 * 偏离点据挑出（不删除点据）：每条定线号在 lineStates 表中记录被挑出点据 id、
 * 挑出口径与页面说明；allFits / activeFit 只用未被挑出的点据拟合，
 * 被挑出点据的曲线流量、残差与比测偏差仍按新线计算，仅挂红留查。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import {
  createEmptyLineState,
  curveFlow,
  fitPowerCurve,
  planExclusion,
  type ExclusionPlan,
  type ExclusionStrategy,
  type LineState,
  type Rating,
  type RatingFitResult
} from '@/types/rating'
import { createEmptyRatingFilter, type RatingFilterState } from '@/types/rating'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const lineStates = ref<LineState[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号（跨页保留） */
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
    watchTable<LineState>(() => db.lineStates).subscribe((rows) => {
      lineStates.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 某条线的挑点定线状态（未挑过时返回空状态） */
  function lineStateOf(lineNo: string): LineState {
    return lineStates.value.find((state) => state.lineNo === lineNo) ?? createEmptyLineState(lineNo)
  }

  /** 某条线被挑出、不参与拟合的点据 id 集合 */
  function excludedIdSetOf(lineNo: string): Set<string> {
    return new Set(lineStateOf(lineNo).excludedIds)
  }

  /** 某条线实际参与拟合的点据（排除已挑出且已不存在的 id） */
  function effectivePointsOf(lineNo: string): Rating[] {
    const excluded = excludedIdSetOf(lineNo)
    return ratings.value.filter((rating) => rating.lineNo === lineNo && !excluded.has(rating.id))
  }

  /** 逐定线号的拟合结果：只用挑点后剩余点据做幂函数定线 */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = effectivePointsOf(lineNo).map((rating) => ({
        stageM: rating.stageM,
        flowM3s: rating.flowM3s
      }))
      return fitPowerCurve(points, lineNo)
    })
  )

  const activeLineState = computed<LineState>(() => lineStateOf(activeLineNo.value))

  const activeFit = computed<RatingFitResult>(() => {
    const found = allFits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (found) return found
    return fitPowerCurve([], activeLineNo.value)
  })

  /** 点据 + 曲线流量 + 残差（全部点据，含已挑出者，均按当前新线计算） */
  const pointRows = computed(() => {
    const current = activeFit.value
    const excluded = excludedIdSetOf(activeLineNo.value)
    return ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const predicted = current.valid ? curveFlow(current, rating.stageM) : 0
        const residualPct =
          current.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          predicted,
          residualPct,
          excluded: excluded.has(rating.id)
        }
      })
  })

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：比测记录 + 点据 + 测站名，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比 */
  const fitQuality = computed(() => {
    const valid = allFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = { ...payload, id: createId('rat'), createdAt: now, updatedAt: now }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /**
   * 按固定口径推演挑点方案（不落库），供页面确认前展示。
   */
  function previewExclusion(lineNo: string, strategy: ExclusionStrategy): ExclusionPlan {
    const points = ratings.value.filter((rating) => rating.lineNo === lineNo)
    return planExclusion(points, strategy, deviationLimitPct.value, lineNo)
  }

  /**
   * 执行挑点并把口径、被挑点据与页面说明写入 lineStates：
   * - 方案可应用：以方案结果替换该线定线状态，并用剩余点据重定线；
   * - 剩余不足 3 点 / 新线无效：保留上一版线（原有挑点不动），仅写明原因。
   * 返回落库后的定线状态。
   */
  async function applyExclusion(lineNo: string, strategy: ExclusionStrategy): Promise<ExclusionPlan> {
    const plan = previewExclusion(lineNo, strategy)
    const previous = lineStateOf(lineNo)
    const next: LineState = plan.applied
      ? {
          lineNo,
          excludedIds: plan.excludedIds,
          strategy,
          note: plan.note,
          status: plan.status,
          updatedAt: Date.now()
        }
      : {
          // 保留上一版线：沿用上一版被挑点据，只记录本次口径与保留原因
          lineNo,
          excludedIds: previous.excludedIds,
          strategy,
          note: plan.note,
          status: plan.status,
          updatedAt: Date.now()
        }
    await db.lineStates.put(next)
    return plan
  }

  /** 恢复该线全部点据参与拟合（清空挑点状态） */
  async function clearLineExclusion(lineNo: string): Promise<void> {
    await db.lineStates.delete(lineNo)
  }

  /**
   * 删除点据后修剪该线挑点状态中已不存在的 id：
   * 仍有被挑点据时保留口径并注明，全部清空则删除状态（恢复全线拟合）。
   */
  async function applyPrunedLineState(lineNo: string, remainingExcludedIds: string[]): Promise<void> {
    if (remainingExcludedIds.length === 0) {
      await db.lineStates.delete(lineNo)
      return
    }
    const previous = lineStateOf(lineNo)
    await db.lineStates.put({
      ...previous,
      lineNo,
      excludedIds: remainingExcludedIds,
      note: `${previous.note}（删除点据后自动核对，当前 ${remainingExcludedIds.length} 个点据处于挑出留查状态）`,
      updatedAt: Date.now()
    })
  }

  /**
   * 由点据生成 / 刷新比测记录：曲线流量取挑点后重定的新线，
   * 全部点据（含被挑出者）都按新线计算偏差；超限自动判定并进入分析清单。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const fit = fitPowerCurve(
      effectivePointsOf(targetLine).map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
      targetLine
    )
    const targets = ratings.value.filter((rating) => rating.lineNo === targetLine)
    if (targets.length === 0) return 0
    const now = Date.now()
    const rows: Compare[] = targets.map((rating) => {
      const predicted = fit.valid ? curveFlow(fit, rating.stageM) : rating.flowM3s
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      const existing = compares.value.find((item) => item.ratingId === rating.id)
      return {
        id: existing?.id ?? createId('cmp'),
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct, deviationLimitPct.value),
        operator: existing?.operator ?? '林昭',
        comparedAt: existing?.comparedAt ?? rating.measuredAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
    })
    await db.compares.bulkPut(rows)
    return rows.length
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function updateCompare(id: string, patch: Partial<Compare>): Promise<void> {
    await db.compares.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  return {
    ratings,
    compares,
    stations,
    lineStates,
    ready,
    error,
    filter,
    activeLineNo,
    activeLineState,
    activeFit,
    deviationLimitPct,
    lineNos,
    allFits,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    lineStateOf,
    effectivePointsOf,
    patchFilter,
    resetFilter,
    setActiveLine,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    previewExclusion,
    applyExclusion,
    clearLineExclusion,
    applyPrunedLineState,
    rebuildCompares,
    createCompare,
    updateCompare,
    removeCompare
  }
})
