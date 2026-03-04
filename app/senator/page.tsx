import Link from "next/link"

export default function SenatorIndexPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <div className="rounded-3xl border border-slate-200 bg-white px-6 py-8 shadow-sm">
          <h1 className="text-3xl font-bold tracking-tight">Senator Details</h1>
          <p className="mt-2 text-sm text-slate-600">
            Open a senator from the Senate rankings page to view that
            senator&apos;s profile.
          </p>
          <Link
            href="/Senate"
            className="mt-4 inline-flex rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
          >
            Back to Senate
          </Link>
        </div>
      </div>
    </main>
  )
}
