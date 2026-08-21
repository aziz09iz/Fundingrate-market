import { FundingDashboard } from "@/components/funding-dashboard";

export default function CrossDashboardPage() {
  return (
    <FundingDashboard
      scope="cross"
      title="Cross CEX–DEX"
      description="Funding rate market, CEX vs DEX — one custodial leg against one on-chain leg, where the widest funding gaps usually sit."
    />
  );
}
