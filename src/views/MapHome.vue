<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import quanzhouGeo from '@/assets/geo/licheng-fengze.json'
import roadData from '@/assets/geo/main-roads.json'
import monitorData from '@/assets/geo/monitor-points.json'

const roads = roadData.roads
const intersections = monitorData.intersections

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

const mapEl = ref(null)
const selectedRoad = ref('')
const showLabels = ref(true)
const loaded = ref(false)
const activePoint = ref('')
const railOpen = ref(true)
const panelOpen = ref(window.innerWidth > 1180)

let map = null
let districtLayer = null
let districtBounds = null
let labelLayerGroup = null
const layersByRoad = {}
const camMarkers = {}

const DISTRICT_LABEL_POS = { '350502': [0.34, 0.16], '350503': [0.84, 0.56] }

const widthOf = (type, tier) =>
  tier === 'minor' ? 1.05 : type === 'trunk' ? 3.4 : type === 'primary' ? 2.4 : 1.8

function fitPadding() {
  if (window.innerWidth <= 660) {
    return { paddingTopLeft: [28, 28], paddingBottomRight: [28, 96] }
  }
  return { paddingTopLeft: [18, 22], paddingBottomRight: [30, 48] }
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

const CAM_COLOR = { traffic: '#e8452c', ptz: '#0f9d8f' }

// 每个路口一台相机一支朝向箭头，箭头从路口中心朝镜头方向指出去
function cameraIcon(item, active, compact = false) {
  if (compact) {
    const color = item.cameras.some((c) => c.type === 'traffic') ? CAM_COLOR.traffic : CAM_COLOR.ptz
    const ticks = item.cameras
      .map(
        (cam) =>
          `<g transform="rotate(${cam.bearing} 12 12)"><line x1="12" y1="7" x2="12" y2="3" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/></g>`,
      )
      .join('')
    return L.divIcon({
      className: 'cam-point',
      html: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        ${active ? '<circle class="cam-ring" cx="12" cy="12" r="9" fill="none" stroke="#20d9a2" stroke-width="1.2" stroke-dasharray="2.5 3"/>' : ''}
        ${ticks}
        <circle cx="12" cy="12" r="3.6" fill="#1b1e23" stroke="#f7f2e7" stroke-width="1.4"/>
      </svg>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    })
  }

  const n = item.cameras.length
  const arrows = item.cameras
    .map((cam, i) => {
      const offset = (i - (n - 1) / 2) * 7
      const color = CAM_COLOR[cam.type] ?? '#1b1e23'
      return `<g transform="rotate(${cam.bearing} 32 32) translate(${offset} 0)">
        <line x1="32" y1="21" x2="32" y2="11.5" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M32 4.5 L${32 - 3.6} 11.5 L${32 + 3.6} 11.5 Z" fill="${color}"/>
      </g>`
    })
    .join('')
  return L.divIcon({
    className: 'cam-point',
    html: `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
      ${active ? '<circle class="cam-ring" cx="32" cy="32" r="15.5" fill="none" stroke="#20d9a2" stroke-width="1.4" stroke-dasharray="3 4"/>' : ''}
      ${arrows}
      <circle cx="32" cy="32" r="6" fill="#1b1e23" stroke="#f7f2e7" stroke-width="2"/>
    </svg>`,
    iconSize: [64, 64],
    iconAnchor: [32, 32],
  })
}

// 视野缩小时收成小圆点，避免 19 个路口挤在一处
function updateCameraIcons() {
  if (!map) return
  const compact = map.getZoom() < 13
  intersections.forEach((item) => {
    camMarkers[item.id]?.setIcon(cameraIcon(item, item.id === activePoint.value, compact))
  })
}

function selectPoint(id) {
  activePoint.value = activePoint.value === id ? '' : id
  const compact = map && map.getZoom() < 13
  intersections.forEach((item) => {
    camMarkers[item.id]?.setIcon(cameraIcon(item, item.id === activePoint.value, compact))
  })
  if (!activePoint.value) return
  const item = intersections.find((x) => x.id === activePoint.value)
  if (!item || !map) return
  if (window.innerWidth <= 1180) panelOpen.value = true
  map.flyTo([item.lat, item.lng], Math.max(map.getZoom(), 15.5), { duration: 0.6 })
  requestAnimationFrame(() => {
    document.querySelector(`[data-point="${item.id}"]`)?.scrollIntoView({ block: 'nearest' })
  })
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

function labelAnchor(road, ratio = 0.5) {
  const longest = road.segments.reduce((a, b) => (a.length >= b.length ? a : b))
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

// 老城核心街巷：无论缩放到哪一级都优先争取名称位置
const OLD_TOWN = new Set([
  '中山北路', '中山中路', '中山南路', '西街', '东街', '新门街', '涂门街',
  '打锡街', '南俊路', '镇抚巷', '承天巷', '庄府巷', '花巷', '敷仁巷',
  '新华南路', '新华北路', '义全街', '天后路',
])

function boxesOverlap(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

// 按优先级做屏幕空间碰撞剔除，保证任意缩放下文字不互相压叠
function updateLabels() {
  if (!map || !labelLayerGroup) return
  labelLayerGroup.clearLayers()
  if (!showLabels.value) return

  const zoom = map.getZoom()
  const candidates = roads
    .filter((road) => {
      if (OLD_TOWN.has(road.name)) return true
      if (road.tier === 'main') return road.total >= 700
      if (zoom >= 14) return road.total >= 350
      if (zoom >= 13) return road.total >= 600
      return road.total >= 1200
    })
    .map((road) => ({
      road,
      score:
        (road.tier === 'main' ? 10 : 1) +
        (LABEL_PRIORITY[road.type] ?? 1) +
        Math.min(road.total / 4000, 2) +
        (OLD_TOWN.has(road.name) ? 12 : 0),
    }))
    .sort((a, b) => b.score - a.score)

  const placed = []
  const isNarrow = window.innerWidth <= 660
  const fontSize = isNarrow ? 9.5 : 10.5
  const charSize = fontSize + 1.5
  const size = map.getSize()
  // 沿道路多个锚点尝试，避免核心街名被相邻标注挤掉
  const RATIOS = [0.5, 0.32, 0.68, 0.18, 0.82]

  for (const item of candidates) {
    const { road } = item
    const vertical = road.dir === 'vertical'
    const w = vertical ? charSize + 6 : road.name.length * charSize + 8
    const h = vertical ? road.name.length * charSize + 8 : charSize + 8

    let chosen = null
    for (const ratio of RATIOS) {
      const point = labelAnchor(road, ratio)
      const p = map.latLngToContainerPoint(point)
      const box = { x: p.x - w / 2, y: p.y - h / 2, w, h }
      if (box.x < 10 || box.y < 10 || box.x + w > size.x - 10 || box.y + h > size.y - 10) continue
      if (placed.some((b) => boxesOverlap(b, box))) continue
      chosen = { point, box }
      break
    }
    if (!chosen) continue
    placed.push(chosen.box)

    const isMain = road.tier === 'main'
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

function togglePanel() {
  panelOpen.value = !panelOpen.value
  relayoutMap()
}

function resetView() {
  selectedRoad.value = ''
  refreshStyles()
  activePoint.value = ''
  intersections.forEach((item) => camMarkers[item.id]?.setIcon(cameraIcon(item, false, true)))
  if (map && districtBounds) {
    map.flyToBounds(districtBounds, { ...fitPadding(), duration: 0.6 })
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
  map.createPane('camPane').style.zIndex = 605

  intersections.forEach((item) => {
    camMarkers[item.id] = L.marker([item.lat, item.lng], {
      icon: cameraIcon(item, false),
      keyboard: false,
      riseOnHover: true,
      pane: 'camPane',
    })
      .bindTooltip(`${item.name} · ${item.cameras.length} 台`, {
        direction: 'top',
        offset: [0, -20],
        className: 'cam-tip',
      })
      .on('click', () => selectPoint(item.id))
      .addTo(map)
  })

  L.control.zoom({ position: 'topright' }).addTo(map)

  map.on('zoomend', () => {
    updateLabels()
    updateCameraIcons()
  })
  map.fitBounds(districtBounds, { ...fitPadding(), animate: false })
  map.setMaxBounds(districtBounds.pad(0.08))
  updateLabels()
  updateCameraIcons()

  loaded.value = true
})

let resizeTimer = null
let wasWide = window.innerWidth > 1180

function handleResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (!map) return
    const wide = window.innerWidth > 1180
    if (wide !== wasWide) {
      wasWide = wide
      panelOpen.value = wide
    }
    map.invalidateSize({ animate: false })
    if (districtBounds) map.fitBounds(districtBounds, { ...fitPadding(), animate: false })
    updateLabels()
    updateCameraIcons()
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
        <div class="foot-actions">
          <span>OSM 数据 · 已裁切两区</span>
          <button type="button" class="reset" @click="resetView">复位</button>
        </div>
      </footer>
    </aside>

    <main class="stage">
      <div ref="mapEl" class="map" :class="{ 'is-loaded': loaded }"></div>

      <div class="frame">
        <span class="corner tl"></span>
        <span class="corner tr"></span>
        <span class="corner bl"></span>
        <span class="corner br"></span>
      </div>

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
      <button v-if="loaded && !panelOpen" type="button" class="mon-toggle" @click="togglePanel">
        点位清单
      </button>
    </main>

    <aside class="monitor" :class="{ open: panelOpen, 'is-closed': !panelOpen }">
      <header class="mon-head">
        <p class="mon-eyebrow">TRAFFIC CAM · {{ monitorData.total.cameras }}</p>
        <h2>路口监控点位</h2>
        <button type="button" class="panel-close mon-close" @click="togglePanel">收起</button>
        <div class="mon-meta">
          <span>{{ monitorData.total.intersections }} 个路口</span>
          <span>{{ monitorData.total.cameras }} 路相机</span>
        </div>
        <div class="mon-legend">
          <span><i class="dot traffic"></i>路口交通机</span>
          <span><i class="dot ptz"></i>联动快球</span>
        </div>
      </header>

      <ul class="mon-list">
        <li
          v-for="(item, idx) in intersections"
          :key="item.id"
          :data-point="item.id"
          :class="{ on: activePoint === item.id }"
        >
          <button type="button" class="mon-row" @click="selectPoint(item.id)">
            <span class="mon-no">{{ String(idx + 1).padStart(2, '0') }}</span>
            <span class="mon-name">{{ item.name }}</span>
            <span class="mon-road">{{ item.roads }}</span>
            <span class="mon-count">{{ item.cameras.length }}</span>
          </button>
          <ul v-if="activePoint === item.id" class="cam-list">
            <li v-for="(cam, ci) in item.cameras" :key="ci">
              <i class="cam-dot" :class="cam.type"></i>
              <span class="cam-scene">{{ cam.scene }}</span>
              <b class="cam-dir">{{ cam.dir }}</b>
            </li>
          </ul>
        </li>
      </ul>
    </aside>
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
  width: 240px;
  flex-shrink: 0;
  padding: 26px 16px 18px;
  background: linear-gradient(180deg, rgba(255, 252, 245, 0.72), rgba(231, 223, 208, 0.65));
  border-right: 1px solid var(--hairline);
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.5) inset;
  transition: margin-left 0.32s ease;
}

.rail.is-closed {
  margin-left: -240px;
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
  padding-right: 46px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 8.5px;
  letter-spacing: 1.8px;
  color: var(--ink-soft);
  opacity: 0.75;
}

.title {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: 34px;
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
  flex-wrap: wrap;
  gap: 6px 14px;
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

/* ---------- Leaflet 内标注 ---------- */
:deep(.district-name-wrap) {
  background: transparent;
  border: 0;
}

:deep(.district-name) {
  display: block;
  transform: translate(-50%, -50%);
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 17px;
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
  font-size: 10.5px;
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
  font-size: 11.5px;
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
  font-size: 10.5px;
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

/* ---------- 右侧监控点位栏 ---------- */
.monitor {
  position: relative;
  z-index: 25;
  display: flex;
  flex-direction: column;
  width: 232px;
  flex-shrink: 0;
  background: #14161a;
  color: #e6dfd1;
  border-left: 1px solid rgba(0, 0, 0, 0.5);
  transition: margin-right 0.32s ease;
}

.monitor.is-closed {
  margin-right: -232px;
}

.mon-head {
  position: relative;
  padding: 22px 16px 14px;
  border-bottom: 1px solid rgba(230, 223, 209, 0.12);
}

.mon-close {
  position: absolute;
  top: 20px;
  right: 16px;
  padding: 3px 8px;
  font-family: inherit;
  font-size: 9.5px;
  letter-spacing: 1px;
  color: #9aa3b1;
  background: transparent;
  border: 1px solid rgba(230, 223, 209, 0.22);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.mon-close:hover {
  color: #14161a;
  background: #20d9a2;
  border-color: #20d9a2;
}

.mon-eyebrow {
  margin: 0 0 10px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 2.2px;
  color: #20d9a2;
  opacity: 0.8;
}

.mon-head h2 {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 2px;
}

.mon-meta {
  display: flex;
  gap: 14px;
  margin-top: 10px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.8px;
  color: #8e97a5;
}

.mon-legend {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  font-size: 10px;
  letter-spacing: 0.5px;
  color: #b9b2a4;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
}

.dot.traffic {
  background: #e8452c;
}

.dot.ptz {
  background: #0f9d8f;
}

.mon-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 6px 0 18px;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: rgba(230, 223, 209, 0.2) transparent;
}

.mon-list::-webkit-scrollbar {
  width: 3px;
}

.mon-list::-webkit-scrollbar-thumb {
  background: rgba(230, 223, 209, 0.2);
}

.mon-list > li {
  border-bottom: 1px solid rgba(230, 223, 209, 0.07);
}

.mon-list > li.on {
  background: rgba(32, 217, 162, 0.07);
}

.mon-row {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  grid-template-areas:
    'no name count'
    'no road count';
  align-items: center;
  gap: 3px 8px;
  width: 100%;
  padding: 10px 16px 10px 15px;
  font-family: inherit;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-left: 2px solid transparent;
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
}

.mon-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.mon-list > li.on .mon-row {
  border-left-color: #20d9a2;
}

.mon-no {
  grid-area: no;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  color: #6d7683;
}

.mon-name {
  grid-area: name;
  font-size: 12.5px;
  letter-spacing: 0.6px;
}

.mon-list > li.on .mon-name {
  color: #20d9a2;
}

.mon-road {
  grid-area: road;
  font-size: 9.5px;
  letter-spacing: 0.3px;
  color: #7f8894;
}

.mon-count {
  grid-area: count;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  color: #d9d2c4;
  border: 1px solid rgba(230, 223, 209, 0.22);
  border-radius: 2px;
}

.cam-list {
  margin: 0 0 10px;
  padding: 0 16px 2px 34px;
  list-style: none;
}

.cam-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  font-size: 10.5px;
  color: #aab2be;
  border-top: 1px dashed rgba(230, 223, 209, 0.08);
}

.cam-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  transform: translateY(-2px);
}

.cam-dot.traffic {
  background: #e8452c;
}

.cam-dot.ptz {
  background: #0f9d8f;
}

.cam-scene {
  flex: 1;
  line-height: 1.5;
  letter-spacing: 0.3px;
}

.cam-dir {
  flex: none;
  font-size: 10px;
  font-weight: 500;
  color: #e6dfd1;
}

.rail-open,
.mon-toggle {
  position: absolute;
  top: 26px;
  z-index: 45;
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--ink);
  background: rgba(249, 245, 237, 0.94);
  border: 1px solid rgba(52, 40, 28, 0.25);
  border-radius: 2px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(52, 40, 28, 0.1);
}

.rail-open {
  left: 26px;
}

.mon-toggle {
  right: 74px;
}

/* ---------- 监控点位标记 ---------- */
:deep(.cam-point) {
  background: transparent;
  border: 0;
}

:deep(.cam-point svg) {
  display: block;
  overflow: visible;
}

:deep(.cam-ring) {
  transform-origin: 32px 32px;
  animation: cam-pulse 2.2s ease-out infinite;
}

@keyframes cam-pulse {
  0% {
    opacity: 0.9;
    transform: scale(0.86);
  }
  70% {
    opacity: 0;
    transform: scale(1.3);
  }
  100% {
    opacity: 0;
  }
}

:deep(.cam-tip) {
  padding: 3px 7px;
  font-size: 10px;
  letter-spacing: 0.5px;
  color: #e6dfd1;
  background: rgba(20, 22, 26, 0.94);
  border: 1px solid rgba(32, 217, 162, 0.35);
  border-radius: 2px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.25);
}

:deep(.cam-tip::before) {
  border-top-color: rgba(32, 217, 162, 0.35);
}

@media (max-width: 1180px) {
  .monitor {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    width: 260px;
    transform: translateX(100%);
    transition: transform 0.32s ease;
    box-shadow: -10px 0 30px rgba(20, 22, 26, 0.22);
  }

  .monitor.open {
    transform: none;
  }

  .monitor.is-closed {
    margin-right: 0;
  }
}

@media (max-width: 660px) {
  .atlas {
    flex-direction: column;
  }

  .rail {
    width: auto;
    max-height: none;
    flex-shrink: 0;
    padding: 18px 18px 12px;
    border-right: 0;
    border-bottom: 1px solid var(--hairline);
  }

  .rail.is-closed {
    display: none;
  }

  .title {
    font-size: 30px;
  }

  .stats {
    padding: 10px 0;
  }

  .stat b {
    font-size: 24px;
  }

  .index {
    display: none;
  }

  .stage {
    flex: 1;
    min-height: 0;
  }

  .edition {
    display: none;
  }

  .compass {
    display: none;
  }

  .rail-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 10px;
  }

  .switch {
    margin-bottom: 0;
  }
}
</style>
