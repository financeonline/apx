import { DeniedState } from '@/components/dashboard';

/** HTTP 403 outside a tenant — `/platform`, `/portfolio`, `/account` (ROUTE_ARCHITECTURE.md §11). */
export default function Forbidden() {
  return <DeniedState homeHref="/" />;
}
