export interface Member {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
  district: string
  totalRaised: number
  totalSpent: number
  topIndustries: Industry[]
  pacDonations: PacDonation[]
  trades?: Trade[]
}

export interface Industry{
    name:string
    amount: number
}

export interface PacDonation {
  pacName: string
  amount: number
  date: string
}

export interface Trade {
  ticker: string
  transactionDate: string
  transactionType: string
  amount: string
}
