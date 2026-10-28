export interface PendingOperation { id: number; key: string; environment: string; title: string; project?: string; task?: string }
export function createOperations() {
  let sequence = 0
  const pending = new Map<string, PendingOperation>()
  return {
    begin(input: Omit<PendingOperation, "id">) {
      const key = JSON.stringify([input.environment,input.key])
      if (pending.has(key)) return undefined
      const operation = {...input,id: ++sequence}
      pending.set(key,operation)
      return operation
    },
    end(operation: PendingOperation) {
      const key = JSON.stringify([operation.environment,operation.key])
      if (pending.get(key)?.id === operation.id) pending.delete(key)
    },
    snapshot: () => [...pending.values()],
  }
}
