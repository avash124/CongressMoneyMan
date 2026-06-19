import PacDonations from "@/app/components/pacDonations"

export default function PacPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight">PAC Donations</h1>
          <p className="mt-2 text-slate-600">
            Live PAC contributions to House and Senate members, combined and ranked by amount
          </p>
        </div>

        <PacDonations />
      </div>
    </main>
  )
}
