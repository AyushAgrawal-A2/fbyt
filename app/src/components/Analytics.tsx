import Script from 'next/script';

/**
 * Google Analytics — injected only when NEXT_PUBLIC_GA_ID is set, so local/dev runs stay clean. The
 * platform also uses Sentry; wire @sentry/nextjs in a production build when NEXT_PUBLIC_SENTRY_DSN is set.
 */
export function Analytics() {
  const gaId = process.env.NEXT_PUBLIC_GA_ID;
  if (!gaId) return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
      <Script id="ga-init" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}');`}
      </Script>
    </>
  );
}
