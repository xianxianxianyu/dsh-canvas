export const title = 'Keep resize recovery attached to its original save'
export function state(v: { readonly route: { readonly phase: string }; readonly file: { readonly x: number } }): string {
  const labels: Record<string, string> = {
    resize: 'Before resize', 'agent-width': 'Resize saved at time 1',
    drag: 'Agent changed width to 500', inspect: 'Drag saved at time 2',
    'agent-position': 'Recoverable resize selected', reapply: 'Agent moved to 60,60',
    done: v.file.x === 60 ? 'Resize reapplied without moving the node' : 'Recovery also reverted the newer position',
  }
  return labels[v.route.phase] ?? v.route.phase
}
export function step(action: string): string {
  return ({ FieldResize: 'you resize to 300 by 50', FieldAgentWidth: 'agent sets width to 500',
    FieldDrag: 'you drag to 40,40', FieldInspect: 'inspect retained fields and batch identity',
    FieldAgentPosition: 'agent moves to 60,60', FieldReapply: 'reapply only the selected retained fields',
    FieldDone: 'finished' } as Record<string, string>)[action] ?? action
}
