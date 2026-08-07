import { Banknote } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PlaceholderPanel } from '../components/ui/placeholder-panel';
import { usePageTitle } from '../hooks/use-page-title';

export function FinancePage() {
  usePageTitle('Finance');

  return (
    <>
      <PageHeader
        title="Finance"
        description="Statements, payouts, and financial reports for your organization."
      />
      <PlaceholderPanel icon={Banknote} title="Finance arrives with payments" milestone="platform">
        <p>
          When bookings and payments run through Himma, this page will hold your statements, payout
          history, and financial reports.
        </p>
      </PlaceholderPanel>
    </>
  );
}
