/**
 * L4 — the panel scaffold.
 *
 * A panel is the ecosystem's most repeated shape: a slot entry plus the backend
 * that feeds it. 2,622 corpus packages register both, and they write the path
 * three times — once where the backend claims it, once where the component
 * fetches it, once in a constant somewhere between — with nothing checking that
 * the three agree.
 *
 * Two facts about the runtime decide this module's design.
 *
 * First, **no backend seam is additive**. `webServer.register` throws on a
 * duplicate path; `connection.rpc.handle` becomes a prefix route and throws the
 * same way; `intercept('/api')` holds one interceptor for the whole process.
 * A path is therefore not a name a plugin may choose freely, and deriving it
 * from the package name is what makes a collision between two distinct packages
 * impossible rather than merely unlikely.
 *
 * Second, **identity comes from the calling fiber**. `SlotRegistry` stamps
 * `registrant` from `this.ctx.fiber.name` and `connection.rpc` captures
 * `owner = this.ctx`, both resolved against whichever Context reads the
 * service. A scaffold that registered on a plugin's behalf from its own fiber
 * would stamp every panel in the ecosystem with the scaffold's name and leave
 * arbitration unable to tell two plugins apart. So `mountPanel` takes the
 * plugin's own `ctx` and never holds one of its own.
 *
 * @module panel
 */

/** Channel paths the connection reserves; a panel may not claim one. */
export const RESERVED_CHANNELS = Object.freeze(['/api', '/rpc'])

/**
 * The connection's own channel grammar: a leading slash and **one** segment.
 * A channel with an inner slash is rejected outright, so a derived path has to
 * flatten the package and panel names rather than nest them.
 */
const CHANNEL = /^\/[A-Za-z0-9._~-]+$/

/** Endpoint names, kept to a safe subset of what the connection accepts. */
const ENDPOINT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Joins the two halves of a derived channel; slugs never contain it. */
const CHANNEL_JOIN = '.'

/**
 * Derive a channel path from a package name and a panel name.
 *
 * Collisions between distinct packages are structurally impossible because the
 * package name is in the path. Two forks of one plugin still collide, which is
 * correct: they are the same panel, and only one of them can own the seat.
 *
 * The two halves join with `.` rather than nesting, because the connection's
 * grammar allows exactly one path segment. Slugging maps every separator to
 * `-`, so `.` cannot occur inside either half and the join stays unambiguous:
 * one `(pkg, panel)` pair yields one channel, and no two pairs share one.
 *
 * @param {string} pkgName Package name, scoped or bare.
 * @param {string} panelName Panel name, unique within the package.
 * @returns {string} Absolute single-segment channel path.
 */
export function channelFor(pkgName, panelName) {
  const slug = s => s.replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  const pkg = slug(pkgName)
  const panel = slug(panelName)
  if (pkg === '') throw new Error(`panel: package name ${JSON.stringify(pkgName)} yields no path segment`)
  if (panel === '') throw new Error(`panel: panel name ${JSON.stringify(panelName)} yields no path segment`)
  return `/${pkg}${CHANNEL_JOIN}${panel}`
}

/**
 * Validate a panel declaration and derive everything implied by it.
 *
 * Nothing here touches a runtime: a declaration is checkable on its own, and a
 * misdeclared panel must fail at load rather than at first render.
 *
 * @param {object} spec
 * @param {string} spec.pkg Owning package name; the identity everything derives from.
 * @param {string} spec.name Panel name, unique within the package.
 * @param {string} spec.slot Slot the panel's entry occupies.
 * @param {string[]} [spec.endpoints] Endpoint names served on the panel's channel.
 * @param {string} [spec.channel] Overrides the derived channel; must not be reserved.
 * @param {'loopback'|'trusted'} [spec.authority] Trust policy for the channel.
 * @returns {{ pkg: string, name: string, slot: string, channel: string, endpoints: string[], authority: string, entryId: string }} The resolved panel.
 */
export function definePanel(spec) {
  const { pkg, name, slot } = spec
  for (const [field, value] of Object.entries({ pkg, name, slot })) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`panel: ${field} is required and must be a non-empty string`)
    }
  }
  const channel = spec.channel ?? channelFor(pkg, name)
  if (RESERVED_CHANNELS.includes(channel)) {
    throw new Error(`panel: channel ${JSON.stringify(channel)} is reserved by the connection`)
  }
  if (!CHANNEL.test(channel)) {
    throw new Error(
      `panel: channel ${JSON.stringify(channel)} is not one absolute path segment `
      + '(the connection rejects an inner slash)',
    )
  }
  const endpoints = [...(spec.endpoints ?? [])]
  for (const endpoint of endpoints) {
    if (!ENDPOINT.test(endpoint)) {
      throw new Error(`panel: endpoint ${JSON.stringify(endpoint)} is not a valid path segment`)
    }
  }
  if (new Set(endpoints).size !== endpoints.length) {
    throw new Error(`panel: duplicate endpoint in ${JSON.stringify(endpoints)}`)
  }
  return {
    pkg,
    name,
    slot,
    channel,
    endpoints,
    authority: spec.authority ?? 'loopback',
    entryId: `${pkg}:${name}`,
  }
}

/**
 * The contributions a panel makes, in the arbitration vocabulary.
 *
 * A panel is one unit to its author and two contributions to the runtime, so
 * arbitration must see both: withholding the browser half of a panel whose
 * channel still answers leaves a backend nothing reaches.
 *
 * @param {ReturnType<typeof definePanel>} panel Resolved panel.
 * @param {(slot: string) => string} [arityOf] Maps a slot name to its `slot-*` kind.
 * @returns {Array<{ plane: string, kind: string, target: string, owner: string, source: string | null }>} Contributions for the ledger.
 */
export function contributionsOfPanel(panel, arityOf = () => 'slot-list') {
  return [
    { plane: 'client', kind: arityOf(panel.slot), target: panel.slot, owner: panel.pkg, source: null },
    { plane: 'host', kind: 'route', target: panel.channel, owner: panel.pkg, source: null },
  ]
}

/**
 * Mount a panel's backend half on the plugin's own Context.
 *
 * `ctx` must be the plugin's, not the scaffold's: the connection captures
 * `owner = this.ctx` when the service is read, and that owner is what disposes
 * the channel and what arbitration attributes it to.
 *
 * @param {object} ctx The plugin's Context, with `connection` injected.
 * @param {ReturnType<typeof definePanel>} panel Resolved panel.
 * @param {Record<string, (payload: unknown) => unknown>} handlers Endpoint name to handler.
 * @returns {() => Promise<void>} Disposer removing the channel.
 */
export function mountPanelHost(ctx, panel, handlers) {
  const declared = new Set(panel.endpoints)
  for (const name of Object.keys(handlers)) {
    if (!declared.has(name)) {
      throw new Error(`panel ${panel.entryId}: handler ${JSON.stringify(name)} is not a declared endpoint`)
    }
  }
  for (const name of declared) {
    if (handlers[name] === undefined) {
      throw new Error(`panel ${panel.entryId}: endpoint ${JSON.stringify(name)} has no handler`)
    }
  }
  return ctx.connection.rpc.handle(
    panel.channel,
    async (endpoint, payload) => {
      const handler = handlers[endpoint]
      // The connection rejects unknown endpoints before dispatch; this covers
      // a handler map mutated after mount, which nothing else would catch.
      if (handler === undefined) return { ok: false, error: { code: 'unknown-endpoint', message: endpoint } }
      return { ok: true, value: await handler(payload) }
    },
    { authority: panel.authority },
  )
}

/**
 * Mount a panel's browser half on the plugin's own Context.
 *
 * Same identity rule as the host half: `SlotRegistry` reads `registrant` from
 * the fiber behind the Context that reads the service.
 *
 * @param {object} ctx The plugin's Context, with `slots` injected.
 * @param {ReturnType<typeof definePanel>} panel Resolved panel.
 * @param {unknown} component The component occupying the slot.
 * @param {object} [options] Extra slot-registration options, such as `priority`.
 * @returns {() => void} Disposer removing the entry.
 */
export function mountPanelClient(ctx, panel, component, options = {}) {
  return ctx.slots.register({ ...options, name: panel.slot, id: panel.entryId }, component)
}

/**
 * A typed caller bound to one panel's channel.
 *
 * The component never writes the path. That is the whole point: the path exists
 * once, in the declaration, and both halves derive from it.
 *
 * @param {ReturnType<typeof definePanel>} panel Resolved panel.
 * @param {(url: string, init: object) => Promise<{ json: () => Promise<unknown> }>} fetchImpl Transport.
 * @returns {Record<string, (payload?: unknown) => Promise<unknown>>} One caller per declared endpoint.
 */
export function panelClient(panel, fetchImpl) {
  const client = {}
  for (const endpoint of panel.endpoints) {
    client[endpoint] = async payload => {
      const response = await fetchImpl(`${panel.channel}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? null),
      })
      return response.json()
    }
  }
  return client
}
