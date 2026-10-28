import {test} from "node:test"
import assert from "node:assert/strict"
import {createOperations} from "../frontend/workspace/operations"
import {createSessionRequests} from "../frontend/workspace/session-requests"
import {conversationPathKey,conversationEnvironmentKey} from "../frontend/workspace/conversation-runtime"
import {taskMatches,taskSignals} from "../frontend/workspace/task-signals"
import type {Task} from "../frontend/workspace/types"

test("operation ownership is per environment and resource, and completion cannot release a newer operation", () => {
  const operations=createOperations()
  const first=operations.begin({environment:"local",key:"project:a",project:"a",title:"fetch"})!
  assert.equal(operations.begin({environment:"local",key:"project:a",title:"push"}),undefined)
  assert(operations.begin({environment:"local",key:"project:b",title:"fetch"}))
  assert(operations.begin({environment:"wsl",key:"project:a",title:"fetch"}))
  operations.end(first)
  const next=operations.begin({environment:"local",key:"project:a",title:"push"})!
  operations.end(first)
  assert(operations.snapshot().some(item=>item.id===next.id))
})

test("session queries share simultaneous identical reads while force and navigation invalidate stale requests", async () => {
  const coordinator=createSessionRequests()
  const pending: {path:string;environment:string;resolve:(value:any)=>void}[]=[]
  const request=<T>(path:string,options:{environment:string})=>new Promise<T>(resolve=>pending.push({path,environment:options.environment,resolve}))
  const a=coordinator.load(request,"local","cwd=%2Frepo&archived=true")
  const b=coordinator.load(request,"local","archived=true&cwd=%2Frepo")
  assert.equal(pending.length,1)
  const forced=coordinator.load(request,"local","cwd=%2Frepo&archived=true",true)
  assert.equal(pending.length,2)
  assert.match(pending[1].path,/refresh=1/)
  pending[1].resolve({sessions:[{id:"fresh"}]})
  await forced
  pending[0].resolve({sessions:[{id:"old"}]})
  await Promise.all([a,b])
  assert.equal((await coordinator.load(request,"local","archived=true&cwd=%2Frepo")).sessions[0].id,"fresh")
  coordinator.invalidate("local")
  const after=coordinator.load(request,"local","archived=true&cwd=%2Frepo")
  assert.equal(pending.length,3)
  pending[2].resolve({sessions:[]});await after
})

test("task signals distinguish committed work awaiting push from a clean directory", () => {
  const task={members:[{state:"ready",worktree:{dirty:0,sync_ahead:2,status_updated_at:"now"}},{state:"pending"},{state:"ready",worktree:{dirty:2,operation:"merge",conflicts:["a"],status_updated_at:"now"}}],connected:true} as Task
  assert.deepEqual(taskSignals(task),{issues:1,dirty:1,push:1,conflicts:1,checking:0})
  for(const filter of ["issues","dirty","push","conflicts"] as const) assert(taskMatches(task,filter))
  assert.equal(conversationPathKey("C:\\Repo\\"),"c:/repo")
  assert.equal(conversationPathKey("/Home/Repo/"),"/Home/Repo")
  assert.notEqual(conversationEnvironmentKey("local","same"),conversationEnvironmentKey("wsl","same"))
})
