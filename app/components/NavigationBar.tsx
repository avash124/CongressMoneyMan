import Link from "next/link";

export default function Navbar() {
    return(
        <header className="w-full bg-black">
            <div className ="w-full flex justify-between items-center px-0 py-4 text-white">
            <h1 className= "text-xl font-bold pl-4">
                <Link href="/" className="block hover:text-gray-300">Uncle Sam's Stockings</Link>
            </h1>
                
            <nav className="space-x-6 ml-2 pr-4">      
                <Link href="/House" className="hover:text-gray-300">House</Link>
                <Link href="/Senate" className="hover:text-gray-300">Senate</Link>
                <Link href="/map" className="hover:text-gray-300">Map</Link>
                <Link href="/Trades" className="hover:text-gray-300">Trades</Link>
                <Link href="/Profile" className="hover:text-gray-300">Profile</Link>
            </nav>
            </div>
        </header>
    );
}