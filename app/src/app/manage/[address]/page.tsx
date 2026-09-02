import { ManageVault } from '@/components/ManageVault';

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <ManageVault address={address} />;
}
