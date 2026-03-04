import HouseMembersRankingsNetWorth from "@/app/components/houseMembersRankingsNetWorth"

export default function HousePage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight">
            House Members
          </h1>
        </div>

        <HouseMembersRankingsNetWorth />
      </div>
    </main>
  )
}
