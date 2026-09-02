// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  base: '/',
  output: 'static',
  vite: {
    build: {
      // Emit classic min/max-width media queries instead of the Level 4
      // range syntax (width<=720px) so older mobile browsers still apply
      // the responsive rules.
      cssTarget: 'chrome90',
    },
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:4322',
      },
    },
  },
  i18n: {
    locales: ['en', 'ar'],
    defaultLocale: 'en',
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
