import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import monitorData from '@/assets/geo/monitor-points.json'

const STORAGE_KEY = 'quanzhou-monitor-points-v1'
// 旧版本（地图内就地编辑）使用的键，首次加载时自动迁移
const LEGACY_STORAGE_KEY = 'qz-monitor-points'

function cloneDefaults() {
  return JSON.parse(JSON.stringify(monitorData.intersections))
}

function parseStoredPoints(raw) {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length ? parsed : null
  } catch {
    return null
  }
}

function loadPoints() {
  const saved =
    parseStoredPoints(localStorage.getItem(STORAGE_KEY)) ??
    parseStoredPoints(localStorage.getItem(LEGACY_STORAGE_KEY))
  return saved ?? cloneDefaults()
}

export const useMonitorStore = defineStore('monitor', () => {
  const points = ref(loadPoints())

  const totalIntersections = computed(() => points.value.length)
  const totalCameras = computed(() => points.value.reduce((sum, item) => sum + (item.cameras?.length ?? 0), 0))

  watch(
    points,
    (value) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    },
    { deep: true },
  )

  function nextId() {
    const timestamp = Date.now().toString(36)
    return `point-${timestamp}-${Math.random().toString(36).slice(2, 6)}`
  }

  function addPoint(payload) {
    const point = {
      id: payload.id || nextId(),
      name: payload.name,
      roads: payload.roads,
      lng: Number(payload.lng),
      lat: Number(payload.lat),
      cameras: payload.cameras.map((cam) => normalizeCamera(cam)),
    }
    points.value.push(point)
    return point.id
  }

  function updatePoint(id, payload) {
    const point = points.value.find((item) => item.id === id)
    if (!point) return
    point.name = payload.name
    point.roads = payload.roads
    point.lng = Number(payload.lng)
    point.lat = Number(payload.lat)
    point.cameras = payload.cameras.map((cam) => normalizeCamera(cam))
  }

  function removePoint(id) {
    const index = points.value.findIndex((item) => item.id === id)
    if (index !== -1) points.value.splice(index, 1)
  }

  // 导入 JSON 时整体替换；返回是否成功，失败抛出可读错误
  function replacePoints(list) {
    if (!Array.isArray(list) || !list.length) throw new Error('文件里没有点位数据')
    const mapped = list.map((item) => {
      const lng = Number(item.lng)
      const lat = Number(item.lat)
      if (!item.name || !Number.isFinite(lng) || !Number.isFinite(lat) || !Array.isArray(item.cameras)) {
        throw new Error('点位格式不正确，需要包含 name、lng、lat、cameras')
      }
      return {
        id: item.id || nextId(),
        name: item.name,
        roads: item.roads ?? '',
        lng,
        lat,
        cameras: item.cameras.map((cam) => normalizeCamera(cam)),
      }
    })
    points.value = mapped
  }

  function normalizeCamera(cam) {
    return {
      scene: cam.scene,
      type: cam.type || 'traffic',
      dir: cam.dir,
      bearing: Number(cam.bearing),
    }
  }

  return {
    points,
    totalIntersections,
    totalCameras,
    addPoint,
    updatePoint,
    removePoint,
    replacePoints,
  }
})
