"use client"

import * as React from "react"
import type { FeatureCollection, Geometry } from "geojson"
import CongressionalMap, { type DistrictMember } from "@/app/components/congressionalMap"

type DistrictFeatureProperties = {
  state?: string
  district?: string | number
  NAME?: string
  STATE?: string
  CD118FP?: string
  [key: string]: unknown
}

export default function CongressionalMapPage() {
  const [districts, setDistricts] = React.useState<
    FeatureCollection<Geometry, DistrictFeatureProperties> | null
  >(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [memberLoadError, setMemberLoadError] = React.useState<string | null>(null)
  const [members, setMembers] = React.useState<DistrictMember[]>([])

  React.useEffect(() => {
    let cancelled = false

    async function loadData() {
      try {
        const [districtResponse, memberResponse] = await Promise.all([
          fetch("/geo/cd119.geojson"),
          fetch("/api/house-members", { cache: "no-store" }),
        ])

        if (!districtResponse.ok) {
          throw new Error(`Request failed with status ${districtResponse.status}`)
        }

        const data = (await districtResponse.json()) as FeatureCollection<
          Geometry,
          DistrictFeatureProperties
        >
        const memberPayload = (await memberResponse.json()) as {
          members?: DistrictMember[]
          error?: string
        }

        if (!cancelled) {
          setDistricts(data)
          setMembers(memberResponse.ok ? (memberPayload.members ?? []) : [])
          setLoadError(null)
          setMemberLoadError(
            memberResponse.ok
              ? null
              : memberPayload.error ??
                  "Congress.gov member data is unavailable right now. District boundaries will still load."
          )
        }
      } catch {
        if (!cancelled) {
          setLoadError(
            "Unable to load /public/geo/cd119.geojson. Check that the file exists and contains valid GeoJSON."
          )
        }
      }
    }

    loadData()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl font-bold tracking-tight text-center">Congressional District Map</h1>
        </div>

        {loadError ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {loadError}
          </div>
        ) : null}

        {memberLoadError ? (
          <div className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700">
            {memberLoadError}
          </div>
        ) : null}

        <CongressionalMap districtGeoJson={districts} members={members} />
      </div>
    </main>
  )
}
