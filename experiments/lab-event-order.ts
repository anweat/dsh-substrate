/**
 * Phase-0 experiment 4: is waterfall ordering really untreatable from a plugin?
 *
 * The earlier reading said yes — order is registration order, the only control
 * is a binary `prepend`, and any listener can end the chain by returning
 * without `next()`. This tests three ways a substrate might still get leverage
 * WITHOUT an upstream change:
 *
 *   A. does `prepend: true` actually win the front seat?
 *   B. can a prepend/last sentinel PAIR detect that someone short-circuited?
 *   C. is `ctx.tools.guard()` immune to a waterfall short-circuit, so a
 *      substrate's own policy holds regardless of what plugins do?
 *
 * Run: node --import tsx/esm lab-event-order.ts
 */
import { Context } from './vendor/cordis/src/index.ts'
import { ToolRuntime } from './packages/core/tools/src/index.ts'
import { SystemPrompt } from './packages/core/system-prompt/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

declare module './vendor/cordis/src/index.ts' {
  interface Events {
    'lab/flow'(box: { trace: string[] }, next: () => unknown): unknown
  }
}

async function main(): Promise<void> {
  console.log('\n=== A. does prepend win the front seat? ===')
  {
    const ctx = new Context()
    const trace: string[] = []
    ctx.on('lab/flow', (box, next) => { box.trace.push('ordinary-1'); return next() })
    ctx.on('lab/flow', (box, next) => { box.trace.push('ordinary-2'); return next() })
    ctx.on('lab/flow', (box, next) => { box.trace.push('substrate'); return next() }, { prepend: true })
    const box = { trace }
    await ctx.waterfall('lab/flow', box, () => 'end')
    check('a prepended listener runs before earlier registrations',
      trace[0] === 'substrate', JSON.stringify(trace))
    console.log('        trace:', JSON.stringify(trace))
  }

  console.log('\n=== B. sentinel pair: can a substrate SEE a short-circuit? ===')
  {
    const run = async (rogue: boolean): Promise<{ reachedEnd: boolean, trace: string[] }> => {
      const ctx = new Context()
      const trace: string[] = []
      let reachedEnd = false
      // Front sentinel: registered with prepend, so it opens every dispatch.
      ctx.on('lab/flow', (box, next) => { reachedEnd = false; box.trace.push('front'); return next() }, { prepend: true })
      // Ordinary plugins in between.
      ctx.on('lab/flow', (box, next) => { box.trace.push('plugin-a'); return next() })
      ctx.on('lab/flow', (box, next) => {
        box.trace.push(rogue ? 'plugin-b(SHORT)' : 'plugin-b')
        // Returning without next() ends the chain — the failure mode with no signal.
        return rogue ? 'short' : next()
      })
      ctx.on('lab/flow', (box, next) => { box.trace.push('plugin-c'); return next() })
      // Rear sentinel: registered last, so it only runs when nobody cut the chain.
      ctx.on('lab/flow', (box, next) => { reachedEnd = true; box.trace.push('rear'); return next() })
      await ctx.waterfall('lab/flow', { trace }, () => 'end')
      return { reachedEnd, trace }
    }

    const clean = await run(false)
    const cut = await run(true)
    check('with no short-circuit the rear sentinel is reached', clean.reachedEnd, JSON.stringify(clean.trace))
    check('a short-circuit is DETECTED (rear sentinel never runs)', !cut.reachedEnd, JSON.stringify(cut.trace))
    console.log('        clean:', JSON.stringify(clean.trace))
    console.log('        cut  :', JSON.stringify(cut.trace))
  }

  console.log('\n=== C. is tools.guard() immune to a waterfall short-circuit? ===')
  {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    ctx.tools.register({
      name: 'demo',
      description: 'demo',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => ({ card: 'generic' as const, title: 'demo' }),
      },
      execute: () => ({ ran: true }),
    } as never)

    // A rogue plugin short-circuits the policy waterfall with a blanket allow.
    ctx.on('tools/pre-execute', () => ({ kind: 'allow' as const }))
    // The substrate's own policy, registered as a guard rather than a listener.
    let guardSaw = false
    ctx.tools.guard((execution) => {
      guardSaw = true
      return execution.name === 'demo' ? 'denied by substrate policy' : undefined
    })

    const result = await ctx.tools.execute({
      callId: 'c1', name: 'demo', arguments: {}, signal: new AbortController().signal,
    } as never)
    check('the guard still ran despite the waterfall short-circuit', guardSaw)
    check('the guard denial won over the rogue allow',
      result.isError === true, JSON.stringify(result).slice(0, 140))
    console.log('        result:', JSON.stringify(result).slice(0, 180))
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
