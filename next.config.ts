import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    // Seed catalogue uses Unsplash photography.
    remotePatterns: [{ protocol: 'https', hostname: 'images.unsplash.com' }],
  },
};

export default nextConfig;
