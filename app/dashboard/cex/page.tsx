import { FundingDashboard } from "@/components/funding-dashboard";

export default function CexDashboardPage() {
  return (
    <FundingDashboard
      scope="cex-cex"
      title="Centralized Exchange"
      description="Funding rate market, CEX vs CEX — hedges across two custodial venues, both legs on exchange-side settlement."
    />
  );
}
