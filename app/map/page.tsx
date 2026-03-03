"use client"

import * as React from "react"
import CongressionalMap from "@/app/components/congressionalMap"
import type { FeatureCollection, Geometry } from "geojson"

type DistrictFeatureProperties = {
  state?: string
  district?: string | number
  NAME?: string
  STATE?: string
  CD118FP?: string
  [key: string]: unknown
}

export default function MapPage() {
  const [districts, setDistricts] = React.useState<
    FeatureCollection<Geometry, DistrictFeatureProperties> | null
  >(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false

    async function loadDistricts() {
      try {
        const response = await fetch("/geo/cd119.geojson")
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`)
        }

        const data = (await response.json()) as FeatureCollection<
          Geometry,
          DistrictFeatureProperties
        >

        if (!cancelled) {
          setDistricts(data)
          setLoadError(null)
        }
      } catch {
        if (!cancelled) {
          setLoadError(
            "Unable to load /public/geo/cd119.geojson. Check that the file exists and contains valid GeoJSON."
          )
        }
      }
    }

    loadDistricts()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight">Congressional District Map</h1>
        </div>

        {loadError ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {loadError}
          </div>
        ) : null}

        <CongressionalMap districtGeoJson={districts} />
      </div>
    </main>
  )
}
