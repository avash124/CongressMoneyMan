"use client"

import * as React from "react"
import type { Feature, FeatureCollection, Geometry } from "geojson"
import type { LngLatBoundsLike } from "mapbox-gl"
import MapComponent, {
  Layer,
  Popup,
  Source,
  type LayerProps,
  type MapMouseEvent,
  type MapRef,
  type ViewState,
} from "react-map-gl/mapbox"
import "mapbox-gl/dist/mapbox-gl.css"

type DistrictFeatureProperties = {
  state?: string
  district?: string | number
  NAME?: string
  STATE?: string
  CD118FP?: string
  [key: string]: unknown
}

type DistrictMember = {
  id?: string
  name?: string
  party?: string
  state?: string
  district?: string | number
}

type PopupState = {
  longitude: number
  latitude: number
  district: EnrichedDistrictProperties
}

type EnrichedDistrictProperties = DistrictFeatureProperties & {
  state: string
  district: string
  memberId?: string
  memberName?: string
  party?: string
  selected: boolean
}

type CongressionalMapProps = {
  districtGeoJson?: FeatureCollection<Geometry, DistrictFeatureProperties> | null
  members?: DistrictMember[]
  accessToken?: string
  selectedDistrictKey?: string | null
  initialViewState?: Partial<ViewState>
  mapStyle?: string
  onDistrictSelect?: (district: EnrichedDistrictProperties) => void
  className?: string
}

const SOURCE_ID = "districts"
const FILL_LAYER_ID = "districts-fill"

const DEFAULT_VIEW_STATE: Partial<ViewState> = {
  latitude: 37.8,
  longitude: -96,
  zoom: 2.85,
}

const USA_BOUNDS: LngLatBoundsLike = [
  [-179, 15],
  [-66, 72],
]

const districtsFillLayer: LayerProps = {
  id: FILL_LAYER_ID,
  type: "fill",
  paint: {
    "fill-color": [
      "case",
      ["==", ["get", "party"], "D"],
      "#2563eb",
      ["==", ["get", "party"], "R"],
      "#dc2626",
      ["==", ["get", "party"], "I"],
      "#6b7280",
      "#94a3b8",
    ],
    "fill-opacity": [
      "case",
      ["boolean", ["get", "selected"], false],
      0.82,
      ["boolean", ["feature-state", "hover"], false],
      0.68,
      0.42,
    ],
  },
}

const districtsLineLayer: LayerProps = {
  id: "districts-line",
  type: "line",
  paint: {
    "line-color": [
      "case",
      ["boolean", ["get", "selected"], false],
      "#0f172a",
      "#334155",
    ],
    "line-width": [
      "case",
      ["boolean", ["get", "selected"], false],
      2,
      ["boolean", ["feature-state", "hover"], false],
      1.4,
      0.7,
    ],
  },
}

function normalizeDistrict(value?: string | number | null): string {
  if (value === undefined || value === null) return ""

  const raw = String(value).trim().toUpperCase()
  if (!raw) return ""
  if (raw === "AL" || raw === "AT LARGE" || raw === "AT-LARGE") return "AL"

  const numeric = Number.parseInt(raw, 10)
  if (Number.isNaN(numeric)) return raw
  if (numeric === 0) return "AL"

  return String(numeric)
}

function getDistrictState(props: DistrictFeatureProperties): string {
  const state = props.state ?? props.STATE
  return typeof state === "string" ? state.trim().toUpperCase() : ""
}

function getDistrictNumber(props: DistrictFeatureProperties): string {
  return normalizeDistrict(props.district ?? props.CD118FP ?? props.NAME)
}

function getDistrictKey(state?: string, district?: string | number | null): string {
  const normalizedState = typeof state === "string" ? state.trim().toUpperCase() : ""
  const normalizedDistrict = normalizeDistrict(district)
  return normalizedState && normalizedDistrict
    ? `${normalizedState}-${normalizedDistrict}`
    : ""
}

function getPartyLabel(party?: string): string {
  if (party === "D") return "Democrat"
  if (party === "R") return "Republican"
  if (party === "I") return "Independent"
  return "Unavailable"
}

function getPartyColor(party?: string): string {
  if (party === "D") return "#2563eb"
  if (party === "R") return "#dc2626"
  if (party === "I") return "#6b7280"
  return "#475569"
}

function EmptyOverlay({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute inset-4 flex items-start">
      <div className="max-w-sm rounded-xl border border-slate-300 bg-white/92 p-4 text-sm text-slate-700 shadow-lg backdrop-blur">
        {message}
      </div>
    </div>
  )
}

export type {
  CongressionalMapProps,
  DistrictFeatureProperties,
  DistrictMember,
  EnrichedDistrictProperties,
}

export default function CongressionalMap({
  districtGeoJson,
  members = [],
  accessToken = process.env.NEXT_PUBLIC_PK_MAP_TOKEN_,
  selectedDistrictKey,
  initialViewState = DEFAULT_VIEW_STATE,
  mapStyle = "mapbox://styles/mapbox/light-v11",
  onDistrictSelect,
  className,
}: CongressionalMapProps) {
  const mapRef = React.useRef<MapRef | null>(null)
  const hoveredFeatureIdRef = React.useRef<string | number | null>(null)
  const [popup, setPopup] = React.useState<PopupState | null>(null)
  const [internalSelectedKey, setInternalSelectedKey] = React.useState<string | null>(null)

  const activeSelectedKey = selectedDistrictKey ?? internalSelectedKey

  const membersByDistrict = React.useMemo(() => {
    return new Map(
      members
        .map((member) => {
          const key = getDistrictKey(member.state, member.district)
          return key ? [key, member] : null
        })
        .filter((entry): entry is [string, DistrictMember] => entry !== null)
    )
  }, [members])

  const enrichedDistricts = React.useMemo<
    FeatureCollection<Geometry, EnrichedDistrictProperties> | null
  >(() => {
    if (!districtGeoJson) return null

    return {
      ...districtGeoJson,
      features: districtGeoJson.features.map((feature, index) => {
        const baseProps = feature.properties ?? {}
        const state = getDistrictState(baseProps)
        const district = getDistrictNumber(baseProps)
        const districtKey = getDistrictKey(state, district)
        const matchedMember = membersByDistrict.get(districtKey)

        return {
          ...feature,
          id: feature.id ?? (districtKey || index),
          properties: {
            ...baseProps,
            state,
            district,
            memberId: matchedMember?.id,
            memberName: matchedMember?.name,
            party: matchedMember?.party,
            selected: districtKey !== "" && districtKey === activeSelectedKey,
          },
        }
      }),
    }
  }, [activeSelectedKey, districtGeoJson, membersByDistrict])

  const clearHoveredFeature = React.useCallback(() => {
    const hoveredId = hoveredFeatureIdRef.current
    if (hoveredId === null) return

    mapRef.current?.getMap().setFeatureState(
      { source: SOURCE_ID, id: hoveredId },
      { hover: false }
    )
    hoveredFeatureIdRef.current = null
  }, [])

  const setHoveredFeature = React.useCallback((featureId: string | number | null) => {
    const map = mapRef.current?.getMap()
    const previousId = hoveredFeatureIdRef.current

    if (!map || previousId === featureId) return

    if (previousId !== null) {
      map.setFeatureState({ source: SOURCE_ID, id: previousId }, { hover: false })
    }

    if (featureId !== null) {
      map.setFeatureState({ source: SOURCE_ID, id: featureId }, { hover: true })
    }

    hoveredFeatureIdRef.current = featureId
  }, [])

  React.useEffect(() => () => clearHoveredFeature(), [clearHoveredFeature])

  const handleMouseMove = React.useCallback((event: MapMouseEvent) => {
    const feature = event.features?.[0] as Feature<Geometry, EnrichedDistrictProperties> | undefined

    if (!feature?.properties) {
      setHoveredFeature(null)
      setPopup(null)
      return
    }

    setHoveredFeature(typeof feature.id === "string" || typeof feature.id === "number" ? feature.id : null)
    setPopup({
      longitude: event.lngLat.lng,
      latitude: event.lngLat.lat,
      district: feature.properties,
    })
  }, [setHoveredFeature])

  const handleMouseLeave = React.useCallback(() => {
    clearHoveredFeature()
    setPopup(null)
  }, [clearHoveredFeature])

  const handleClick = React.useCallback((event: MapMouseEvent) => {
    const feature = event.features?.[0] as Feature<Geometry, EnrichedDistrictProperties> | undefined
    if (!feature?.properties) return

    const district = feature.properties
    const districtKey = getDistrictKey(district.state, district.district)

    setInternalSelectedKey(districtKey || null)
    onDistrictSelect?.(district)
  }, [onDistrictSelect])

  return (
    <div className={className ?? "relative h-[70vh] min-h-[480px] overflow-hidden rounded-2xl border border-slate-300"}>
      {accessToken ? (
        <MapComponent
          ref={mapRef}
          initialViewState={initialViewState}
          mapStyle={mapStyle}
          mapboxAccessToken={accessToken}
          projection="albers"
          maxBounds={USA_BOUNDS}
          minZoom={3}
          maxPitch={0}
          dragRotate={false}
          touchPitch={false}
          renderWorldCopies={false}
          interactiveLayerIds={enrichedDistricts ? [FILL_LAYER_ID] : undefined}
          onMouseMove={enrichedDistricts ? handleMouseMove : undefined}
          onMouseLeave={enrichedDistricts ? handleMouseLeave : undefined}
          onClick={enrichedDistricts ? handleClick : undefined}
          reuseMaps
        >
          {enrichedDistricts ? (
            <Source id={SOURCE_ID} type="geojson" data={enrichedDistricts}>
              <Layer {...districtsFillLayer} />
              <Layer {...districtsLineLayer} />
            </Source>
          ) : null}

          {popup ? (
            <Popup
              anchor="bottom"
              closeButton={false}
              closeOnClick={false}
              longitude={popup.longitude}
              latitude={popup.latitude}
              offset={14}
            >
              <div className="min-w-44 text-sm">
                <div className="font-semibold text-slate-900">
                  {popup.district.state}-{popup.district.district}
                </div>
                <div className="mt-1 text-slate-700">
                  {popup.district.memberName ?? "Member unavailable"}
                </div>
                <div
                  className="mt-1 font-medium"
                  style={{ color: getPartyColor(popup.district.party) }}
                >
                  {getPartyLabel(popup.district.party)}
                </div>
              </div>
            </Popup>
          ) : null}
        </MapComponent>
      ) : (
        <div className="flex h-full items-center justify-center bg-slate-100" />
      )}
    </div>
  )
}
