import { PageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <PageSkeleton cards={0} rows={5} filters={false} />;
}
