import Link from "next/link";

export default function Navbar() {

return(

<header className="border-b border-gray-200 bg-white">

<div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">

<Link
href="/"
className="text-xl font-bold text-gray-900 hover:text-blue-600"
>
Uncle Sam's Stockings
</Link>

<nav className="flex items-center gap-8 text-sm font-medium text-gray-700">

<Link href="/House" className="hover:text-blue-600 transition">
House
</Link>

<Link href="/Senate" className="hover:text-blue-600 transition">
Senate
</Link>

<Link href="/Trades" className="hover:text-blue-600 transition">
Trades
</Link>

</nav>

</div>

</header>

)

}
