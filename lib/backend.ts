// Server-side helper for calling the Python backend (backend/) from server
// components. Client components keep fetching relative /api/* URLs, which
// next.config.ts rewrites to the same server.
const BACKEND_URL = process.env.FASTAPI_URL ?? "http://127.0.0.1:8000"

export async function fetchBackend<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      next: { revalidate: 900 },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch (error) {
    console.error(`[backend] ${path} failed:`, error)
    return null
  }
}
