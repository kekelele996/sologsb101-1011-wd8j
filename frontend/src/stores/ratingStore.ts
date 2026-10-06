/**
 * 定线 store：维护水位流量关系点据、比测记录、定线参数与残差派生值。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 *
 * 挑点剔除：每条定线号在 linesettings 表中维护一份「被挑出点据」清单，
 * 被挑出的点据不参与幂函数拟合，但仍保留、仍可查询；曲线流量、残差、
 * 比测偏差一律按剔除后的新线计算。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult } from '@/types/rating'
import { curveFlow, fitPowerCurve, createEmptyRatingFilter, type RatingFilterState } from '@/types/rating'
import {
  createEmptyLineSetting,
  filterFittingRatings,
  lineSettingId,
  MIN_FIT_POINTS,
  type ExcludeMethod,
  type RatingLineSetting
} from '@/types/ratingLine'
import { screenOutliers, type ScreenResult } from '@/utils/outlierScreen'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const lineSettings = ref<RatingLineSetting[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号与定线参数（跨页保留） */
  const activeLineNo = ref<string>('A')
  const fits = ref<RatingFitResult[]>([])
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
    watchTable<RatingLineSetting>(() => db.linesettings).subscribe((rows) => {
      lineSettings.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 取某定线号的挑点设置（内存兜底，未落库时返回空设置） */
  function settingOfLine(lineNo: string): RatingLineSetting {
    return lineSettings.value.find((item) => item.lineNo === lineNo) ?? createEmptyLineSetting(lineNo)
  }

  const activeLineSetting = computed<RatingLineSetting>(() => settingOfLine(activeLineNo.value))

  /** 某定线号下被剔除的点据 id 集合 */
  function excludedIdsOfLine(lineNo: string): Set<string> {
    return new Set(settingOfLine(lineNo).excludedRatingIds)
  }

  /** 某定线号下实际参与拟合的点据（剔除被挑出的点） */
  function fittingRatingsOfLine(lineNo: string): Rating[] {
    const list = ratings.value.filter((rating) => rating.lineNo === lineNo)
    return filterFittingRatings(list, settingOfLine(lineNo))
  }

  /** 逐定线号的拟合结果：只用剔除后剩余点据做幂函数定线 */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = fittingRatingsOfLine(lineNo).map((rating) => ({
        stageM: rating.stageM,
        flowM3s: rating.flowM3s
      }))
      return fitPowerCurve(points, lineNo)
    })
  )

  const activeFit = computed<RatingFitResult>(
    () =>
      allFits.value.find((fit) => fit.lineNo === activeLineNo.value) ??
      fits.value.find((fit) => fit.lineNo === activeLineNo.value) ??
      fitPowerCurve([], activeLineNo.value)
  )

  /** 点据 + 曲线流量 + 残差 + 是否被剔除（曲线与残差一律按剔除后的新线） */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const fit = activeFit.value
        const predicted = fit.valid ? curveFlow(fit, rating.stageM) : 0
        const residualPct =
          fit.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        const verdict = compare?.verdict ?? (Math.abs(residualPct) > deviationLimitPct.value ? '超限' : '合格')
        return {
          rating,
          predicted,
          residualPct,
          verdict: verdict as Compare['verdict'],
          excluded: activeLineSetting.value.excludedRatingIds.includes(rating.id)
        }
      })
  )

  /** 当前定线被剔除的点据行（仍可查询） */
  const excludedRows = computed(() => pointRows.value.filter((row) => row.excluded))
  /** 当前定线参与拟合的点据行 */
  const retainedRows = computed(() => pointRows.value.filter((row) => !row.excluded))

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

  /** 定线质量派生值：平均残差与合格点占比（只统计参与拟合的定线） */
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

  function setFit(fit: RatingFitResult): void {
    const others = fits.value.filter((item) => item.lineNo !== fit.lineNo)
    fits.value = [...others, fit]
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
    const rating = ratings.value.find((item) => item.id === id)
    await db.transaction('rw', [db.ratings, db.compares, db.linesettings], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
      // 同步从任何定线的剔除清单里移除该点据，避免悬挂引用
      if (rating) {
        const setting = await db.linesettings.get(lineSettingId(rating.lineNo))
        if (setting && setting.excludedRatingIds.includes(id)) {
          await db.linesettings.put({
            ...setting,
            excludedRatingIds: setting.excludedRatingIds.filter((rid) => rid !== id),
            lastAutoPickedIds: setting.lastAutoPickedIds.filter((rid) => rid !== id),
            updatedAt: Date.now()
          })
        }
      }
    })
  }

  /* --------------------------- 挑点剔除（定线设置） --------------------------- */

  /** 落盘某定线的挑点设置 */
  async function saveLineSetting(
    lineNo: string,
    patch: Partial<Omit<RatingLineSetting, 'id' | 'lineNo' | 'createdAt'>>
  ): Promise<RatingLineSetting> {
    const existing = settingOfLine(lineNo)
    const now = Date.now()
    const row: RatingLineSetting = {
      ...existing,
      ...patch,
      id: lineSettingId(lineNo),
      lineNo,
      createdAt: existing.createdAt ?? now,
      updatedAt: now
    }
    await db.linesettings.put(row)
    return row
  }

  /**
   * 预演自动挑点（不落库）：返回两种口径之一的挑点结果，供页面确认。
   */
  function previewAutoExclude(
    lineNo: string,
    method: Extract<ExcludeMethod, '基准线一次挑完' | '逐个重定挑出'>
  ): ScreenResult {
    const points = fittingRatingsOfLine(lineNo).map((rating) => ({
      id: rating.id,
      stageM: rating.stageM,
      flowM3s: rating.flowM3s
    }))
    return screenOutliers(points, method, deviationLimitPct.value, lineNo)
  }

  /**
   * 执行自动挑点：
   * - 剔除后剩余 ≥ 3 点：落盘剔除清单并用剩余点据重定线、重算比测；
   * - 剩余 < 3 点：保留上一版线与原剔除清单，仅记录放弃原因，返回 tooFew。
   */
  async function applyAutoExclude(
    lineNo: string,
    method: Extract<ExcludeMethod, '基准线一次挑完' | '逐个重定挑出'>
  ): Promise<ScreenResult> {
    const result = previewAutoExclude(lineNo, method)
    const setting = settingOfLine(lineNo)
    if (result.tooFew) {
      // 保留上一版线：剔除清单不变，只把放弃原因写明到定线设置
      await saveLineSetting(lineNo, { rejectReason: result.message })
      return result
    }
    await saveLineSetting(lineNo, {
      // 预演只基于当前参与点；新挑出的点并入历史剔除清单
      excludedRatingIds: Array.from(new Set([...setting.excludedRatingIds, ...result.pickedIds])),
      lastMethod: method,
      lastAutoPickedIds: result.pickedIds,
      operatedAt: new Date().toISOString(),
      rejectReason: null
    })
    await rebuildCompares(lineNo)
    return result
  }

  /**
   * 人工挑出 / 恢复单个点据。
   * 挑出会使剩余 < 3 点时拒绝改动、保留上一版线并写明原因；恢复点据总是允许。
   */
  async function toggleExcludeRating(rating: Rating): Promise<{ ok: boolean; message: string; excluded: boolean }> {
    const setting = settingOfLine(rating.lineNo)
    const isExcluded = setting.excludedRatingIds.includes(rating.id)
    const lineTotal = ratings.value.filter((item) => item.lineNo === rating.lineNo).length
    if (!isExcluded) {
      const retainedAfter = lineTotal - setting.excludedRatingIds.length - 1
      if (retainedAfter < MIN_FIT_POINTS) {
        const reason =
          `人工挑出该点后仅剩 ${retainedAfter} 个参与点（少于 ${MIN_FIT_POINTS} 个），无法重定线，已保留上一版线。`
        await saveLineSetting(rating.lineNo, { rejectReason: reason })
        return { ok: false, message: reason, excluded: false }
      }
    }
    const excludedRatingIds = isExcluded
      ? setting.excludedRatingIds.filter((id) => id !== rating.id)
      : [...setting.excludedRatingIds, rating.id]
    await saveLineSetting(rating.lineNo, {
      excludedRatingIds,
      lastMethod: '人工挑点',
      lastAutoPickedIds: [],
      operatedAt: new Date().toISOString(),
      rejectReason: null
    })
    await rebuildCompares(rating.lineNo)
    return {
      ok: true,
      excluded: !isExcluded,
      message: !isExcluded
        ? '点据已挑出，已用剩余点据重定线'
        : '点据已恢复参与定线，已重定线'
    }
  }

  /** 清空该线全部剔除点据，恢复用全部点据定线 */
  async function resetExclusions(lineNo: string): Promise<void> {
    await saveLineSetting(lineNo, {
      excludedRatingIds: [],
      lastMethod: null,
      lastAutoPickedIds: [],
      operatedAt: new Date().toISOString(),
      rejectReason: null
    })
    await rebuildCompares(lineNo)
  }

  /**
   * 由点据生成 / 刷新比测记录：曲线流量取剔除后新线的拟合值，
   * 偏差超过限值自动判定超限并进入分析清单（被剔除点据同样按新线计算、仍在清单内）。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const fit = fitPowerCurve(
      fittingRatingsOfLine(targetLine).map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
      targetLine
    )
    setFit(fit)
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
    lineSettings,
    ready,
    error,
    filter,
    activeLineNo,
    activeFit,
    activeLineSetting,
    fits,
    deviationLimitPct,
    lineNos,
    allFits,
    pointRows,
    excludedRows,
    retainedRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    settingOfLine,
    excludedIdsOfLine,
    fittingRatingsOfLine,
    patchFilter,
    resetFilter,
    setActiveLine,
    setFit,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    saveLineSetting,
    previewAutoExclude,
    applyAutoExclude,
    toggleExcludeRating,
    resetExclusions,
    rebuildCompares,
    createCompare,
    updateCompare,
    removeCompare
  }
})
