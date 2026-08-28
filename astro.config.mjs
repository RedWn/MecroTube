// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  site: 'https://RedWn.github.io',
  base: process.env.VERCEL ? '/' : '/MecroTube',
  output: 'server',
  adapter: vercel({
    imageService: true,
  }),
  i18n: {
    locales: ['en', 'ar'],
    defaultLocale: 'en',
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
