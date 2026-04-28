import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,js}'],
  },
  resolve: {
    alias: {
      '@mariozechner/pi-coding-agent': path.resolve(__dirname, 'tests/__mocks__/pi-coding-agent.ts'),
      '@mariozechner/pi-tui': path.resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
      '@mariozechner/pi-ai': path.resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
      '@mariozechner/pi-agent-core': path.resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
      '@sinclair/typebox': path.resolve(__dirname, 'tests/__mocks__/pi-tui.ts'),
    },
  },
});
