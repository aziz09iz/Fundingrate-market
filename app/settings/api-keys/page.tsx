import { redirect } from "next/navigation";

/**
 * Credentials are split by venue class, so this level has nothing of its own to
 * show. CEX is the larger set, so it is the default landing.
 */
export default function VenueCredentialsPage() {
  redirect("/settings/api-keys/cex");
}
