"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const LINKS = [
  { href: "/House", label: "House" },
  { href: "/Senate", label: "Senate" },
  { href: "/Trades", label: "Trades" },
  { href: "/Stocks", label: "Stocks" },
  { href: "/PAC", label: "PAC" },
]

export default function Navbar() {
  const pathname = usePathname()

  return (
    <header className="bg-plate text-white">
      <div className="mx-auto max-w-7xl px-6">
        <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          {/* Nameplate — the masthead wordmark, set in the display Didone. */}
          <Link
            href="/"
            className="focus-ring-invert font-display text-[1.4rem] font-medium leading-none tracking-[-0.01em] text-white sm:text-[1.6rem]"
          >
            Uncle Sam&apos;s Stockings
          </Link>

          {/* Section links — a horizontally scrollable rail on small screens. */}
          <nav
            aria-label="Primary"
            className="-mx-6 flex items-center gap-6 overflow-x-auto px-6 text-sm sm:mx-0 sm:overflow-visible sm:px-0"
          >
            {LINKS.map(({ href, label }) => {
              const active = pathname === href
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`focus-ring-invert shrink-0 whitespace-nowrap border-b-2 pb-0.5 font-medium transition-colors ${
                    active
                      ? "border-white text-white"
                      : "border-transparent text-white/65 hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              )
            })}
          </nav>
        </div>
      </div>

      {/* Signature: the double ledger rule closing the nameplate. */}
      <div className="ledger-rule ledger-rule-invert" role="presentation" />
    </header>
  )
}
