import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'GullyBite Dashboard',
        short_name: 'GullyBite',
        description: 'GullyBite restaurant dashboard',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f8f9fb',
        theme_color: '#4338ca',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webp,woff,woff2}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https?:\/\/[^/]+\/(api|auth)\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
