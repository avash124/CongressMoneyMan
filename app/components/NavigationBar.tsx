export default function Navbar() {
    return(
        <header className="w-full bg-black">
            <div className ="w-full flex justify-between items-center px-0 py-4 text-white">
            <h1 className= "text-xl font-bold pl-4">
                <a href="/" className="block">Uncle Sam's Stockings</a>
            </h1>

            <nav className="space-x-6 ml-2 pr-4">      
                <a href = "/House" className="hover:text-white-300"> House </a>
                <a href = "/Senate" className="hover:text-white-300"> Senate </a>
                <a href = "/Map" className="hover:text-white-300">Map</a>
                <a href = "/Trades" className="hover:text-white-300"> Trades </a> 
                <a href = "/Profile" className="hover:text-white-300"> Profile </a>
            </nav>
            </div>
        </header>
    );
}