import { createRouter, createWebHistory } from 'vue-router'
import MapHome from '@/views/MapHome.vue'
import MonitorPoints from '@/views/MonitorPoints.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'map-home',
      component: MapHome,
    },
    {
      path: '/points',
      name: 'monitor-points',
      component: MonitorPoints,
    },
  ],
})

export default router
