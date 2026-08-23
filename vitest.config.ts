import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // React plugin for JSX in component tests; harmless for the node-env unit tests.
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Node by default (main-process logic); component tests opt into jsdom via a
    // `// @vitest-environment jsdom` docblock at the top of the file.
    environment: 'node',
    // Fills jsdom's missing element scroll methods; see the file for why this is not optional.
    setupFiles: ['./tests/setup.ts'],
  },
});
