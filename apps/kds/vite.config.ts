/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // In production the kitchen display is served from a folder of the web app's address
  // (app.example.com/kitchen/), so its files must be requested from that folder.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  // The API's CORS allow-list contains exactly this origin, so never fall back to another port.
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
});
