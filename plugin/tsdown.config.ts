/**
 * Client-bundle build, equivalent to the in-repo `clientBundle` preset.
 *
 * The official preset lives at `packages/client/tsdown.client.ts` inside the
 * harness and imports its own internal paths, so an external package cannot
 * reuse it and has to restate the externals list. That list must stay identical
 * to `PLATFORM_MODULES`: a module missing from it gets bundled into this
 * package, and the shared React or slot registry then exists twice.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@anweat/dsh-substrate'

/** Must match the shell's `PLATFORM_MODULES` exactly; see the module comment. */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

export default {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  // Without this the client build deletes lib/index.js, which tsc just wrote.
  clean: false,
  codeSplitting: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) =>
      (CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number]) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [
    {
      // The bundle purity gate, matching the build-time boundary the harness
      // enforces: a cross-plugin value import would duplicate that plugin's
      // state into this bundle instead of sharing the one instance.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source as (typeof CLIENT_EXTERNALS)[number])) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module — collaborate through `
          + 'cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    },
  ],
} satisfies UserConfig
