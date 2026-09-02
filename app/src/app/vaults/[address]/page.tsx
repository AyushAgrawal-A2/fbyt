import { VaultDetail } from '@/components/VaultDetail';

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <VaultDetail address={address} />;
}
