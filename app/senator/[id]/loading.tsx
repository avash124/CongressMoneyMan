export default function SenatorLoading() {
  return (
    <div style={{ padding: "2rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "2rem",
          padding: "3rem",
        }}
      >
        <div className="flex flex-col gap-3">
          <div className="h-8 w-64 animate-pulse rounded bg-slate-200" />
          <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
          <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
          <div className="mt-2 h-5 w-56 animate-pulse rounded bg-slate-200" />
        </div>
        <div className="h-40 w-64 animate-pulse rounded-xl bg-slate-200" />
      </div>

      <div style={{ marginTop: "2rem" }}>
        <div className="h-48 w-full animate-pulse rounded-xl bg-slate-200" />
      </div>

      <div style={{ marginTop: "2rem" }}>
        <div className="h-48 w-full animate-pulse rounded-xl bg-slate-200" />
      </div>
    </div>
  )
}
