import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import monitorData from '@/assets/geo/monitor-points.json'

const STORAGE_KEY = 'quanzhou-monitor-points-v1'

function cloneDefaults() {
  return JSON.parse(JSON.stringify(monitorData.intersections))
}

function loadPoints() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return cloneDefaults()
    const parsed = JSON.parse(saved)
    return Array.isArray(parsed) && parsed.length ? parsed : cloneDefaults()
  } catch {
    return cloneDefaults()
  }
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
  }
})
