const API_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:8080/api').replace(/\/+$/, '')

async function request(path, options = {}) {
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    })
  } catch {
    throw new Error('无法连接后端服务，请确认后端已在 8080 端口启动')
  }

  if (response.status === 204) return null

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    throw new Error(data?.message || `请求失败（HTTP ${response.status}）`)
  }
  return data
}

/** 查询全部路口（含相机） */
export async function listIntersections() {
  const data = await request('/intersections')
  return data?.intersections ?? []
}

/** 查询单个路口 */
export async function getIntersection(id) {
  const data = await request(`/intersections/${id}`)
  return data?.intersection ?? null
}

/** 新增路口（相机随路口一起提交） */
export async function createIntersection(payload) {
  const data = await request('/intersections', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data?.intersection ?? null
}

/** 更新路口（相机整体替换） */
export async function updateIntersection(id, payload) {
  const data = await request(`/intersections/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  return data?.intersection ?? null
}

/** 删除路口（后端级联删相机） */
export async function deleteIntersection(id) {
  await request(`/intersections/${id}`, { method: 'DELETE' })
}
