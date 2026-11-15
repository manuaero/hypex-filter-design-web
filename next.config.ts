import type { NextConfig } from 'next';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  poweredByHeader: false,
  devIndicators: false,
  env: {
    NEXT_PUBLIC_HFD_MANUAL_BUNDLED: String(
      statSync(join(process.cwd(), 'public', 'help', 'hfdhelp-v3.pdf'), {
        throwIfNoEntry: false,
      })?.isFile() ?? false,
    ),
  },
};
export default config;
