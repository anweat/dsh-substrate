// The shipped profile's own tool names, read from a real boot rather than
// guessed. A hardcoded list silently misses one and the substrate then lets a
// corpus package claim a seat the profile already owns.
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_ROOT, require_ } from '../paths.mjs'
const requireRoot = () => require_(DSH_ROOT, 'DSH_ROOT', 'boot a harness checkout')
const { boot } = await import(pathToFileURL(join(requireRoot(), 'packages/boot/app-boot/src/index.ts')).href)
const ctx = await boot('dsh-e2e', process.argv[2])
const names = ctx.get('tools').schemas().map(t => t.name).sort()
writeFileSync(process.argv[3], JSON.stringify(names, null, 0))
console.log(`出厂工具 ${names.length} 个 -> ${process.argv[3]}`)
console.log(names.join(' '))
await ctx.fiber.dispose()
