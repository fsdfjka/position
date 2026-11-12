<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import quanzhouGeo from '@/assets/geo/licheng-fengze.json'
import roadData from '@/assets/geo/main-roads.json'
import { listIntersections } from '@/api/intersections'

const roads = roadData.roads

const DIR = {
  horizontal: { label: '横向', color: '#b23a2f' },
  vertical: { label: '纵向', color: '#23475e' },
}

const weightedRoads = [...roads].sort((a, b) => {
  const tierOrder = { minor: 0, main: 1 }
  const order = { secondary: 1, primary: 2, trunk: 3, tertiary: 1, residential: 1, pedestrian: 0, unclassified: 1 }
  const tierDiff = (tierOrder[a.tier] ?? 0) - (tierOrder[b.tier] ?? 0)
  if (tierDiff) return tierDiff
  return (order[a.type] ?? 1) - (order[b.type] ?? 1)
})

const horizontal = computed(() =>
  roads.filter((r) => r.dir === 'horizontal').sort((a, b) => (a.tier === b.tier ? b.total - a.total : a.tier === 'main' ? -1 : 1)),
)
const vertical = computed(() =>
  roads.filter((r) => r.dir === 'vertical').sort((a, b) => (a.tier === b.tier ? b.total - a.total : a.tier === 'main' ? -1 : 1)),
)
const mainCount = computed(() => roads.filter((r) => r.tier === 'main').length)
const minorCount = computed(() => roads.filter((r) => r.tier === 'minor').length)

const searchResults = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return { roads: [] }

  const roadMatches = roads
    .filter((road) => road.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1
      return aStarts - bStarts
    })
    .slice(0, 8)

  return { roads: roadMatches }
})

const hasSearchResults = computed(() => searchResults.value.roads.length > 0)

const mapEl = ref(null)
const selectedRoad = ref('')
const showLabels = ref(true)
const loaded = ref(false)
const railOpen = ref(true)
const searchQuery = ref('')
const searchOpen = ref(false)
const pointsOpen = ref(true)
const activePointId = ref(null)
const expandedId = ref(null)

let map = null
let districtLayer = null
let districtBounds = null
let labelLayerGroup = null
let monitorLayer = null
const layersByRoad = {}
const monitorMarkers = new Map()
const monitorPoints = ref([])

const DISTRICT_LABEL_POS = { '350502': [0.34, 0.16], '350503': [0.84, 0.56] }

const widthOf = (type, tier) =>
  tier === 'minor' ? 1.05 : type === 'trunk' ? 3.4 : type === 'primary' ? 2.4 : 1.8

function fitPadding() {
  if (window.innerWidth <= 660) {
    return { paddingTopLeft: [28, 28], paddingBottomRight: [28, 96] }
  }
  return { paddingTopLeft: [40, 36], paddingBottomRight: [56, 76] }
}

function styleOf(road) {
  const isSelected = selectedRoad.value === road.name
  const dimmed = selectedRoad.value && !isSelected
  return {
    color: DIR[road.dir].color,
    weight: isSelected ? 4.6 : widthOf(road.type, road.tier),
    opacity: dimmed ? 0.1 : road.tier === 'minor' ? 0.45 : 0.88,
    lineCap: 'round',
  }
}

function refreshStyles() {
  roads.forEach((road) => {
    ;(layersByRoad[road.name] ?? []).forEach((layer) => layer.setStyle(styleOf(road)))
  })
}

function selectRoad(name) {
  selectedRoad.value = selectedRoad.value === name ? '' : name
  refreshStyles()
  if (!selectedRoad.value) return
  const layers = layersByRoad[selectedRoad.value] ?? []
  if (!layers.length || !map) return
  map.flyToBounds(L.featureGroup(layers).getBounds(), {
    ...fitPadding(),
    maxZoom: 15,
    duration: 0.6,
  })
}

function clearSelection() {
  if (!selectedRoad.value) return
  selectedRoad.value = ''
  refreshStyles()
}

function pickRoad(name) {
  searchQuery.value = ''
  searchOpen.value = false
  selectRoad(name)
}

function pickFirstSearchResult() {
  const firstRoad = searchResults.value.roads[0]
  if (firstRoad) pickRoad(firstRoad.name)
}

function clearSearch() {
  searchQuery.value = ''
  searchOpen.value = false
}

function addDistrictNames(layer) {
  const props = layer.feature.properties
  const bounds = layer.getBounds()
  const [rx, ry] = DISTRICT_LABEL_POS[props.adcode] ?? [0.5, 0.5]
  const latlng = [
    bounds.getSouth() + (bounds.getNorth() - bounds.getSouth()) * ry,
    bounds.getWest() + (bounds.getEast() - bounds.getWest()) * rx,
  ]
  L.marker(latlng, {
    icon: L.divIcon({
      className: 'district-name-wrap',
      html: `<span class="district-name">${props.name}</span>`,
      iconSize: null,
    }),
    interactive: false,
    keyboard: false,
    pane: 'districtNamePane',
  }).addTo(map)
}

function labelAnchor(road, ratio = 0.5, segments = road.segments) {
  const longest = segments.reduce((a, b) => (a.length >= b.length ? a : b))
  const coords = longest.coords
  const segDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
  let total = 0
  for (let i = 1; i < coords.length; i++) total += segDist(coords[i - 1], coords[i])
  let walked = 0
  for (let i = 1; i < coords.length; i++) {
    const d = segDist(coords[i - 1], coords[i])
    if (walked + d >= total * ratio) {
      const t = d === 0 ? 0 : (total * ratio - walked) / d
      return [
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
      ]
    }
    walked += d
  }
  return [coords[0][1], coords[0][0]]
}

const LABEL_PRIORITY = { trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1.6, residential: 1.2, pedestrian: 0.8, living_street: 0.6 }

const OLD_TOWN = new Set([
  '中山北路', '中山中路', '中山南路', '西街', '东街', '新门街', '涂门街',
  '打锡街', '南俊路', '镇抚巷', '承天巷', '庄府巷', '花巷', '敷仁巷',
  '新华南路', '新华北路', '义全街', '天后路',
])

function boxesOverlap(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
}

function segmentBounds(coords) {
  let south = Infinity
  let west = Infinity
  let north = -Infinity
  let east = -Infinity
  coords.forEach(([lng, lat]) => {
    if (lat < south) south = lat
    if (lat > north) north = lat
    if (lng < west) west = lng
    if (lng > east) east = lng
  })
  return L.latLngBounds([south, west], [north, east])
}

const roadBounds = new Map(
  roads.map((road) => [road, segmentBounds(road.segments.flatMap((segment) => segment.coords))]),
)

function updateLabels() {
  if (!map || !labelLayerGroup) return
  labelLayerGroup.clearLayers()

  const zoom = map.getZoom()
  const size = map.getSize()
  const placed = []

  if (showLabels.value) {
    const viewport = map.getBounds().pad(0.08)
    const isNarrow = window.innerWidth <= 660
    const fontSize = isNarrow ? 11 : 12
    const RATIOS = [0.5, 0.36, 0.64, 0.24, 0.76, 0.12, 0.88]

    const candidates = roads
      .map((road) => {
        const bounds = roadBounds.get(road)
        if (!bounds || !bounds.intersects(viewport)) return null
        const segs = road.segments.filter((segment) => segmentBounds(segment.coords).intersects(viewport))
        return segs.length ? { road, segs } : null
      })
      .filter(Boolean)
      .map((candidate) => ({
        ...candidate,
        score:
          (candidate.road.tier === 'main' ? 20 : 4) +
          (LABEL_PRIORITY[candidate.road.type] ?? 1) * 1.5 +
          Math.min(candidate.road.total / 3000, 3) +
          (OLD_TOWN.has(candidate.road.name) ? 15 : 0),
      }))
      .sort((a, b) => b.score - a.score || a.road.name.localeCompare(b.road.name))

    const labeled = new Set()

    for (const item of candidates) {
      const { road, segs } = item
      if (labeled.has(road.name)) continue
      const vertical = road.dir === 'vertical'
      const isMain = road.tier === 'main'
      const labelSize = isMain ? 13 : fontSize
      const lineH = labelSize * 1.25
      const w = vertical ? labelSize + 10 : road.name.length * (labelSize + 1) + 10
      const h = vertical ? road.name.length * (lineH + 2) + 6 : lineH + 8

      let chosen = null
      for (const ratio of RATIOS) {
        const point = labelAnchor(road, ratio, segs)
        const p = map.latLngToContainerPoint(point)
        const box = { x: p.x - w / 2 - 3, y: p.y - h / 2 - 3, w: w + 6, h: h + 6 }
        if (box.x < 8 || box.y < 8 || box.x + w > size.x - 8 || box.y + h > size.y - 8) continue
        if (placed.some((b) => boxesOverlap(b, box))) continue
        chosen = { point, box }
        break
      }
      if (!chosen) continue
      placed.push(chosen.box)
      labeled.add(road.name)

      const icon = L.divIcon({
        className: 'road-label-wrap',
        html: `<span class="road-label${isMain ? ' main' : ''}${vertical ? ' v' : ''}">${road.name}</span>`,
        iconSize: null,
      })
      L.marker(chosen.point, {
        icon,
        interactive: false,
        keyboard: false,
        pane: 'roadLabelPane',
      }).addTo(labelLayerGroup)
    }
  }
}

function toggleLabels() {
  updateLabels()
}

let layoutTimer = null
function relayoutMap() {
  clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    if (!map) return
    map.invalidateSize({ animate: false })
    updateLabels()
  }, 340)
}

function toggleRail() {
  railOpen.value = !railOpen.value
  relayoutMap()
}

function resetView() {
  selectedRoad.value = ''
  refreshStyles()
  updateLabels()
  if (map && districtBounds) {
    map.flyToBounds(districtBounds, { ...fitPadding(), duration: 0.6 })
  }
}

function monitorPopup(point) {
  const cameras = point.cameras ?? []
  const list = cameras
    .map(
      (camera) =>
        `<li><span>${escapeHtml(camera.scene)}</span><i>${escapeHtml(
          camera.type === 'ptz' ? '联动快球' : '交通枪机',
        )}${camera.dir ? ' · ' + escapeHtml(camera.dir) : ''}</i></li>`,
    )
    .join('')
  return `<div class="monitor-popup">
    <p class="monitor-title">${escapeHtml(point.name)}</p>
    <p class="monitor-roads">${escapeHtml(point.roads || '')}</p>
    ${list ? `<ul class="monitor-cams">${list}</ul>` : '<p class="monitor-roads">暂无相机</p>'}
  </div>`
}

function clampBearing(value) {
  const bearing = Number(value)
  return Number.isFinite(bearing) ? ((bearing % 360) + 360) % 360 : 0
}

function arrowsIcon(cameras) {
  const arrows = cameras
    .map((camera) => {
      const bearing = clampBearing(camera.bearing)
      return `<i class="cam-arrow" style="transform: rotate(${bearing}deg)"><svg viewBox="0 0 10 20" width="10" height="20" aria-hidden="true"><path d="M5 1 L9.2 8.4 L5 6.8 L0.8 8.4 Z" fill="#1f9d55"/><line x1="5" y1="8" x2="5" y2="19" stroke="#1f9d55" stroke-width="1.7" stroke-linecap="round"/></svg></i>`
    })
    .join('')
  return L.divIcon({
    className: 'cam-arrows-wrap',
    html: `<div class="cam-arrows">${arrows}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

function renderMonitorPoints() {
  if (!map || !monitorLayer) return
  monitorLayer.clearLayers()
  monitorMarkers.clear()
  monitorPoints.value.forEach((point) => {
    const lat = Number(point.lat)
    const lng = Number(point.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    const marker = L.circleMarker([lat, lng], {
      pane: 'monitorPointPane',
      className: 'monitor-dot',
      radius: 4.5,
      color: '#f1ebdf',
      weight: 2,
      fillColor: '#241f1a',
      fillOpacity: 1,
    })
      .bindTooltip(point.name, {
        direction: 'top',
        offset: [0, -6],
        className: 'hover-label',
      })
      .bindPopup(monitorPopup(point), {
        className: 'monitor-popup-wrap',
        closeButton: false,
        offset: [0, -3],
      })
      .on('popupopen', () => {
        activePointId.value = point.id
      })
      .on('popupclose', () => {
        if (activePointId.value === point.id) activePointId.value = null
      })
      .addTo(monitorLayer)
    monitorMarkers.set(point.id, marker)

    if (point.cameras?.length) {
      L.marker([lat, lng], {
        icon: arrowsIcon(point.cameras),
        pane: 'monitorPointPane',
        interactive: false,
        keyboard: false,
      }).addTo(monitorLayer)
    }
  })
}

function togglePoint(id) {
  expandedId.value = expandedId.value === id ? null : id
}

function focusPoint(point) {
  if (!map) return
  const lat = Number(point.lat)
  const lng = Number(point.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
  activePointId.value = point.id
  map.flyTo([lat, lng], Math.max(map.getZoom(), 15), { duration: 0.6 })
  monitorMarkers.get(point.id)?.openPopup()
}

async function loadMonitorPoints() {
  try {
    monitorPoints.value = await listIntersections()
    renderMonitorPoints()
  } catch (error) {
    console.warn('监控点位加载失败：', error.message)
  }
}

onMounted(() => {
  map = L.map(mapEl.value, {
    center: [24.9018, 118.597],
    zoom: 13,
    zoomControl: false,
    attributionControl: false,
    minZoom: 11,
    maxZoom: 17,
    zoomSnap: 0.25,
  })

  districtLayer = L.geoJSON(quanzhouGeo, {
    style: (feature) => ({
      color: '#6b5b47',
      weight: 1,
      opacity: 0.55,
      fillColor: feature.properties.adcode === '350502' ? '#b23a2f' : '#23475e',
      fillOpacity: 0.035,
      dashArray: '5 6',
    }),
    onEachFeature: (feature, layer) => {
      layer.on({ click: clearSelection })
    },
  }).addTo(map)

  map.createPane('monitorPointPane').style.zIndex = 590
  map.createPane('roadLabelPane').style.zIndex = 610
  map.createPane('districtNamePane').style.zIndex = 620

  districtLayer.eachLayer(addDistrictNames)
  districtBounds = districtLayer.getBounds()

  weightedRoads.forEach((road) => {
    layersByRoad[road.name] = road.segments.map((segment) =>
      L.polyline(segment.coords.map(([lng, lat]) => [lat, lng]), styleOf(road))
        .bindTooltip(road.name, {
          direction: 'top',
          offset: [0, -6],
          className: 'hover-label',
        })
        .on('click', () => selectRoad(road.name))
        .addTo(map),
    )
  })

  labelLayerGroup = L.layerGroup().addTo(map)
  monitorLayer = L.layerGroup().addTo(map)
  loadMonitorPoints()

  L.control.zoom({ position: 'topright' }).addTo(map)

  map.on('zoomend', () => {
    updateLabels()
  })
  map.fitBounds(districtBounds, { ...fitPadding(), animate: false })
  map.setMaxBounds(districtBounds.pad(0.08))
  updateLabels()

  loaded.value = true
})

let resizeTimer = null

function handleResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (!map) return
    map.invalidateSize({ animate: false })
    if (districtBounds) map.fitBounds(districtBounds, { ...fitPadding(), animate: false })
    updateLabels()
  }, 200)
}

window.addEventListener('resize', handleResize)

onBeforeUnmount(() => {
  clearTimeout(resizeTimer)
  clearTimeout(layoutTimer)
  window.removeEventListener('resize', handleResize)
  if (map) {
    map.remove()
    map = null
  }
})
</script>

<template>
  <div class="atlas">
    <aside class="rail" :class="{ 'is-closed': !railOpen }">
      <div class="rail-head">
        <p class="eyebrow">QUANZHOU · CITY ATLAS 01</p>
        <h1 class="title">鲤城<span class="sep">与</span>丰泽</h1>
        <p class="subtitle">主 干 道 路 网 图</p>
        <button type="button" class="rail-close" @click="toggleRail">收起</button>
      </div>

      <div class="stats">
        <div class="stat">
          <b>{{ mainCount }}</b>
          <span>主干道</span>
        </div>
        <div class="stat">
          <b>{{ minorCount }}</b>
          <span>街 · 巷</span>
        </div>
      </div>

      <div class="legend">
        <span><i class="mark h"></i>横向 · 东西 {{ horizontal.length }}</span>
        <span><i class="mark v"></i>纵向 · 南北 {{ vertical.length }}</span>
      </div>

      <div class="index">
        <section class="index-block">
          <h2><span>01</span>横向 · 东西</h2>
          <ul>
            <li v-for="road in horizontal" :key="road.name">
              <button
                type="button"
                :class="{ on: selectedRoad === road.name, minor: road.tier === 'minor' }"
                @click="selectRoad(road.name)"
              >
                {{ road.name }}
              </button>
            </li>
          </ul>
        </section>
        <section class="index-block">
          <h2><span>02</span>纵向 · 南北</h2>
          <ul>
            <li v-for="road in vertical" :key="road.name">
              <button
                type="button"
                :class="{ on: selectedRoad === road.name, minor: road.tier === 'minor' }"
                @click="selectRoad(road.name)"
              >
                {{ road.name }}
              </button>
            </li>
          </ul>
        </section>
      </div>

      <footer class="rail-foot">
        <label class="switch">
          <input v-model="showLabels" type="checkbox" @change="toggleLabels" />
          <span class="track"></span>
          路名标注
        </label>
        <router-link class="manage-entry" to="/points">
          监控点位管理<span>→</span>
        </router-link>
        <div class="foot-actions">
          <span>OSM 数据 · 已裁切两区</span>
          <button type="button" class="reset" @click="resetView">复位</button>
        </div>
      </footer>
    </aside>

    <main class="stage">
      <div ref="mapEl" class="map" :class="{ 'is-loaded': loaded }"></div>

      <div class="search" :class="{ 'has-results': searchOpen && searchQuery }">
        <div class="search-box">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M13 13 L17.5 17.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索道路关键词"
            aria-label="搜索道路"
            @focus="searchOpen = true"
            @input="searchOpen = true"
            @blur="searchOpen = false"
            @keydown.enter.prevent="pickFirstSearchResult"
            @keydown.esc="clearSearch"
          />
          <button v-if="searchQuery" type="button" class="search-clear" @mousedown.prevent="clearSearch">×</button>
        </div>

        <div v-if="searchOpen && searchQuery" class="search-results">
          <template v-if="searchResults.roads.length">
            <p class="search-group">道路</p>
            <button
              v-for="road in searchResults.roads"
              :key="road.name"
              type="button"
              class="search-item"
              @mousedown.prevent="pickRoad(road.name)"
            >
              <span class="search-road-line"></span>
              <span class="search-main">
                <b>{{ road.name }}</b>
                <i>{{ road.dir === 'vertical' ? '纵向' : '横向' }} · {{ road.type }}</i>
              </span>
            </button>
          </template>

          <p v-if="!hasSearchResults" class="search-empty">未找到相关道路</p>
        </div>
      </div>

      <div class="frame">
        <span class="corner tl"></span>
        <span class="corner tr"></span>
        <span class="corner bl"></span>
        <span class="corner br"></span>
      </div>

      <aside v-if="monitorPoints.length" class="points-panel" :class="{ 'is-closed': !pointsOpen }">
        <header class="points-head">
          <div class="points-title">
            <h2>监控点位</h2>
            <span class="points-count">{{ monitorPoints.length }}</span>
          </div>
          <button type="button" class="points-toggle" @click="pointsOpen = false">收起</button>
        </header>
        <div class="points-list">
          <div v-for="point in monitorPoints" :key="point.id" class="point-card">
            <div class="point-item" :class="{ on: activePointId === point.id }">
              <button type="button" class="point-btn" @click="focusPoint(point)">
                <i class="point-dot"></i>
                <span class="point-main">
                  <b>{{ point.name }}</b>
                  <em>{{ point.roads || '—' }}</em>
                </span>
                <span class="point-count">{{ point.cameras?.length || 0 }}</span>
              </button>
              <button
                type="button"
                class="point-caret"
                :class="{ open: expandedId === point.id }"
                :aria-expanded="expandedId === point.id"
                title="查看该路口的摄像头"
                @click="togglePoint(point.id)"
              >
                ▾
              </button>
            </div>

            <div v-if="expandedId === point.id" class="camera-drop">
              <p v-if="!point.cameras?.length" class="camera-empty">该路口暂无相机</p>
              <div v-for="camera in point.cameras" :key="camera.id" class="camera-line">
                <i
                  class="camera-arrow"
                  :style="{ transform: `rotate(${Number(camera.bearing) || 0}deg)` }"
                >
                  <svg viewBox="0 0 10 20" width="8" height="16" aria-hidden="true">
                    <path d="M5 1 L9.2 8.4 L5 6.8 L0.8 8.4 Z" fill="#1f9d55" />
                    <line x1="5" y1="8" x2="5" y2="19" stroke="#1f9d55" stroke-width="1.8" stroke-linecap="round" />
                  </svg>
                </i>
                <span class="camera-scene">{{ camera.scene }}</span>
                <span class="camera-dir">{{ camera.dir || '—' }}</span>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <button
        v-if="monitorPoints.length && !pointsOpen"
        type="button"
        class="points-open"
        @click="pointsOpen = true"
      >
        监控点位
      </button>

      <div class="compass" aria-hidden="true">
        <svg viewBox="0 0 40 56" width="30" height="42">
          <path d="M20 2 L28 34 L20 28 L12 34 Z" fill="#241f1a" opacity="0.82" />
          <text x="20" y="50" text-anchor="middle" font-size="10" fill="#6b5f51">N</text>
        </svg>
      </div>

      <div class="edition">
        <span>区域裁剪 · 鲤城区 / 丰泽区</span>
        <span class="coord">24.90°N · 118.59°E</span>
      </div>

      <div v-if="!loaded" class="loading">正在铺绘路网…</div>
      <button v-if="loaded && !railOpen" type="button" class="rail-open" @click="toggleRail">图鉴</button>
    </main>
  </div>
</template>

<style scoped>
.atlas {
  --paper: #f1ebdf;
  --paper-deep: #e7dfd0;
  --ink: #241f1a;
  --ink-soft: #6b5f51;
  --vermilion: #b23a2f;
  --indigo: #23475e;
  --hairline: rgba(52, 40, 28, 0.16);

  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-color: var(--paper);
  background-image:
    radial-gradient(circle at 16% 8%, rgba(178, 58, 47, 0.055), transparent 40%),
    radial-gradient(circle at 88% 92%, rgba(35, 71, 94, 0.07), transparent 46%),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");
  color: var(--ink);
  font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}

/* ---------- 左侧图鉴栏 ---------- */
.rail {
  position: relative;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: 316px;
  flex-shrink: 0;
  padding: 34px 26px 22px;
  background: linear-gradient(180deg, rgba(255, 252, 245, 0.72), rgba(231, 223, 208, 0.65));
  border-right: 1px solid var(--hairline);
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.5) inset;
  transition: margin-left 0.32s ease;
}

.rail.is-closed {
  margin-left: -316px;
}

.rail-close {
  position: absolute;
  top: -2px;
  right: 0;
  padding: 3px 8px;
  font-family: inherit;
  font-size: 9.5px;
  letter-spacing: 1px;
  color: var(--ink-soft);
  background: rgba(255, 252, 245, 0.6);
  border: 1px solid rgba(52, 40, 28, 0.22);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.rail-close:hover {
  color: var(--paper);
  background: var(--ink);
  border-color: var(--ink);
}

.rail-head {
  position: relative;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--hairline);
}

.eyebrow {
  margin: 0 0 14px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 2.4px;
  color: var(--ink-soft);
  opacity: 0.75;
}

.title {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: 40px;
  font-weight: 700;
  line-height: 1.06;
  letter-spacing: 2px;
  color: var(--ink);
}

.title .sep {
  display: inline-block;
  margin: 0 6px;
  font-size: 18px;
  font-weight: 400;
  color: var(--vermilion);
  transform: translateY(-6px);
}

.subtitle {
  margin: 12px 0 0;
  font-size: 11px;
  letter-spacing: 5px;
  color: var(--ink-soft);
}

.stats {
  display: flex;
  padding: 18px 0 16px;
  border-bottom: 1px solid var(--hairline);
}

.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stat + .stat {
  padding-left: 18px;
  border-left: 1px solid var(--hairline);
}

.stat b {
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 34px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 1px;
}

.stat span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--ink-soft);
}

.legend {
  display: flex;
  gap: 18px;
  padding: 10px 0 0;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--ink-soft);
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mark {
  width: 12px;
  height: 2px;
  border-radius: 99px;
}

.mark.h {
  background: var(--vermilion);
}

.mark.v {
  background: var(--indigo);
}

.index {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 2px 12px 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(52, 40, 28, 0.22) transparent;
}

.index::-webkit-scrollbar {
  width: 3px;
}

.index::-webkit-scrollbar-thumb {
  background: rgba(52, 40, 28, 0.22);
}

.index-block + .index-block {
  margin-top: 20px;
}

.index-block h2 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 2px;
  color: var(--ink);
}

.index-block h2 span {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 9px;
  color: var(--vermilion);
  letter-spacing: 0;
}

.index-block ul {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.index-block li {
  border-bottom: 1px dotted rgba(52, 40, 28, 0.16);
}

.index-block button {
  width: 100%;
  padding: 5px 0;
  font-family: inherit;
  font-size: 11.5px;
  text-align: left;
  color: var(--ink-soft);
  background: none;
  border: 0;
  cursor: pointer;
  transition: color 0.18s, padding-left 0.18s;
}

.index-block button:hover {
  color: var(--ink);
  padding-left: 3px;
}

.index-block button.minor:not(.on) {
  font-size: 11px;
  color: rgba(107, 95, 81, 0.62);
}

.index-block button.on {
  color: var(--vermilion);
  font-weight: 600;
}

.rail-foot {
  padding-top: 14px;
  border-top: 1px solid var(--hairline);
  font-size: 10px;
  color: var(--ink-soft);
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  cursor: pointer;
  letter-spacing: 1px;
}

.switch input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.switch .track {
  position: relative;
  width: 26px;
  height: 14px;
  border: 1px solid rgba(52, 40, 28, 0.35);
  border-radius: 99px;
  transition: 0.2s;
}

.switch .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-soft);
  transition: 0.2s;
}

.switch input:checked + .track {
  border-color: var(--vermilion);
}

.switch input:checked + .track::after {
  left: 14px;
  background: var(--vermilion);
}

.manage-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding: 7px 10px;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--indigo);
  text-decoration: none;
  background: rgba(35, 71, 94, 0.055);
  border: 1px solid rgba(35, 71, 94, 0.3);
  border-radius: 2px;
  transition: 0.18s;
}

.manage-entry span {
  font-size: 12px;
  line-height: 1;
}

.manage-entry:hover {
  color: var(--paper);
  background: var(--indigo);
  border-color: var(--indigo);
}

.foot-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 9.5px;
  letter-spacing: 0.6px;
  color: rgba(107, 95, 81, 0.85);
}

.reset {
  padding: 4px 9px;
  font-family: inherit;
  font-size: 10px;
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.3);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.reset:hover {
  color: var(--paper);
  background: var(--ink);
  border-color: var(--ink);
}

/* ---------- 地图区 ---------- */
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.stage::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(36, 31, 26, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(36, 31, 26, 0.045) 1px, transparent 1px);
  background-size: 44px 44px;
  pointer-events: none;
}

.map {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: transparent;
  opacity: 0;
  transition: opacity 1s ease 0.1s;
}

.map.is-loaded {
  opacity: 1;
}

.search {
  position: absolute;
  top: 24px;
  left: 50%;
  z-index: 50;
  width: min(420px, calc(100% - 44px));
  transform: translateX(-50%);
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  color: var(--ink-soft);
  background: rgba(249, 245, 237, 0.96);
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 2px;
  box-shadow: 0 3px 14px rgba(52, 40, 28, 0.1);
}

.search-box input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  font-family: inherit;
  font-size: 12.5px;
  letter-spacing: 0.4px;
  color: var(--ink);
  background: transparent;
  border: 0;
  outline: none;
}

.search-box input::placeholder {
  color: rgba(107, 95, 81, 0.7);
}

.search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--ink-soft);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.search-clear:hover {
  color: var(--paper);
  background: var(--ink);
}

.search-results {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 320px;
  overflow-y: auto;
  background: rgba(249, 245, 237, 0.98);
  border: 1px solid rgba(52, 40, 28, 0.2);
  border-radius: 2px;
  box-shadow: 0 12px 28px rgba(52, 40, 28, 0.18);
}

.search-group {
  margin: 0;
  padding: 9px 12px 5px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 1.6px;
  color: rgba(107, 95, 81, 0.85);
}

.search-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 12px;
  font-family: inherit;
  text-align: left;
  color: var(--ink);
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  cursor: pointer;
  transition: 0.16s;
}

.search-item:hover {
  background: rgba(178, 58, 47, 0.06);
  border-left-color: var(--vermilion);
}

.search-road-line {
  flex: none;
  width: 12px;
  height: 2px;
  background: var(--indigo);
}

.search-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.search-main b {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-main i {
  font-size: 9.5px;
  font-style: normal;
  color: var(--ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-empty {
  margin: 0;
  padding: 14px 12px;
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--ink-soft);
  text-align: center;
}

.frame {
  position: absolute;
  inset: 20px;
  z-index: 5;
  border: 1px solid rgba(52, 40, 28, 0.18);
  pointer-events: none;
}

.corner {
  position: absolute;
  width: 14px;
  height: 14px;
}

.corner.tl {
  top: -1px;
  left: -1px;
  border-top: 2px solid var(--ink);
  border-left: 2px solid var(--ink);
}

.corner.tr {
  top: -1px;
  right: -1px;
  border-top: 2px solid var(--ink);
  border-right: 2px solid var(--ink);
}

.corner.bl {
  bottom: -1px;
  left: -1px;
  border-bottom: 2px solid var(--ink);
  border-left: 2px solid var(--ink);
}

.corner.br {
  bottom: -1px;
  right: -1px;
  border-bottom: 2px solid var(--ink);
  border-right: 2px solid var(--ink);
}

.compass {
  position: absolute;
  right: 34px;
  bottom: 68px;
  z-index: 6;
  opacity: 0.85;
  pointer-events: none;
}

.edition {
  position: absolute;
  right: 34px;
  bottom: 32px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 14px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 9px;
  letter-spacing: 1.2px;
  color: var(--ink-soft);
  pointer-events: none;
}

.edition .coord {
  padding-left: 14px;
  border-left: 1px solid rgba(52, 40, 28, 0.25);
}

.loading {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Songti SC', 'STSong', 'SimSun', serif;
  font-size: 13px;
  letter-spacing: 4px;
  color: var(--ink-soft);
  background: var(--paper);
}

/* ---------- 右侧监控点位 ---------- */
.points-panel {
  position: absolute;
  top: 92px;
  right: 24px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: 238px;
  max-height: calc(100% - 190px);
  overflow: hidden;
  background: rgba(249, 245, 237, 0.95);
  border: 1px solid rgba(52, 40, 28, 0.22);
  box-shadow: 0 8px 24px rgba(52, 40, 28, 0.14);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.points-panel.is-closed {
  opacity: 0;
  transform: translateX(14px);
  pointer-events: none;
}

.points-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--hairline);
}

.points-title {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.points-title h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 2px;
  color: var(--ink);
}

.points-count {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9.5px;
  color: var(--vermilion);
}

.points-toggle {
  padding: 2px 6px;
  font-family: inherit;
  font-size: 9.5px;
  letter-spacing: 0.5px;
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.22);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.16s;
}

.points-toggle:hover {
  color: var(--paper);
  background: var(--ink);
  border-color: var(--ink);
}

.points-list {
  overflow-y: auto;
  padding: 4px 6px 6px;
  scrollbar-width: thin;
  scrollbar-color: rgba(52, 40, 28, 0.22) transparent;
}

.points-list::-webkit-scrollbar {
  width: 3px;
}

.points-list::-webkit-scrollbar-thumb {
  background: rgba(52, 40, 28, 0.22);
}

.point-card {
  border-bottom: 1px dotted rgba(52, 40, 28, 0.16);
}

.point-card:last-child {
  border-bottom: 0;
}

.point-item {
  display: flex;
  align-items: center;
  width: 100%;
  transition: 0.16s;
}

.point-item:hover {
  background: rgba(178, 58, 47, 0.05);
}

.point-item.on {
  background: rgba(178, 58, 47, 0.1);
}

.point-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 7px 2px 7px 6px;
  font-family: inherit;
  text-align: left;
  color: var(--ink);
  background: none;
  border: 0;
  cursor: pointer;
}

.point-caret {
  flex: none;
  width: 22px;
  height: 22px;
  margin-right: 2px;
  padding: 0;
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  color: var(--ink-soft);
  background: none;
  border: 0;
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.point-caret:hover {
  color: var(--ink);
  background: rgba(52, 40, 28, 0.08);
}

.point-caret.open {
  color: var(--vermilion);
  transform: rotate(180deg);
}

.camera-drop {
  padding: 2px 8px 8px 22px;
  background: rgba(241, 235, 223, 0.55);
}

.camera-line {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 0;
  font-size: 10px;
  color: var(--ink);
}

.camera-arrow {
  flex: none;
  display: inline-flex;
  width: 8px;
  height: 16px;
  transform-origin: center;
}

.camera-arrow svg {
  display: block;
}

.camera-scene {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.camera-dir {
  flex: none;
  font-size: 9.5px;
  color: #1f7a4d;
}

.camera-empty {
  margin: 0;
  padding: 3px 0;
  font-size: 10px;
  color: var(--ink-soft);
}

.point-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink);
  box-shadow: 0 0 0 2px #f1ebdf, 0 0 0 3px rgba(36, 31, 26, 0.28);
}

.point-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.point-main b {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.point-main em {
  font-style: normal;
  font-size: 9.5px;
  color: var(--ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.point-count {
  flex: none;
  padding: 1px 5px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  color: var(--indigo);
  background: rgba(35, 71, 94, 0.08);
  border-radius: 99px;
}

.points-open {
  position: absolute;
  top: 92px;
  right: 24px;
  z-index: 40;
  padding: 6px 10px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--paper);
  background: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 2px;
  box-shadow: 0 3px 14px rgba(52, 40, 28, 0.25);
  cursor: pointer;
  transition: 0.18s;
}

.points-open:hover {
  color: var(--ink);
  background: transparent;
}

@media (max-width: 660px) {
  .points-panel {
    top: 76px;
    right: 16px;
    width: 196px;
    max-height: 42%;
  }

  .points-open {
    top: 76px;
    right: 16px;
  }
}

/* ---------- Leaflet 内标注 ---------- */
:deep(.district-name-wrap) {
  background: transparent;
  border: 0;
}

:deep(.district-name) {
  display: block;
  transform: translate(-50%, -50%);
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 7px;
  color: rgba(36, 31, 26, 0.3);
  white-space: nowrap;
  pointer-events: none;
}

:deep(.road-label-wrap) {
  background: transparent;
  border: 0;
}

:deep(.road-label) {
  display: block;
  transform: translate(-50%, -50%);
  padding: 0 3px;
  font-size: 12px;
  line-height: 1.25;
  letter-spacing: 0.4px;
  color: #6b5f51;
  white-space: nowrap;
  text-shadow:
    0 0 2px var(--paper),
    0 0 2px var(--paper),
    0 0 3px var(--paper);
  pointer-events: none;
}

:deep(.road-label.main) {
  font-size: 13px;
  font-weight: 600;
  color: #3c3229;
}

:deep(.road-label.v) {
  writing-mode: vertical-rl;
  text-orientation: upright;
  padding: 3px 0;
  letter-spacing: 2px;
}

:deep(.hover-label) {
  padding: 3px 7px;
  font-size: 11.5px;
  letter-spacing: 0.5px;
  color: #3c3229;
  background: rgba(249, 245, 237, 0.96);
  border: 1px solid rgba(52, 40, 28, 0.22);
  border-radius: 2px;
  box-shadow: 0 3px 10px rgba(52, 40, 28, 0.12);
}

:deep(.hover-label::before) {
  border-top-color: rgba(52, 40, 28, 0.22);
}

:deep(.leaflet-control-zoom) {
  margin: 26px 26px 0 0;
  border: 1px solid rgba(52, 40, 28, 0.25);
  border-radius: 2px;
  box-shadow: 0 2px 10px rgba(52, 40, 28, 0.08);
  overflow: hidden;
}

:deep(.leaflet-control-zoom a) {
  width: 28px;
  height: 28px;
  line-height: 27px;
  font-size: 15px;
  color: var(--ink);
  background: rgba(249, 245, 237, 0.92);
  border-bottom-color: rgba(52, 40, 28, 0.16);
}

:deep(.leaflet-control-zoom a:hover) {
  background: var(--paper-deep);
}

.rail-open {
  position: absolute;
  top: 24px;
  left: 16px;
  z-index: 40;
  padding: 6px 12px;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--paper);
  background: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 2px;
  cursor: pointer;
  box-shadow: 0 3px 14px rgba(52, 40, 28, 0.25);
  transition: 0.18s;
}

.rail-open:hover {
  color: var(--ink);
  background: transparent;
}

/* ---------- 监控点位 ---------- */
:deep(.monitor-dot) {
  cursor: pointer;
}

:deep(.cam-arrows-wrap) {
  background: transparent;
  border: 0;
  pointer-events: none;
}

:deep(.cam-arrows) {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
}

:deep(.cam-arrow) {
  position: absolute;
  bottom: 0;
  left: -5px;
  display: block;
  width: 10px;
  height: 20px;
  transform-origin: 5px 20px;
  filter: drop-shadow(0 0 1.5px rgba(241, 235, 223, 0.95));
}

:deep(.cam-arrow svg) {
  display: block;
}

:deep(.monitor-popup-wrap .leaflet-popup-content-wrapper) {
  padding: 0;
  color: var(--ink);
  background: rgba(249, 245, 237, 0.98);
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 2px;
  box-shadow: 0 10px 24px rgba(52, 40, 28, 0.18);
}

:deep(.monitor-popup-wrap .leaflet-popup-content) {
  margin: 10px 12px;
  font-family: inherit;
  line-height: 1.5;
}

:deep(.monitor-popup-wrap .leaflet-popup-tip) {
  background: rgba(249, 245, 237, 0.98);
  border: 1px solid rgba(52, 40, 28, 0.24);
  box-shadow: none;
}

:deep(.monitor-title) {
  margin: 0 0 3px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

:deep(.monitor-roads) {
  margin: 0 0 6px;
  font-size: 10.5px;
  color: var(--ink-soft);
}

:deep(.monitor-cams) {
  margin: 0;
  padding: 0;
  list-style: none;
}

:deep(.monitor-cams li) {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  padding: 3px 0;
  font-size: 10.5px;
  border-top: 1px dotted rgba(52, 40, 28, 0.16);
}

:deep(.monitor-cams i) {
  font-style: normal;
  color: var(--ink-soft);
  white-space: nowrap;
}
</style>
