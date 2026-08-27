import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // The zip round-trip suite runs under node:test (it uses node:test APIs).
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/client/**', 'jsdom'],
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/host/engine.ts',
        'src/host/uninstall.ts',
        'src/host/patch-editor.ts',
        'src/host/token-store.ts',
        'src/host/operation-store.ts',
        'src/host/channel-protocol.ts',
        'src/index.ts',
        'src/client/protocol.ts',
        'src/client/PluginManagerTab.tsx',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
