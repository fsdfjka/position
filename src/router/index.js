import { createRouter, createWebHistory } from 'vue-router'
import MapHome from '@/views/MapHome.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'map-home',
      component: MapHome,
    },
  ],
})

export default router
