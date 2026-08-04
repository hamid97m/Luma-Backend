// Awaitable Proxy: any method chain returns itself; `await chain` resolves
// to `result`. Lets one mock serve arbitrary supabase-js query chains.
export function chainable(result: unknown): any {
  const proxy: any = new Proxy(function () {} as any, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject)
      }
      return () => proxy
    },
  })
  return proxy
}
