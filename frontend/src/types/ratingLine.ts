/**
 * 定线设置：一条定线号（A/B/C…）对应一份。
 * 记录被挑出（剔除）不参与拟合的关系点据 id、挑点口径、备注。
 * 被挑出的点据仍保留在 ratings 表中、仍可在页面查到，只是不参与该线幂函数拟合。
 */

/** 挑点口径（固定两种，自动挑点时必须二选一并写明到页面） */
export type ExcludeMethod = '基准线一次挑完' | '逐个重定挑出' | '人工挑点'

/** 可在页面选择的自动挑点口径（人工挑点不是一种自动口径，不放入下拉） */
export const AUTO_EXCLUDE_METHODS: ExcludeMethod[] = ['基准线一次挑完', '逐个重定挑出']

/** 自动挑点口径的说明文案（页面与挑点记录共用） */
export const EXCLUDE_METHOD_LABELS: Record<ExcludeMethod, string> = {
  基准线一次挑完: '基准线一次挑完：先用全部点据定一条基准线，把相对残差超过限值的点据一次全部挑出，再用剩下的点据重定一次线。',
  逐个重定挑出: '逐个重定挑出：每轮挑出当前线上相对残差最大且超过限值的一个点据，随即用剩下的点据重定线，重复直到没有点据超限。',
  人工挑点: '人工挑点：定线员手动逐个挑出 / 恢复点据，没有套用自动口径。'
}

/** 参与定线所需的最少点据数；少于该数无法拟合也不允许继续剔除 */
export const MIN_FIT_POINTS = 3

export interface RatingLineSetting {
  /** 主键，固定为 `ls_${lineNo}`，一条定线号一份设置 */
  id: string
  /** 定线号（A / B / C…） */
  lineNo: string
  /** 被挑出、不参与拟合的关系点据 id 列表 */
  excludedRatingIds: string[]
  /** 最近一次挑点使用的口径 */
  lastMethod: ExcludeMethod | null
  /** 最近一次自动挑点挑出的点据 id（人工调整不更新），用于页面回显自动挑点结果 */
  lastAutoPickedIds: string[]
  /** 最近一次操作时间（ISO） */
  operatedAt: string | null
  /** 挑点 / 剔除被保留上一版线时的说明（如剩余不足 3 点） */
  rejectReason: string | null
  createdAt: number
  updatedAt: number
}

/** 生成定线设置主键 */
export function lineSettingId(lineNo: string): string {
  return `ls_${lineNo}`
}

export function createEmptyLineSetting(lineNo: string): RatingLineSetting {
  const now = Date.now()
  return {
    id: lineSettingId(lineNo),
    lineNo,
    excludedRatingIds: [],
    lastMethod: null,
    lastAutoPickedIds: [],
    operatedAt: null,
    rejectReason: null,
    createdAt: now,
    updatedAt: now
  }
}

/** 参与拟合的点据（剔除被挑出的点据） */
export function filterFittingRatings<T extends { id: string }>(
  ratings: T[],
  setting: RatingLineSetting | null | undefined
): T[] {
  if (!setting || setting.excludedRatingIds.length === 0) return ratings
  const excluded = new Set(setting.excludedRatingIds)
  return ratings.filter((rating) => !excluded.has(rating.id))
}
