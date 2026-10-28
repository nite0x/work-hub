interface SessionResult { sessions: Record<string, unknown>[]; error?: string }
type Request = <T>(path: string, options: {environment: string}) => Promise<T>
interface RequestEntry { promise: Promise<SessionResult>; updated: number; pending: boolean }

// The sidebar and browser use the same query coordinator. Scope-specific state
// and stale-response guards remain with their respective view controllers.
export function createSessionRequests() {
  const entries = new Map<string, RequestEntry>()
  return {
    load(request: Request, environment: string, query = "", force = false) {
      const params = new URLSearchParams(query)
      params.delete("refresh")
      params.sort()
      const key = JSON.stringify([environment,params.toString()])
      const previous = entries.get(key)
      if (!force && previous && (previous.pending || Date.now()-previous.updated < 1000)) return previous.promise
      for (const [key,entry] of entries) if (!entry.pending && Date.now()-entry.updated > 1000) entries.delete(key)
      if (force) params.set("refresh","1")
      const entry: RequestEntry = {promise: Promise.resolve({sessions: []}), updated: 0, pending: true}
      entry.promise = request<SessionResult>("/api/sessions?"+params, {environment}).then(result => {
        entry.pending = false
        entry.updated = Date.now()
        if (result.error && entries.get(key) === entry) entries.delete(key)
        return result
      }, error => {if (entries.get(key) === entry) entries.delete(key); throw error})
      entries.set(key,entry)
      return entry.promise
    },
    invalidate(environment: string) {for (const key of entries.keys()) if ((JSON.parse(key) as string[])[0] === environment) entries.delete(key)},
  }
}
