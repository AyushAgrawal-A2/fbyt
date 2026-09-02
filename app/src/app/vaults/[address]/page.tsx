export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <div className="opacity-60 font-mono text-sm">vault {address} — coming up.</div>;
}
