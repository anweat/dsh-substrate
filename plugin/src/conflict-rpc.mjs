/** Read-only projection of runtime tool conflicts. */
export const CONFLICTS_ROUTE = '/api/dsh-substrate/conflicts'

export function registerConflictRpc(ctx, source) {
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: CONFLICTS_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof body === 'object' && body !== null && typeof body.rpcId === 'string'
          ? body.rpcId
          : 'invalid-request'
        if (typeof body !== 'object' || body === null || body.type !== 'client-request'
          || body.method !== 'dsh-substrate/conflicts') {
          return Response.json({
            type: 'server-response', rpcId,
            result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid conflicts request', details: {} } },
          })
        }
        return Response.json({
          type: 'server-response', rpcId,
          result: { ok: true, value: source() },
        })
      },
    }), 'dsh-substrate: conflict RPC')
  })
}
