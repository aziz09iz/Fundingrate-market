import { redirect } from "next/navigation";

/**
 * The dashboard is split by pair scope, so this level has nothing of its own to
 * show. Cross CEX–DEX is the default landing: it is the widest market of the
 * three and the one the other two views are subsets of.
 */
export default function DashboardPage() {
  redirect("/dashboard/cross");
}
