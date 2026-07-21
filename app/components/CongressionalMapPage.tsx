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
    <div className="flex flex-col gap-10">
      {/* Hero — the thesis, opened with the platform's own promise. */}
      <section>
        <h1 className="font-display max-w-4xl text-[2.5rem] font-medium leading-[1.05] tracking-[-0.02em] text-ink text-balance sm:text-[3.25rem]">
          Follow the money in Congress.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-body text-pretty">
          Every disclosed trade, dollar of net worth, and PAC check —
          consolidated, sourced, and turned into a forward read on what members
          are likely to trade next.
        </p>
      </section>

      <div className="ledger-rule" role="presentation" />

      {/* The live artifact — start the investigation from a district. */}
      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="field-label">Start with a district</h2>
          <span className="field-label">119th Congress</span>
        </div>

        {loadError ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {loadError}
          </div>
        ) : null}

        {memberLoadError ? (
          <div className="rounded-xl border border-line bg-white px-4 py-3 text-sm text-body">
            {memberLoadError}
          </div>
        ) : null}

        <CongressionalMap districtGeoJson={districts} members={members} />
      </section>
    </div>
  )
}
