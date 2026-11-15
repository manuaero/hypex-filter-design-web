import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Fusion Studio — FA503 crossover workspace',
  description: 'Browser-based crossover design and independent Left/Right Hypex FA503 control.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
