<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  createIntersection,
  deleteIntersection,
  listIntersections,
  updateIntersection,
} from '@/api/intersections'
import { geocodeAddress } from '@/utils/geocode'

const DIR_OPTIONS = [
  { label: '北', bearing: 0 },
  { label: '东北', bearing: 45 },
  { label: '东', bearing: 90 },
  { label: '东南', bearing: 135 },
  { label: '南', bearing: 180 },
  { label: '西南', bearing: 225 },
  { label: '西', bearing: 270 },
  { label: '西北', bearing: 315 },
]

const CAMERA_TYPES = [
  { value: 'traffic', label: '交通枪机' },
  { value: 'ptz', label: '联动快球' },
]

const points = ref([])
const loading = ref(false)
const listError = ref('')
const keyword = ref('')

const dialogOpen = ref(false)
const editingId = ref(null)
const saving = ref(false)
const formError = ref('')
const geoStatus = ref('')

const removing = ref(null)
const removingBusy = ref(false)

const form = reactive({
  code: '',
  name: '',
  roads: '',
  lng: '',
  lat: '',
  cameras: [],
})

const totalCameras = computed(() =>
  points.value.reduce((sum, point) => sum + (point.cameras?.length ?? 0), 0),
)

const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return points.value
  return points.value.filter((point) =>
    [point.code, point.name, point.roads].some((value) =>
      String(value ?? '').toLowerCase().includes(query),
    ),
  )
})

function clampBearing(value) {
  return (((Number(value) || 0) % 360) + 360) % 360
}

function directionOf(camera) {
  return DIR_OPTIONS[Math.round(clampBearing(camera.bearing) / 45) % 8].label
}

function bearingOf(label) {
  return DIR_OPTIONS.find((option) => option.label === label)?.bearing ?? 0
}

function syncBearing(camera) {
  camera.bearing = bearingOf(camera.dir)
}

function emptyCamera() {
  return { scene: '', type: 'traffic', dir: '东', bearing: 90 }
}

function fmtCoord(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(5) : '—'
}

async function load() {
  loading.value = true
  listError.value = ''
  try {
    points.value = await listIntersections()
  } catch (error) {
    listError.value = error.message
  } finally {
    loading.value = false
  }
}

function resetForm(point) {
  formError.value = ''
  geoStatus.value = ''
  if (!point) {
    editingId.value = null
    Object.assign(form, {
      code: '',
      name: '',
      roads: '',
      lng: '',
      lat: '',
      cameras: [emptyCamera()],
    })
    return
  }
  editingId.value = point.id
  Object.assign(form, {
    code: point.code ?? '',
    name: point.name ?? '',
    roads: point.roads ?? '',
    lng: point.lng != null ? String(point.lng) : '',
    lat: point.lat != null ? String(point.lat) : '',
    cameras: (point.cameras ?? []).map((camera) => ({
      scene: camera.scene ?? '',
      type: camera.type ?? 'traffic',
      dir: directionOf(camera),
      bearing: clampBearing(camera.bearing),
    })),
  })
  if (!form.cameras.length) form.cameras.push(emptyCamera())
}

function openCreate() {
  resetForm(null)
  dialogOpen.value = true
}

function openEdit(point) {
  resetForm(point)
  dialogOpen.value = true
}

function closeDialog() {
  if (saving.value) return
  dialogOpen.value = false
}

function addCamera() {
  form.cameras.push(emptyCamera())
}

function removeCamera(index) {
  form.cameras.splice(index, 1)
}

async function identifyCoords() {
  const query = form.roads.trim() || form.name.trim()
  if (!query) {
    geoStatus.value = '请先填写道路交叉或路口名称'
    return
  }
  geoStatus.value = '识别中…'
  const result = await geocodeAddress(query)
  if (!result) {
    geoStatus.value = '未识别到坐标，请手动填写'
    return
  }
  form.lng = result.lng.toFixed(6)
  form.lat = result.lat.toFixed(6)
  geoStatus.value = `已识别：${form.lat}, ${form.lng}`
}

async function submit() {
  formError.value = ''

  const code = form.code.trim()
  const name = form.name.trim()
  const lng = Number(form.lng)
  const lat = Number(form.lat)

  if (!code) {
    formError.value = '请填写点位编号'
    return
  }
  if (!name) {
    formError.value = '请填写路口名称'
    return
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    formError.value = '请填写有效的经度（-180 ~ 180）'
    return
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    formError.value = '请填写有效的纬度（-90 ~ 90）'
    return
  }
  if (form.cameras.some((camera) => !camera.scene.trim())) {
    formError.value = '请完整填写每台相机的名称'
    return
  }

  const payload = {
    code,
    name,
    roads: form.roads.trim() || name,
    lng,
    lat,
    cameras: form.cameras.map((camera) => ({
      scene: camera.scene.trim(),
      type: camera.type,
      bearing: bearingOf(camera.dir),
      dir: `${camera.dir}向`,
    })),
  }

  saving.value = true
  try {
    if (editingId.value) {
      await updateIntersection(editingId.value, payload)
    } else {
      await createIntersection(payload)
    }
    dialogOpen.value = false
    await load()
  } catch (error) {
    formError.value = /Duplicate entry/i.test(error.message)
      ? '点位编号已存在，请更换'
      : error.message
  } finally {
    saving.value = false
  }
}

function askRemove(point) {
  removing.value = point
}

async function confirmRemove() {
  if (!removing.value) return
  removingBusy.value = true
  try {
    await deleteIntersection(removing.value.id)
    removing.value = null
    await load()
  } catch (error) {
    listError.value = error.message
    removing.value = null
  } finally {
    removingBusy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="manage">
    <header class="head">
      <div class="head-left">
        <RouterLink class="back" to="/">← 返回路网图</RouterLink>
        <div>
          <p class="eyebrow">TRAFFIC CAM · MONITOR POINTS</p>
          <h1 class="title">监控点位管理</h1>
        </div>
      </div>
      <div class="stats">
        <div class="stat">
          <b>{{ points.length }}</b>
          <span>路口</span>
        </div>
        <div class="stat">
          <b>{{ totalCameras }}</b>
          <span>相机</span>
        </div>
      </div>
    </header>

    <section class="panel">
      <div class="toolbar">
        <label class="search">
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M13 13 L17.5 17.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input v-model="keyword" type="text" placeholder="搜索编号 / 路口 / 道路" />
          <button v-if="keyword" type="button" class="clear" @click="keyword = ''">×</button>
        </label>
        <div class="actions">
          <button type="button" class="ghost" :disabled="loading" @click="load">
            {{ loading ? '刷新中…' : '刷新' }}
          </button>
          <button type="button" class="primary" @click="openCreate">+ 新增点位</button>
        </div>
      </div>

      <p v-if="listError" class="banner">
        {{ listError }}
        <button type="button" @click="load">重试</button>
      </p>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>编号</th>
              <th>路口</th>
              <th>道路交叉</th>
              <th>坐标（经度, 纬度）</th>
              <th>相机</th>
              <th>来源</th>
              <th class="ops-head">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="point in filtered" :key="point.id">
              <td class="mono">{{ point.code }}</td>
              <td class="strong">{{ point.name }}</td>
              <td class="muted">{{ point.roads || '—' }}</td>
              <td class="mono muted">{{ fmtCoord(point.lng) }}, {{ fmtCoord(point.lat) }}</td>
              <td>
                <span class="badge" :title="(point.cameras || []).map((cam) => cam.scene).join('\n')">
                  {{ point.cameras?.length || 0 }} 台
                </span>
              </td>
              <td>
                <span class="origin" :class="{ manual: point.origin === 1 }">
                  {{ point.origin === 1 ? '手动' : '内置' }}
                </span>
              </td>
              <td class="ops">
                <button type="button" @click="openEdit(point)">编辑</button>
                <button type="button" class="danger" @click="askRemove(point)">删除</button>
              </td>
            </tr>
            <tr v-if="loading && !points.length">
              <td colspan="7" class="empty">正在加载点位…</td>
            </tr>
            <tr v-else-if="!filtered.length">
              <td colspan="7" class="empty">
                {{ keyword ? '没有匹配的点位' : '暂无点位，点击右上角新增' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 新增 / 编辑 -->
    <div v-if="dialogOpen" class="overlay" @click.self="closeDialog">
      <div class="dialog" role="dialog" aria-modal="true">
        <header class="dialog-head">
          <div>
            <p class="eyebrow">{{ editingId ? 'EDIT' : 'CREATE' }}</p>
            <h2>{{ editingId ? '编辑监控点位' : '新增监控点位' }}</h2>
          </div>
          <button type="button" class="close" title="关闭" @click="closeDialog">×</button>
        </header>

        <form class="dialog-body" @submit.prevent="submit">
          <section class="group">
            <h3>点位信息</h3>
            <div class="grid two">
              <label class="field">
                <span>点位编号 <i>*</i></span>
                <input v-model="form.code" type="text" placeholder="如：泉秀刺桐" />
              </label>
              <label class="field">
                <span>路口名称 <i>*</i></span>
                <input v-model="form.name" type="text" placeholder="如：泉秀刺桐" />
              </label>
            </div>
            <label class="field">
              <span>道路交叉</span>
              <input v-model="form.roads" type="text" placeholder="如：泉秀街 × 刺桐路" />
            </label>
            <div class="grid two">
              <label class="field">
                <span>经度 <i>*</i></span>
                <input v-model="form.lng" type="number" step="0.000001" placeholder="118.600840" />
              </label>
              <label class="field">
                <span>纬度 <i>*</i></span>
                <input v-model="form.lat" type="number" step="0.000001" placeholder="24.890140" />
              </label>
            </div>
            <div class="geo-row">
              <button type="button" class="geo" @click="identifyCoords">识别坐标</button>
              <span v-if="geoStatus" class="geo-status" :class="{ ok: geoStatus.startsWith('已识别') }">
                {{ geoStatus }}
              </span>
            </div>
          </section>

          <section class="group">
            <div class="group-head">
              <h3>相机信息</h3>
              <button type="button" class="ghost small" @click="addCamera">+ 添加相机</button>
            </div>

            <p v-if="!form.cameras.length" class="no-camera">
              暂无相机，可点击「添加相机」补充
            </p>

            <div v-for="(camera, index) in form.cameras" :key="index" class="camera-row">
              <label class="field">
                <span>相机名称</span>
                <input v-model="camera.scene" type="text" placeholder="如：泉秀街刺桐路交通" />
              </label>
              <label class="field type">
                <span>类型</span>
                <select v-model="camera.type">
                  <option v-for="option in CAMERA_TYPES" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>
              <label class="field dir">
                <span>朝向</span>
                <select v-model="camera.dir" @change="syncBearing(camera)">
                  <option v-for="option in DIR_OPTIONS" :key="option.label" :value="option.label">
                    {{ option.label }}向
                  </option>
                </select>
              </label>
              <button
                type="button"
                class="remove-cam"
                title="删除该相机"
                @click="removeCamera(index)"
              >
                ×
              </button>
            </div>
          </section>

          <p v-if="formError" class="form-error">{{ formError }}</p>

          <footer class="dialog-foot">
            <button type="button" class="ghost" :disabled="saving" @click="closeDialog">取消</button>
            <button type="submit" class="primary" :disabled="saving">
              {{ saving ? '保存中…' : editingId ? '保存修改' : '确认新增' }}
            </button>
          </footer>
        </form>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="removing" class="overlay" @click.self="removing = null">
      <div class="confirm" role="alertdialog" aria-modal="true">
        <h3>删除点位</h3>
        <p>
          确定删除「{{ removing.name }}」及其 {{ removing.cameras?.length || 0 }} 台相机？
          此操作不可撤销。
        </p>
        <div class="confirm-actions">
          <button type="button" class="ghost" :disabled="removingBusy" @click="removing = null">
            取消
          </button>
          <button type="button" class="danger-solid" :disabled="removingBusy" @click="confirmRemove">
            {{ removingBusy ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.manage {
  --paper: #f1ebdf;
  --paper-deep: #e7dfd0;
  --ink: #241f1a;
  --ink-soft: #6b5f51;
  --vermilion: #b23a2f;
  --indigo: #23475e;
  --hairline: rgba(52, 40, 28, 0.16);

  min-height: 100%;
  padding: 30px clamp(18px, 4vw, 56px) 56px;
  background-color: var(--paper);
  background-image:
    radial-gradient(circle at 12% 6%, rgba(178, 58, 47, 0.055), transparent 42%),
    radial-gradient(circle at 90% 94%, rgba(35, 71, 94, 0.07), transparent 46%),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");
  color: var(--ink);
  font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  max-width: 1180px;
  margin: 0 auto 22px;
}

.head-left {
  display: flex;
  align-items: flex-start;
  gap: 20px;
}

.back {
  padding: 7px 12px;
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--ink-soft);
  text-decoration: none;
  white-space: nowrap;
  background: rgba(255, 252, 245, 0.65);
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 2px;
  transition: 0.18s;
}

.back:hover {
  color: var(--paper);
  background: var(--ink);
  border-color: var(--ink);
}

.eyebrow {
  margin: 0 0 8px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 2.4px;
  color: var(--vermilion);
}

.title {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 30px;
  letter-spacing: 2px;
}

.stats {
  display: flex;
  gap: 26px;
  padding-bottom: 2px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: right;
}

.stat b {
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
}

.stat span {
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--ink-soft);
}

.panel {
  max-width: 1180px;
  margin: 0 auto;
  background: rgba(255, 252, 245, 0.72);
  border: 1px solid rgba(52, 40, 28, 0.18);
  box-shadow: 0 8px 30px rgba(52, 40, 28, 0.08);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--hairline);
}

.search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 360px;
  height: 34px;
  padding: 0 10px;
  color: var(--ink-soft);
  background: rgba(241, 235, 223, 0.8);
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 2px;
}

.search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--ink);
  background: transparent;
  border: 0;
  outline: none;
}

.search input::placeholder {
  color: rgba(107, 95, 81, 0.7);
}

.clear {
  padding: 0;
  width: 18px;
  height: 18px;
  font-size: 14px;
  line-height: 1;
  color: var(--ink-soft);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.actions {
  display: flex;
  gap: 8px;
}

.ghost,
.primary,
.danger-solid {
  padding: 7px 14px;
  font-family: inherit;
  font-size: 11.5px;
  letter-spacing: 0.6px;
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.ghost {
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.3);
}

.ghost:hover:not(:disabled) {
  color: var(--ink);
  border-color: var(--ink);
}

.primary {
  color: var(--paper);
  background: var(--vermilion);
  border: 1px solid var(--vermilion);
}

.primary:hover:not(:disabled) {
  background: #8f2e26;
  border-color: #8f2e26;
}

.danger-solid {
  color: var(--paper);
  background: var(--vermilion);
  border: 1px solid var(--vermilion);
}

.danger-solid:hover:not(:disabled) {
  background: #8f2e26;
}

.ghost:disabled,
.primary:disabled,
.danger-solid:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ghost.small {
  padding: 5px 10px;
  font-size: 10.5px;
}

.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
  padding: 10px 16px;
  font-size: 11.5px;
  color: var(--vermilion);
  background: rgba(178, 58, 47, 0.07);
  border-bottom: 1px solid rgba(178, 58, 47, 0.2);
}

.banner button {
  padding: 3px 9px;
  font-family: inherit;
  font-size: 10.5px;
  color: var(--vermilion);
  background: transparent;
  border: 1px solid rgba(178, 58, 47, 0.4);
  border-radius: 2px;
  cursor: pointer;
}

.table-wrap {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.table th {
  padding: 11px 14px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.4px;
  color: var(--ink-soft);
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--hairline);
}

.table td {
  padding: 12px 14px;
  border-bottom: 1px dotted rgba(52, 40, 28, 0.16);
  vertical-align: middle;
}

.table tbody tr:hover {
  background: rgba(178, 58, 47, 0.035);
}

.table tr:last-child td {
  border-bottom: 0;
}

.mono {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 11.5px;
}

.strong {
  font-weight: 600;
  letter-spacing: 0.4px;
}

.muted {
  color: var(--ink-soft);
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 10.5px;
  color: var(--indigo);
  background: rgba(35, 71, 94, 0.08);
  border: 1px solid rgba(35, 71, 94, 0.22);
  border-radius: 99px;
  white-space: nowrap;
}

.origin {
  padding: 2px 7px;
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--ink-soft);
  background: rgba(52, 40, 28, 0.06);
  border: 1px solid rgba(52, 40, 28, 0.18);
  border-radius: 2px;
  white-space: nowrap;
}

.origin.manual {
  color: var(--vermilion);
  background: rgba(178, 58, 47, 0.06);
  border-color: rgba(178, 58, 47, 0.28);
}

.ops-head {
  text-align: right;
}

.ops {
  text-align: right;
  white-space: nowrap;
}

.ops button {
  padding: 4px 9px;
  font-family: inherit;
  font-size: 11px;
  color: var(--indigo);
  background: transparent;
  border: 1px solid rgba(35, 71, 94, 0.32);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.16s;
}

.ops button:hover {
  color: var(--paper);
  background: var(--indigo);
  border-color: var(--indigo);
}

.ops button.danger {
  margin-left: 6px;
  color: var(--vermilion);
  border-color: rgba(178, 58, 47, 0.35);
}

.ops button.danger:hover {
  color: var(--paper);
  background: var(--vermilion);
  border-color: var(--vermilion);
}

.empty {
  padding: 42px 16px !important;
  font-size: 12px;
  letter-spacing: 1px;
  color: var(--ink-soft);
  text-align: center;
}

/* ---------- 弹窗 ---------- */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(36, 31, 26, 0.42);
  backdrop-filter: blur(2px);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: calc(100vh - 40px);
  background: #f7f2e8;
  border: 1px solid rgba(52, 40, 28, 0.28);
  box-shadow: 0 24px 60px rgba(36, 31, 26, 0.32);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--hairline);
}

.dialog-head h2 {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 22px;
  letter-spacing: 1.5px;
}

.close {
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 20px;
  line-height: 1;
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.16s;
}

.close:hover {
  color: var(--paper);
  background: var(--ink);
  border-color: var(--ink);
}

.dialog-body {
  overflow-y: auto;
  padding: 20px 24px 22px;
}

.group + .group {
  margin-top: 22px;
  padding-top: 20px;
  border-top: 1px solid var(--hairline);
}

.group h3 {
  margin: 0 0 12px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 2px;
  color: #3c3229;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.group-head h3 {
  margin: 0;
}

.grid {
  display: grid;
  gap: 12px;
}

.grid.two {
  grid-template-columns: 1fr 1fr;
  margin-bottom: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field > span {
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--ink-soft);
}

.field > span i {
  font-style: normal;
  color: var(--vermilion);
}

.field input,
.field select {
  height: 36px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--ink);
  background: rgba(241, 235, 223, 0.85);
  border: 1px solid rgba(52, 40, 28, 0.26);
  border-radius: 2px;
  outline: none;
  transition: 0.16s;
}

.field input:focus,
.field select:focus {
  border-color: var(--vermilion);
  background: #fffdf7;
  box-shadow: 0 0 0 2px rgba(178, 58, 47, 0.1);
}

.geo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 26px;
  margin-top: 10px;
}

.geo {
  flex: none;
  padding: 5px 11px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 0.8px;
  color: var(--indigo);
  background: transparent;
  border: 1px solid rgba(35, 71, 94, 0.42);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.16s;
}

.geo:hover {
  color: var(--paper);
  background: var(--indigo);
}

.geo-status {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--ink-soft);
}

.geo-status.ok {
  color: #0f7d68;
}

.camera-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 118px 108px 32px;
  align-items: end;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px dashed rgba(52, 40, 28, 0.16);
}

.camera-row:first-of-type {
  padding-top: 0;
}

.remove-cam {
  height: 36px;
  font-size: 17px;
  line-height: 1;
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.2);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.16s;
}

.remove-cam:hover {
  color: var(--paper);
  background: var(--vermilion);
  border-color: var(--vermilion);
}

.no-camera {
  margin: 0;
  padding: 12px 0;
  font-size: 11px;
  color: var(--ink-soft);
}

.form-error {
  margin: 16px 0 0;
  font-size: 11.5px;
  color: var(--vermilion);
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--hairline);
}

.confirm {
  width: min(380px, 100%);
  padding: 24px;
  background: #f7f2e8;
  border: 1px solid rgba(52, 40, 28, 0.28);
  box-shadow: 0 24px 60px rgba(36, 31, 26, 0.32);
}

.confirm h3 {
  margin: 0 0 10px;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 18px;
  letter-spacing: 1px;
}

.confirm p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-soft);
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

@media (max-width: 720px) {
  .head {
    align-items: flex-start;
    flex-direction: column;
    gap: 16px;
  }

  .head-left {
    gap: 12px;
  }

  .stats {
    gap: 20px;
  }

  .stat {
    text-align: left;
  }

  .toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .search {
    max-width: none;
  }

  .actions {
    justify-content: flex-end;
  }

  .grid.two,
  .camera-row {
    grid-template-columns: 1fr;
  }

  .remove-cam {
    width: 100%;
  }
}
</style>
