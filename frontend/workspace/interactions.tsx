import { useEffect, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { flushSync } from "react-dom"
import { Command } from "cmdk"
import { DropdownMenu, Popover } from "radix-ui"
import { Check, ChevronDown, ChevronsUpDown, Ellipsis, Search } from "lucide-react"
import { Toaster, toast } from "sonner"
import { Button } from "@/components/ui/button"

type Choice = { value: string; label: string; group: string; disabled: boolean }
type SelectModel = { label: string; value: string; disabled: boolean; hidden: boolean; required: boolean; description?: string; choices: Choice[] }
type Mounted = { host: HTMLElement; root: Root; signature: string; dispose?: () => void }

function selectModel(source: HTMLSelectElement): SelectModel {
  const label = source.labels?.[0]?.cloneNode(true) as HTMLElement | undefined
  label?.querySelectorAll("select,input,button,.ui-select-host").forEach(node => node.remove())
  return {
    label: source.getAttribute("aria-label") || label?.textContent?.replace(/\s*\*\s*$/, "").trim() || "选择选项",
    value: source.value,
    disabled: source.matches(":disabled"), hidden: Boolean(source.hidden), required: source.required,
    description: source.getAttribute("aria-describedby") || undefined,
    choices: Array.from(source.options, option => ({ value: option.value, label: option.textContent || option.value,
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : "",
      disabled: option.disabled || option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled })),
  }
}

function SearchableSelect({ source, model }: { source: HTMLSelectElement; model: SelectModel }) {
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const invalid = (event: Event) => { event.preventDefault(); const configuration = source.closest("details"); if (configuration) configuration.open = true; setInvalid(true); queueMicrotask(() => triggerRef.current?.focus()) }
    const changed = () => setInvalid(false)
    source.addEventListener("invalid", invalid); source.addEventListener("change", changed)
    return () => { source.removeEventListener("invalid", invalid); source.removeEventListener("change", changed) }
  }, [source])
  const selected = model.choices.find(choice => choice.value === model.value)
  const groups = [...new Set(model.choices.map(choice => choice.group))]
  const portal = source.closest("dialog") || document.body
  return <><Popover.Root open={open && !model.disabled && !model.hidden} onOpenChange={value => { setOpen(value); if (value) setInvalid(false) }}>
    <Popover.Trigger asChild>
      <Button ref={triggerRef} type="button" variant="outline" role="combobox" aria-label={model.label} aria-expanded={open}
        aria-required={model.required || undefined} aria-describedby={[model.description, invalid ? `${source.id}-validation` : ""].filter(Boolean).join(" ") || undefined} aria-invalid={invalid || undefined}
        disabled={model.disabled} hidden={model.hidden} className={`ui-combobox-trigger${source.id === "gitWorktree" && selected ? " disabled:opacity-100" : ""}`} title={selected?.label}
        onInvalid={() => setInvalid(true)} data-select-trigger={source.id}>
        <span>{selected?.label || `选择${model.label}`}</span><ChevronsUpDown aria-hidden="true" />
      </Button>
    </Popover.Trigger>
    <Popover.Portal container={portal}>
      <Popover.Content className="shadcn-scope ui-combobox-content" sideOffset={5} align="start" collisionPadding={12}>
        <Command label={`搜索${model.label}`} loop>
          <div className="ui-command-search"><Search aria-hidden="true" /><Command.Input placeholder={`搜索${model.label}…`} aria-label={`搜索${model.label}`} /></div>
          <Command.List><Command.Empty>没有匹配的选项</Command.Empty>
            {groups.map(group => <Command.Group key={group} heading={group || undefined}>
              {model.choices.filter(choice => choice.group === group).map((choice, index) => <Command.Item
                key={`${choice.value}:${index}`} value={`${choice.label} ${choice.value}`} disabled={choice.disabled}
                onSelect={() => { if (source.matches(":disabled")) return; source.value = choice.value; setInvalid(false); setOpen(false); source.dispatchEvent(new Event("change", { bubbles: true })); }}>
                <Check aria-hidden="true" className={model.value === choice.value ? "" : "ui-check-hidden"} /><span>{choice.label}</span>
              </Command.Item>)}
            </Command.Group>)}
          </Command.List>
        </Command>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>{invalid ? <small id={`${source.id}-validation`} className="ui-select-validation" role="alert">请选择{model.label}</small> : null}</>
}

function ActionMenu({ source, label, iconOnly }: { source: HTMLDetailsElement; label: string; iconOnly: boolean }) {
  const items = Array.from(source.querySelectorAll<HTMLButtonElement | HTMLHRElement>("button, hr"))
  const portal = source.closest("dialog") || document.body
  const trigger = source.querySelector("summary")
  const isSessionMenu = source.classList.contains("session-item-menu")
  return <DropdownMenu.Root modal={false} open={source.open} onOpenChange={open => { source.open = open }}>
    <DropdownMenu.Trigger asChild>
      <Button type="button" variant={source.closest(".task-split-accent") ? "default" : isSessionMenu ? "ghost" : "outline"} size={iconOnly ? isSessionMenu ? "icon-xs" : "icon-sm" : "sm"} className="ui-menu-trigger" aria-label={label}
        title={trigger?.getAttribute("title") || label} onClick={event => event.stopPropagation()}>
        {iconOnly ? source.classList.contains("task-action-menu") ? <ChevronDown aria-hidden="true" /> : <Ellipsis aria-hidden="true" /> : <>{trigger?.textContent?.trim() || "更多"}<ChevronDown aria-hidden="true" /></>}
      </Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={portal}>
      <DropdownMenu.Content className="shadcn-scope ui-menu-content" align="end" sideOffset={5} collisionPadding={12}
        onCloseAutoFocus={event => { const dialog = Array.from(document.querySelectorAll("dialog[open]")).at(-1); if (dialog && dialog !== source.closest("dialog")) event.preventDefault() }}>
        {items.map((node, index) => { if (node instanceof HTMLHRElement) return <DropdownMenu.Separator key={index} className="ui-menu-separator" />; const item = node; return <DropdownMenu.Item key={index} disabled={item.disabled}
          className={`ui-menu-item ${/remove|unlink|abort/.test(item.dataset.action || "") || item.hasAttribute("data-conversation-unlink") ? "ui-menu-destructive" : ""}`}
          onSelect={() => {
            if (item.disabled) return
            const origin = source.previousElementSibling?.querySelector<HTMLButtonElement>("button")
            origin?.focus()
            item.click()
          }}>
          {item.textContent?.trim()}
        </DropdownMenu.Item> })}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}

// React owns only the adjacent enhancement roots. The native controls remain
// the form/controller boundary, including validation, values and delegated actions.
export function setupWorkspaceInteractions() {
  const selects = new Map<HTMLSelectElement, Mounted>()
  const menus = new Map<HTMLDetailsElement, Mounted>()
  let queued = false
  let disposed = false
  const schedule = () => { if (!queued && !disposed) { queued = true; queueMicrotask(() => { queued = false; if (!disposed) flushSync(sync) }) } }
  function sync() {
    for (const collection of [selects, menus]) for (const [source, entry] of collection) if (!source.isConnected) {
      entry.dispose?.(); entry.root.unmount(); entry.host.remove(); collection.delete(source as never)
    }
    for (const source of document.querySelectorAll<HTMLSelectElement>("select[data-searchable-select], #gitWorktree, #gitSwitch, #gitMergeSource, #gitBranchSource, #gitFFLocal, #gitFFSource, #worktreeSource, #worktreeExisting, #sessionDirectoryFilter, #sessionBrowserNewDirectory")) {
      if (!source.id) continue
      let entry = selects.get(source)
      if (!entry) {
        const host = document.createElement("span"); host.className = "ui-select-host"
        source.after(host); source.classList.add("ui-native-select"); source.parentElement?.classList.add("ui-enhanced-select")
        source.style.setProperty("display", "none", "important")
        source.tabIndex = -1; source.setAttribute("aria-hidden", "true")
        entry = { host, root: createRoot(host), signature: "" }; selects.set(source, entry)
        const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!
        Object.defineProperty(source, "value", { configurable: true, get() { return valueDescriptor.get!.call(this) }, set(value: string) { valueDescriptor.set!.call(this, value); schedule() } })
        const focusLabel = (event: Event) => { if (!host.contains(event.target as Node)) { event.preventDefault(); host.querySelector<HTMLButtonElement>("button")?.focus() } }
        const labels = Array.from(source.labels || [])
        labels.forEach(label => label.addEventListener("click", focusLabel)); source.addEventListener("change", schedule)
        entry.dispose = () => { source.removeEventListener("change", schedule); labels.forEach(label => label.removeEventListener("click", focusLabel)); delete (source as unknown as Record<string, unknown>).value }
      }
      const model = selectModel(source), signature = JSON.stringify(model)
      if (entry.signature !== signature) { entry.signature = signature; entry.root.render(<SearchableSelect source={source} model={model} />) }
    }
    for (const source of document.querySelectorAll<HTMLDetailsElement>("details.task-more, details.task-action-menu, details.project-more, details.session-item-menu, details.task-filter-more")) {
      if (!source.querySelector("button") || source.querySelector("input,select,textarea")) continue
      let entry = menus.get(source)
      if (!entry) {
        const host = document.createElement("span"); host.className = `ui-action-host ${source.classList.contains("task-action-menu") ? "ui-split-menu" : ""}`
        if (source.classList.contains("session-item-menu")) host.classList.add("ui-session-menu")
        source.before(host); source.classList.add("ui-native-menu")
        entry = { host, root: createRoot(host), signature: "" }; menus.set(source, entry)
      }
      const summary = source.querySelector("summary")
      const label = summary?.getAttribute("aria-label") || summary?.textContent?.trim() || "更多操作"
      const signature = JSON.stringify([source.open, label, ...Array.from(source.querySelectorAll("button"), button => [button.textContent, button.disabled])])
      if (entry.signature !== signature) { entry.signature = signature; entry.root.render(<ActionMenu source={source} label={label} iconOnly={!!summary?.querySelector("svg") && (!!summary.querySelector(".sr-only") || !summary.textContent?.trim())} />) }
    }
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden", "open", "required", "selected", "aria-label", "aria-describedby"] })
  flushSync(sync)
  window.addEventListener("pagehide", () => { disposed = true; observer.disconnect(); for (const collection of [selects, menus]) for (const entry of collection.values()) { entry.dispose?.(); entry.root.unmount() } selects.clear(); menus.clear() }, { once: true })
}

export function mountWorkspaceToaster() {
  const host = document.createElement("div"); host.id = "workspaceToaster"; host.className = "shadcn-scope"; document.body.append(host)
  const root = createRoot(host)
  root.render(<Toaster position="bottom-right" closeButton richColors visibleToasts={3} containerAriaLabel="通知" toastOptions={{ closeButtonAriaLabel: "关闭通知" }} />)
  window.addEventListener("pagehide", () => root.unmount(), { once: true })
}

export function notifyWorkspace(message: string, error = false) {
  const host = document.getElementById("workspaceToaster")
  const parent = Array.from(document.querySelectorAll("dialog[open]")).at(-1) || document.body
  if (host && host.parentElement !== parent) parent.append(host)
  return error ? toast.error(message, { duration: 9000 }) : toast.success(message, { duration: 4500 })
}
