<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线
 * 幂函数拟合 Q = a×(H-H0)^b、残差展示、超限点据挂红，并同步 URL query。
 * 支持把明显偏离的点据「挑出」不参与拟合，两种固定口径（页面写明所用口径）：
 *  - 基准线一次挑完：全部点据定基准线，超限点一次挑完再重定；
 *  - 逐个重定挑出：每轮挑最偏的一个超限点并重定线，直到无人超限。
 * 也支持人工逐个挑出 / 恢复。挑后剩余 < 3 点时保留上一版线并写明原因。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, Delete, Edit, Plus, Refresh, TrendCharts } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import { fitPowerCurve, type Rating, type RatingFitResult } from '@/types/rating'
import {
  AUTO_EXCLUDE_METHODS,
  EXCLUDE_METHOD_LABELS,
  type ExcludeMethod
} from '@/types/ratingLine'
import type { ScreenResult } from '@/utils/outlierScreen'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

/** 挑点口径选择（自动挑点二选一） */
const excludeMethod = ref<Extract<ExcludeMethod, '基准线一次挑完' | '逐个重定挑出'>>('基准线一次挑完')
/** 挑点确认弹窗 */
const screenDialogVisible = ref(false)
const screenRunning = ref(false)
const pendingScreen = ref<ScreenResult | null>(null)

const fit = computed(() => ratingStore.activeFit)
const lineSetting = computed(() => ratingStore.activeLineSetting)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))

/** 当前定线号下的全部点据（含被挑出点），曲线流量与残差按剔除后的新线计算 */
const pointRows = computed(() => ratingStore.pointRows)
/** 参与拟合的点据（未被挑出） */
const retainedRows = computed(() => pointRows.value.filter((row) => !row.excluded))
/** 被挑出、不参与拟合的点据（仍可查询） */
const excludedRows = computed(() => pointRows.value.filter((row) => row.excluded))

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 挑点口径的说明文案 */
const methodLabel = computed(() => (lineSetting.value.lastMethod ? EXCLUDE_METHOD_LABELS[lineSetting.value.lastMethod] : ''))

/** 页面可选的自动挑点口径 */
const autoExcludeMethods = AUTO_EXCLUDE_METHODS

/** 最近一次挑点操作时间（页面写明） */
const operatedAtText = computed(() =>
  lineSetting.value.operatedAt ? new Date(lineSetting.value.operatedAt).toLocaleString('zh-CN') : ''
)

/** 关系曲线坐标：横轴水位、纵轴流量；坐标域按参与拟合的点据取，被挑出点单独绘制 */
const chart = computed(() => {
  const retained = retainedRows.value
  const rows = pointRows.value
  const empty = { samples: '', points: [] as Array<{ id: string; cx: number; cy: number; verdict: string; excluded: boolean }>, stageMin: 0, stageMax: 0, flowMax: 0 }
  if (rows.length === 0) return empty
  const domainRows = retained.length >= 2 ? retained : rows
  const stages = domainRows.map((row) => row.rating.stageM)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...domainRows.map((row) => Math.max(row.rating.flowM3s, row.predicted))) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (Math.max(flowM3s, 0) / flowMax) * (bottom - top)
  const sampleCount = 13
  const samples =
    retained.length >= 2 && fit.value.valid
      ? Array.from({ length: sampleCount }, (_, index) => {
          const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
          const value = fit.value.a * Math.pow(Math.max(stageM - fit.value.h0, 1e-6), fit.value.b)
          return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
        }).join(' ')
      : ''
  return {
    samples,
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      verdict: row.verdict,
      excluded: row.excluded
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  const last = retainedRows.value[retainedRows.value.length - 1]
  form.stageM = last ? Number((last.rating.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.rating.flowM3s * 1.2).toFixed(1)) : 50
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('点据已新增，正在重算定线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.rebuildCompares(rating.lineNo)
  ElMessage.success('点据已删除并重算定线')
}

async function refit(): Promise<void> {
  const result: RatingFitResult = fitPowerCurve(
    retainedRows.value.map((row) => ({ stageM: row.rating.stageM, flowM3s: row.rating.flowM3s })),
    ratingStore.activeLineNo
  )
  ratingStore.setFit(result)
  const count = await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  if (result.valid) {
    ElMessage.success(
      `定线完成：Q = ${result.a}×(H-${result.h0})^${result.b}，平均残差 ${result.meanResidualPct}%，刷新比测 ${count} 条`
    )
  } else {
    ElMessage.warning(result.message || '当前点据不足以定线')
  }
}

/** 打开挑点确认弹窗：按所选口径预演，不落库 */
function openScreenDialog(): void {
  pendingScreen.value = ratingStore.previewAutoExclude(ratingStore.activeLineNo, excludeMethod.value)
  screenDialogVisible.value = true
}

/** 挑点弹窗的口径说明 */
const screenMethodDescription = computed(() =>
  pendingScreen.value ? EXCLUDE_METHOD_LABELS[pendingScreen.value.method] : ''
)

/** 挑点弹窗的点据行：基准线残差 + 是否被本轮挑出 */
const screenRows = computed(() => {
  const result = pendingScreen.value
  if (!result) return []
  // 基准线（第一轮）残差作为展示依据
  const baseStep = result.steps[0]
  const baseResiduals = baseStep?.residuals ?? {}
  const pickedSet = new Set(result.pickedIds)
  const all = [...result.retained, ...result.picked]
  return all
    .map((point) => ({
      rating: { stageM: point.stageM, flowM3s: point.flowM3s, id: point.id } as Pick<Rating, 'stageM' | 'flowM3s' | 'id'>,
      residualPct: baseResiduals[point.id] ?? 0,
      picked: pickedSet.has(point.id)
    }))
    .sort((a, b) => Math.abs(b.residualPct) - Math.abs(a.residualPct))
})

/** 确认执行挑点：落库剔除清单、重定线、重算比测；剩余 < 3 点时保留上一版线 */
async function confirmScreen(): Promise<void> {
  if (!pendingScreen.value) return
  screenRunning.value = true
  try {
    const result = await ratingStore.applyAutoExclude(ratingStore.activeLineNo, excludeMethod.value)
    screenDialogVisible.value = false
    if (result.tooFew) {
      ElMessage.warning(result.message)
    } else if (result.pickedIds.length === 0) {
      ElMessage.info(result.message)
    } else {
      ElMessage.success(result.message)
    }
  } finally {
    screenRunning.value = false
    pendingScreen.value = null
  }
}

/** 人工挑出 / 恢复单个点据 */
async function toggleExclude(rating: Rating): Promise<void> {
  const result = await ratingStore.toggleExcludeRating(rating)
  if (!result.ok) {
    ElMessage.warning(result.message)
    return
  }
  ElMessage.success(result.message)
}

async function resetExclusions(): Promise<void> {
  if (excludedRows.value.length === 0) {
    ElMessage.info('当前定线没有被挑出的点据')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将恢复全部 ${excludedRows.value.length} 个被挑出的点据、改用全部点据重新定线，确认继续？`,
      '恢复挑点',
      { type: 'info', confirmButtonText: '全部恢复并重定', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.resetExclusions(ratingStore.activeLineNo)
  ElMessage.success('已恢复全部点据并用全部点据重新定线')
}

/** 表格行样式：被挑出的点据整行置灰 */
function rowClassName({ row }: { row: { excluded: boolean } }): string {
  return row.excluded ? 'row-excluded' : ''
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线</h2>
        <p class="gb-hint">
          点据按定线号分组做幂函数拟合 Q = a×(H-H0)^b，残差超过 {{ ratingStore.deviationLimitPct }}% 的点据自动挂红。
          可把明显偏离的点据挑出、不参与拟合，再用剩余点据重定线；被挑出的点据仍保留可查。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-select v-model="excludeMethod" class="page__method-select" title="挑点口径">
          <el-option
            v-for="method in autoExcludeMethods"
            :key="method"
            :label="method"
            :value="method"
          />
        </el-select>
        <el-button type="warning" plain :icon="Aim" :disabled="retainedRows.length < 3" @click="openScreenDialog">
          按口径挑偏离点
        </el-button>
        <el-button :icon="Refresh" @click="refit">重新定线</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <el-alert
      v-if="lineSetting.rejectReason"
      type="warning"
      show-icon
      :closable="false"
      title="已保留上一版线"
      :description="lineSetting.rejectReason"
    />

    <el-alert
      v-if="excludedRows.length > 0 && !lineSetting.rejectReason"
      type="info"
      show-icon
      :closable="false"
      class="page__pick-alert"
    >
      <template #title>
        当前 {{ ratingStore.activeLineNo }} 线已挑出 {{ excludedRows.length }} 个偏离点据、使用
        {{ retainedRows.length }} 个点据定线；
        <el-link type="primary" :underline="false" @click="resetExclusions">全部恢复并重定</el-link>
      </template>
      <div v-if="lineSetting.lastMethod" class="page__pick-method">挑点口径：{{ lineSetting.lastMethod }}<span class="gb-hint">（{{ operatedAtText }}）</span></div>
    </el-alert>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge
        label="参与定线点据"
        :value="retainedRows.length"
        :suffix="`/ 共 ${pointRows.length} 点`"
        icon="DataLine"
      />
      <StatBadge
        label="已挑出点据"
        :value="excludedRows.length"
        suffix="点"
        :tone="excludedRows.length > 0 ? 'warning' : 'success'"
        :icon="excludedRows.length > 0 ? 'Aim' : 'DataLine'"
      />
      <StatBadge
        label="定线系数 a"
        :value="fit.valid ? fit.a : '—'"
        :suffix="fit.valid ? `b=${fit.b}` : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="Histogram"
      />
      <StatBadge
        label="超限点据"
        :value="pointRows.filter((row) => row.verdict === '超限').length"
        suffix="点"
        :tone="pointRows.some((row) => row.verdict === '超限') ? 'danger' : 'success'"
        :icon="pointRows.some((row) => row.verdict === '超限') ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <el-alert
      v-if="!fit.valid"
      type="warning"
      show-icon
      :closable="false"
      :title="fit.message || '当前定线号下点据不足，至少需要 3 个实测点才能定线'"
    />
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      :title="`${fit.lineNo} 线定线有效：Q = ${fit.a} × (H - ${fit.h0})^${fit.b}；参与样本 ${fit.sampleCount} 点（已挑出 ${excludedRows.length} 点不参与拟合），平均残差 ${fit.meanResidualPct}%，最大残差 ${fit.maxResidualPct}%`"
    />

    <el-alert
      v-if="methodLabel && excludedRows.length > 0"
      type="success"
      show-icon
      :closable="false"
      class="page__method-desc"
      :title="`本线采用口径：${lineSetting.lastMethod}`"
      :description="methodLabel"
    />

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该定线号下还没有关系点据"
        description="录入实测水位与流量点据后即可做幂函数定线；也可以先切换到其他定线号查看已有成果。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact" :row-class-name="rowClassName">
        <el-table-column label="状态" width="104" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.excluded" type="warning" size="small" effect="dark">已挑出</el-tag>
            <el-tag v-else type="success" size="small" effect="plain">参与定线</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono" :class="{ 'page__muted': row.excluded }">
              {{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="残差（按新线）" width="196">
          <template #default="{ row }">
            <DeviationTag :deviation-pct="row.residualPct" :verdict="row.verdict" :limit="ratingStore.deviationLimitPct" />
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="170">
          <template #default="{ row }">
            <div>{{ ratingStore.stationNameOf(row.rating.stationId) }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button
              size="small"
              :type="row.excluded ? 'success' : 'warning'"
              plain
              :icon="Aim"
              @click="toggleExclude(row.rating)"
            >
              {{ row.excluded ? '恢复' : '挑出' }}
            </el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline v-if="fit.valid" :points="chart.samples" fill="none" stroke="#0f4c75" stroke-width="2" />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.excluded ? '#fdf3e3' : point.verdict === '超限' ? '#c0392b' : '#7fd1e8'"
            :stroke="point.excluded ? '#b9770e' : point.verdict === '超限' ? '#7b241c' : '#0f4c75'"
            :stroke-width="point.excluded ? 1.6 : 1"
            :stroke-dasharray="point.excluded ? '2 1.5' : undefined"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="录入点据后自动生成关系曲线。" compact />
        <p class="gb-hint">
          蓝点为参与定线点据，红点为残差超限点据，黄圈为已挑出、不参与拟合的点据；曲线只用剩余点据定出。
        </p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重算' : '新增并定线' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 按固定口径挑偏离点的确认弹窗：预演结果确认后才落库、重定线 -->
    <el-dialog
      v-model="screenDialogVisible"
      :title="`按口径挑偏离点（${excludeMethod}）`"
      width="640px"
      :close-on-click-modal="false"
    >
      <div v-if="pendingScreen" class="page__screen">
        <p class="gb-hint">{{ screenMethodDescription }}</p>
        <el-alert
          :type="pendingScreen.tooFew ? 'warning' : pendingScreen.pickedIds.length === 0 ? 'info' : 'success'"
          show-icon
          :closable="false"
          :title="pendingScreen.message"
          class="page__screen-alert"
        />
        <el-table :data="screenRows" border stripe size="small" max-height="280">
          <el-table-column label="水位 (m)" width="90" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测流量" width="100" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="判定" width="180">
            <template #default="{ row }">
              <DeviationTag
                :deviation-pct="row.residualPct"
                :verdict="Math.abs(row.residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格'"
                :limit="ratingStore.deviationLimitPct"
              />
            </template>
          </el-table-column>
          <el-table-column label="处理">
            <template #default="{ row }">
              <el-tag :type="row.picked ? 'warning' : 'success'" size="small" effect="plain">
                {{ row.picked ? '挑出，不参与拟合' : '保留参与定线' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="!pendingScreen.tooFew && pendingScreen.finalFit.valid" class="page__screen-fit">
          重定后 {{ pendingScreen.finalFit.sampleCount }} 点：Q = {{ pendingScreen.finalFit.a }} ×
          (H - {{ pendingScreen.finalFit.h0 }})^{{ pendingScreen.finalFit.b }}，平均残差
          {{ pendingScreen.finalFit.meanResidualPct }}%，R² = {{ pendingScreen.finalFit.r2 }}
        </div>
      </div>
      <template #footer>
        <el-button @click="screenDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="screenRunning"
          :disabled="!pendingScreen || pendingScreen.tooFew || pendingScreen.pickedIds.length === 0"
          @click="confirmScreen"
        >
          确认挑出并重定线
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__line-select {
  width: 110px;
}

.page__method-select {
  width: 176px;
}

.page__pick-alert,
.page__method-desc {
  margin-top: -2px;
}

.page__pick-method {
  margin-top: 2px;
  font-size: 13px;
}

.page__muted {
  color: #a8b6c1;
}

.page__screen {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.page__screen-alert {
  margin: 0;
}

.page__screen-fit {
  font-size: 13px;
  color: #0f4c75;
  background: #f2f8fc;
  border: 1px solid #d8e4ec;
  border-radius: 6px;
  padding: 8px 12px;
}

:deep(.row-excluded) {
  color: #9aa9b5;
  background-color: #faf6ef !important;
}

:deep(.row-excluded:hover > td) {
  background-color: #f5eddd !important;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
