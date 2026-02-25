export interface Member {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
  district: string
  totalRaised: number
  totalSpent: number
  topIndustries: Industry[]
}

export interface Industry{
    name:string
    amount: number
}

export interface PacDonation {
  pacName: string
  amount: number
}
