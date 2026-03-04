// app/api/member/[id]/industryClassifier.ts

export const industryKeywords: Record<string, string[]> = {
  Energy: [
    "energy","oil","gas","petroleum","refinery",
    "pipeline","drilling","exploration","coal","natural gas",
    "lng","rig","offshore","onshore","solar",
    "wind","hydro","renewable","biomass","geothermal",
    "utility","utilities","electric","electricity","power",
    "grid","turbine","petrochemical","fracking","exxon",
    "chevron","shell","bp","conoco","total",
    "marathon","oilfield","shale","transmission","generator"
  ],

  Healthcare: [
    "health","healthcare","hospital","clinic","physician",
    "doctor","medical","medicine","pharma","pharmaceutical",
    "biotech","biotechnology","biopharma","vaccine","therapeutics",
    "device","medical device","medtech","diagnostic","lab",
    "laboratory","nursing","care","hospice","medicare",
    "medicaid","clinical","surgical","oncology","cardiology",
    "imaging","radiology","pharmacy","pharmacist","drug",
    "therapy","rehabilitation","healthplan","health system","telehealth"
  ],

  Defense: [
    "defense","aerospace","military","weapons","armament",
    "ordnance","munitions","shipbuilding","navy","army",
    "air force","missile","radar","surveillance","cybersecurity",
    "contractor","defense contractor","lockheed","boeing","raytheon",
    "northrop","general dynamics","bae","l3harris","saic",
    "thales","avionics","drone","unmanned","ballistic",
    "security","weapons systems","shipbuilder","prime contractor","defense research",
    "weapons manufacturer","armored","military supply","defense industrial","arms"
  ],

  Agriculture: [
    "agriculture","agri","farm","farming","farmer",
    "ranch","ranching","cattle","livestock","dairy",
    "poultry","hog","swine","corn","soybean",
    "wheat","grain","commodity","crop","pesticide",
    "fertilizer","agrochemical","seed","seeds","agribusiness",
    "meat","beef","pork","irrigation","orchard",
    "vineyard","greenhouse","feedlot","coop","cooperative",
    "farm bureau","extension","produce","harvest","agronomy"
  ],

  "Real Estate": [
    "real estate","realtor","realty","property","housing",
    "homebuilder","homebuilders","construction","developer","development",
    "landlord","rental","apartment","condominium","condo",
    "mls","commercial real estate","cre","retail center","mall",
    "land","zoning","mortgage broker","property management","homeowner",
    "hoa","subdivision","townhouse","multifamily","single-family",
    "industrial park","office park","strip mall","reit","real estate investment trust",
    "lease","leasing","broker","brokerage","storefront"
  ],

  Communications: [
    "telecom","telecommunications","communications","media","broadcast",
    "cable","satellite","wireless","mobile","isp",
    "internet","broadband","streaming","newspaper","publishing",
    "radio","tv","television","advertising","ad agency",
    "marketing","social media","facebook","twitter","instagram",
    "verizon","att","tmobile","comcast","spectrum",
    "dish","cox","hbo","bbc","podcast",
    "blog","news","press","telephony","carrier"
  ],

  Technology: [
    "tech","technology","software","saas","cloud",
    "ai","artificial intelligence","machine learning","semiconductor","chip",
    "silicon","nvidia","intel","amd","google",
    "microsoft","apple","meta","facebook","oracle",
    "sap","ibm","cybersecurity","security software","startup",
    "developer","programming","database","data center","server",
    "iot","internet of things","automation","robotics","blockchain",
    "crypto","fintech","hardware","electronics","mobile app"
  ],

  Transportation: [
    "transport","transportation","airline","airways","aviation",
    "airport","rail","railroad","freight","trucking",
    "truck","shipping","ship","maritime","port",
    "logistics","courier","delivery","ups","fedex",
    "dhl","automotive","automobile","car","manufacturer",
    "tesla","gm","ford","diesel","bus",
    "transit","subway","metro","rideshare","uber",
    "lyft","taxi","container","intermodal","supply chain"
  ],

  Retail: [
    "retail","retailer","e-commerce","ecommerce","storefront",
    "mall","shopping","supermarket","grocery","walmart",
    "target","costco","amazon","dollar","convenience",
    "boutique","department store","outlet","franchise","point of sale",
    "pos","retailing","cashier","checkout","inventory",
    "merchandising","retail chain","store","online store","marketplace",
    "retail tech","omni-channel","loyalty","coupon","clearance",
    "fashion retail","pop-up","catalog","retail management","sku"
  ],

  Manufacturing: [
    "manufacturing","manufacturer","factory","plant","assembly",
    "production","machining","mfg","industrial","fabrication",
    "foundry","cnc","automation","robotics","supply chain",
    "industrial park","oem","components","parts","sheet metal",
    "tooling","throughput","output","contract manufacturing","contract manufacturer",
    "discrete manufacturing","process manufacturing","heavy industry","steel","metalworking",
    "engineering","molding","stamping","extrusion","casting",
    "textile mill","pulp","paper mill","production line","fabric"
  ],

  Education: [
    "education","school","university","college","k-12",
    "higher education","student","professor","teaching","classroom",
    "curriculum","edtech","textbook","tuition","scholarship",
    "campus","dean","department","research","grant",
    "admissions","faculty","school district","charter","private school",
    "public school","online course","mooc","continuing education","vocational",
    "trade school","certification","pedagogy","counselor","principal",
    "alumni","enrollment","semester","transcript","bursar"
  ],

  Entertainment: [
    "entertainment","film","movie","cinema","hollywood",
    "studio","producer","director","actor","actress",
    "music","record label","concert","tour","ticketing",
    "theater","broadway","netflix","hulu","spotify",
    "artist","songwriter","streaming","box office","festival",
    "awards","oscar","grammy","set design","casting",
    "post-production","vfx","animation","indie","studio lot",
    "broadcasting","reality tv","sitcom","episodic","cable network"
  ],

  Hospitality: [
    "hospitality","hotel","resort","motel","lodging",
    "booking","airbnb","hostel","restaurant","dining",
    "concierge","room service","banquet","catering","spa",
    "tourism","travel agency","cruise","cruise line","hospitality management",
    "check-in","housekeeping","chef","culinary","food service",
    "bar","nightlife","brewery","conference center","convention",
    "event planning","occupancy","seasonal","leisure","hospitality group",
    "chains","franchise hotel","lodging tax","boutique hotel","inn"
  ],

  "Food & Beverage": [
    "food","beverage","restaurant","dining","cafe",
    "coffee","bar","brewery","winery","distillery",
    "foodservice","catering","packaged foods","snack","confectionery",
    "dairy","meatpacking","processing","seafood","fisheries",
    "aquaculture","distributor","wholesaler","ingredients","grocery",
    "supermarket","supplier","retail food","bottling","soda",
    "bottling plant","bakery","butcher","frozen foods","organic foods",
    "farm-to-table","food safety","food tech","meal kit","food hub"
  ],

  Automotive: [
    "automotive","auto","automobile","car","motor",
    "manufacturer","assembly","dealership","aftermarket","parts",
    "engine","transmission","tesla","gm","ford",
    "toyota","honda","nissan","vehicle","fleet",
    "ev","electric vehicle","charging","battery","fuel",
    "diesel","gasoline","motorsport","tire","wheel",
    "collision","body shop","auto finance","leasing","test drive",
    "auto parts","car rental","uber","lyft","truck"
  ],

  Pharmaceuticals: [
    "pharmaceutical","pharmaceuticals","pharma","drug","drugmaker",
    "biopharma","big pharma","generic","brand-name","compound",
    "formulation","clinical trial","cGMP","api","active ingredient",
    "therapeutics","vaccine","antibiotic","antiviral","oncology",
    "biologic","biosimilar","pharmacology","pharmacist","formulation",
    "prescription","rx","over the counter","otc","pharmacy chain",
    "retail pharmacy","apothecary","drugstore","research","clinical research",
    "drug development","pipeline","regulatory","fda","medicinal chemistry"
  ],

  Insurance: [
    "insurance","insurer","underwriting","premium","policy",
    "broker","brokerage","reinsurance","actuary","actuarial",
    "claims","claims processing","adjuster","coverage","life insurance",
    "health insurance","auto insurance","property insurance","liability","commercial insurance",
    "home insurance","workers compensation","wc","insurance company","mutual",
    "carrier","benefits","pension","annuity","underwriter",
    "insurance tech","insurtech","broker-dealer","rating agency","insurance pool",
    "indemnity","insurance group","policyholder","claims adjuster","surety"
  ],

  Construction: [
    "construction","builder","contractor","subcontractor","general contractor",
    "building","construction management","sitework","excavation","concrete",
    "cement","masonry","roofing","plumbing","electrical",
    "hvac","architect","architecture","permit","zoning",
    "infrastructure","heavy civil","roadwork","bridge","earthmoving",
    "scaffolding","steel erection","construction equipment","crane","formwork",
    "project management","construction materials","drywall","insulation","tiling",
    "finishing","land development","site development","paving","aggregate"
  ],

  Mining: [
    "mining","minerals","ore","coal mine","gold",
    "precious metals","copper","iron","quarry","pit",
    "shaft","drilling","mineral processing","smelter","tailings",
    "exploration","geology","open pit","underground","mineral rights",
    "mineral extraction","orebody","placer","reclamation","mine safety",
    "coal seam","strip mining","shaft sinking","drill rig","prospecting",
    "ore concentrate","coalbed","metallurgy","nickel","uranium",
    "zinc","lead","mineral resource","mining company","mineralogy"
  ],

  Chemical: [
    "chemical","chemicals","chemicals company","petrochemical","industrial chemical",
    "solvent","resin","polymer","plastic","fertilizer",
    "pesticide","agrochemical","specialty chemical","bulk chemical","chemical plant",
    "indicator","acid","base","organic chemical","inorganic",
    "chemical engineering","formulation","emulsifier","surfactant","adhesive",
    "paint","coating","additive","compound","monomer",
    "polyethylene","polypropylene","polyurethane","ethylene","propylene",
    "chemical supplier","chemical distributor","catalyst","reactor","process chemical"
  ],

  Utilities: [
    "utility","utilities","water","sewer","electric utility",
    "power plant","nuclear","coal plant","gas utility","electricity",
    "grid","transmission","distribution","metering","utility provider",
    "renewable utility","solar farm","wind farm","hydro plant","generator",
    "utility regulator","energy provider","utility services","wastewater","reclamation",
    "utility commission","utility company","utility infrastructure","utility pole","substation",
    "smart meter","demand response","load","capacity","utility rates",
    "utility billing","energy storage","microgrid","retailer of energy","utility operations"
  ],

  Biotechnology: [
    "biotech","biotechnology","biopharma","gene","genomics",
    "crispr","cell therapy","cellular","stem cell","regenerative",
    "monoclonal","antibody","assay","bioprocess","fermentation",
    "upstream","downstream","bioreactor","cell line","bioinformatics",
    "proteomics","genetic","sequencing","genome","molecular",
    "laboratory","cancer therapeutics","immunotherapy","biomanufacturing","bioscience",
    "biologic","gene therapy","vector","viral vector","transfection",
    "expression system","culture medium","bioanalytical","preclinical","toxicology"
  ],

  Legal: [
    "law","legal","law firm","attorney","lawyer",
    "litigation","corporate law","patent","intellectual property","ip",
    "bar","pro bono","counsel","partner","associate",
    "legal services","regulatory","compliance","court","trial",
    "brief","motion","settlement","arbitration","mediation",
    "defense counsel","prosecutor","judicial","notary","trust",
    "estate","probate","legal aid","legaltech","paralegal",
    "legal research","case law","statute","legal counsel","attorney general"
  ],

  Sports: [
    "sports","athletics","team","league","club",
    "stadium","arena","ticketing","mlb","nba",
    "nfl","nhl","soccer","fifa","olympic",
    "player","coach","franchise","sportswear","athlete",
    "endorsement","sponsorship","sporting goods","golf","tennis",
    "stadium operator","broadcast rights","sports betting","betting","bookmaker",
    "fan engagement","esports","gaming league","player union","sports medicine",
    "ticketmaster","venue","sports management","minor league","season ticket"
  ],

  Fashion: [
    "fashion","apparel","clothing","garment","designer",
    "couture","runway","collection","retail fashion","boutique",
    "textile","fabric","sewing","designer label","brand",
    "footwear","shoes","accessories","handbag","luxury",
    "fast fashion","garment factory","style","model","modeling",
    "catalog","lookbook","merchant","wholesale fashion","fashion week",
    "atelier","tailor","alterations","pattern","ready-to-wear",
    "OEM fashion","sustainable fashion","denim","outerwear","lingerie"
  ],

  Aerospace: [
    "aerospace","aircraft","airplane","aviation","space",
    "rocket","satellite","launch","spacecraft","orbital",
    "airframe","engine","propulsion","avionics","airline supplier",
    "aero","aerosystems","flight","airbus","boeing",
    "spacetech","payload","mission control","ground station","spaceport",
    "satcom","rocket engine","space launch","crew module","space industry",
    "payload integration","space research","microgravity","space tourism","astronaut"
  ],

  Electronics: [
    "electronics","semiconductor","chip","circuit","pcb",
    "component","resistor","capacitor","diode","transistor",
    "sensor","display","lcd","oled","led",
    "test equipment","oscilloscope","multimeter","assembly","electronics manufacturing",
    "soldering","surface mount","bga","chipset","microcontroller",
    "fpga","asic","memory","flash","ssd",
    "embedded","firmware","power supply","transformer","connector",
    "cable","wire","electronics distributor","ev electronics","consumer electronics"
  ],

  Maritime: [
    "maritime","shipping","ship","vessel","container",
    "port","harbor","dock","shipyard","boat",
    "naval","mariner","seafarer","freighter","bulk carrier",
    "tanker","offshore support","pilotage","stevedore","shipbroker",
    "shipowner","maritime logistics","maritime safety","IMO","flag state",
    "maritime law","port authority","berth","ship management","maritime insurance",
    "cargo","ro-ro","containerization","ballast","shipbreaking","maritime services","port terminal","pilots"
  ],

  Forestry: [
    "forestry","timber","logging","lumber","sawmill",
    "wood","pulp","paper","forest","deforestation",
    "reforestation","tree farm","silviculture","chip mill","wood products",
    "plywood","veneer","woodworking","sustainable forestry","forest products",
    "biomass","forest service","forest management","timberland","harvester",
    "forest certification","chain saw","forest road","timber sale","wood pellet",
    "forest policy","canopy","understory","forest ecology","wood pulp",
    "paper mill","chipper","wood supplier","forest nursery","timber company"
  ]
}

export function categorizeIndustry(pacName: string): string {
  const name = pacName.toLowerCase()
  const scores: Record<string, number> = {}

  for (const [industry, keywords] of Object.entries(industryKeywords)) {
    for (const keyword of keywords) {
      if (name.includes(keyword)) {
        scores[industry] = (scores[industry] || 0) + 1
      }
    }
  }

  if (Object.keys(scores).length === 0) return "Other"

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])[0][0]
}