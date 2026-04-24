import type { Metadata } from 'next';
import '../styles/tokens/index.css';
import '../styles/global.css';
import '../styles/dashboard.css';
import '../styles/wa-connect.css';
import Providers from './Providers';

export const metadata: Metadata = {
  metadataBase: new URL('https://gully-bite.vercel.app'),
  title: 'GullyBite — WhatsApp Ordering for Indian Restaurants. Zero Commission.',
  description:
    "GullyBite turns WhatsApp into your restaurant's ordering engine. Zero commission, flat ₹2,999/month, weekly auto-settlements. Go live in 10 minutes.",
  manifest: '/manifest.json',
  themeColor: '#0D9B6A',
  openGraph: {
    title: 'GullyBite — WhatsApp Ordering for Indian Restaurants',
    description:
      'Zero commission. Flat ₹2,999/month. Own your customers. Live in 10 minutes.',
    type: 'website',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
