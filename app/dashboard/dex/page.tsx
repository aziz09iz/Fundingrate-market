import { FundingDashboard } from "@/components/funding-dashboard";

export default function DexDashboardPage() {
  return (
    <FundingDashboard
      scope="dex-dex"
      title="Decentralized Exchange"
      description="Funding rate market, DEX vs DEX — hedges across two on-chain perpetual venues, both legs settled on chain."
    />
  );
}
