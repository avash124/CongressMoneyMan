"use client"

import{ useRouter } from  "next/navigation" 
import{ useState  } from  "react"

function parseSearch(raw: string): Record<string, string> {
  const s = raw.trim();

  if (/^\d{5}(-\d{4})?$/.test(s)) {
    return { zip: s };
  }
  const districtMatch = s.match(/^([A-Za-z]{2})\s*-?\s*(\d{1,2})$/);
  if (districtMatch) {
    return { state: districtMatch[1].toUpperCase(), district: districtMatch[2] };
  }

  return { name: s };
}

export default function Home() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [chamber, setChamber] = useState("");
  const [stockQuery, setStockQuery] = useState("");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const cleaned = query.trim();
    if (!cleaned) return;

    let filters: Record<string, string>;
    if (chamber === "Senate") {
      filters = { name: cleaned };
    } else {
      filters = parseSearch(cleaned) as Record<string, string>;
    }
    if (chamber) filters.chamber = chamber;
    const params = new URLSearchParams(
      Object.entries(filters).reduce((acc, [key, value]) => {
        acc[key] = String(value);
        return acc;
      }, {} as Record<string, string>)
    );
    router.push(`/search?${params.toString()}`);
  }
  
  function StockSubmit(e: React.FormEvent<HTMLFormElement>){
    e.preventDefault();
    const cleaned = stockQuery.trim();
    if(!cleaned) return;

    const isTicker = /^[A-Z]{1,5}$/.test(cleaned);
    const params = new URLSearchParams({
      [isTicker ? 'ticker' : 'company']: cleaned
    });
    router.push(`/search?${params.toString()}`);
  }
  
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 bg-white text-black">
      <h1 className="text-4xl font-bold mb-3">Representative Search</h1>
      <p className="text-black mb-8">
        {chamber === "Senate" ? "Search by name" : "Search by name, district (CA-47), or zipcode."}
      </p>

      <form onSubmit={onSubmit} className="w-full max-w-xl">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <select
              value={chamber}
              onChange={(e) => setChamber(e.target.value)}
              className="border rounded-lg p-3 outline-none focus:ring-2 focus:ring-black bg-white"
            >
              <option value="House">House</option>
              <option value="Senate">Senate</option>
            </select>
            <input
              className="flex-1 border rounded-lg p-3 outline-none focus:ring-2 focus:ring-black"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="submit"
              className="bg-black text-white rounded-lg px-5 py-3 hover:opacity-90"
            >
              Search
            </button>
          </div>
        </div>
      </form>
      <h2 className="text-4xl font-bold mb-3 mt-8">Stock Search</h2>
      <p className="text-black mb-8">Search by ticker or company name</p>
      <form onSubmit={StockSubmit} className="w-full max-w-xl">
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded-lg p-3 outline-none focus:ring-2 focus:ring-black"
              value={stockQuery}
            onChange={(e) => setStockQuery(e.target.value)}
          />
          <button
            type="submit"
            className="bg-black text-white rounded-lg px-5 py-3 hover:opacity-90"
          >
            Search
          </button>
        </div>
      </form>
    </main>
    
  );
}
