import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'data/case.json', 'data/manifest.json'],
      manifest: {
        name: 'TRACE Field',
        short_name: 'TRACE Field',
        description: 'The satellite asks. You answer.',
        theme_color: '#0A0E12',
        background_color: '#0A0E12',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'basemap-tiles', expiration: { maxEntries: 400 } },
          },
        ],
      },
    }),
  ],
});
