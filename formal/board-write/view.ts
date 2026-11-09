type State = {
  file: { facts: number[]; valid: boolean };
  acknowledged: number[];
  wroteOverInvalid: boolean;
  replayChanged: boolean;
  route: { phase: string; round: number; journal: boolean; declined: boolean };
  agent: { phase: string };
};

export const title = 'Saving a board and noticing overwritten changes';
const phases: Record<string, string> = {
  idle: 'Ready to save your note', stat: 'Checking the file version', read: 'Reading the board',
  apply: 'Checking and applying your note', write: 'Ready to publish your note',
  retry: 'Another writer got there first', journal: 'Your note is saved; remembering intent',
  reply: 'Your save is complete; reply pending',
  done: 'You were told it is saved', busy: 'Too busy; you can resend',
  'invalid-source': 'Invalid board; nothing overwritten', 'not-found': 'Board not found',
  timeout: 'Reply lost; you can resend',
};
const agentPhases: Record<string, string> = {
  stat: 'Agent will read', read: 'Agent is reading', observe: 'Agent records the read version',
  ready: 'Agent can edit', confirm: 'Agent write succeeded; records its version', done: 'Agent finished',
};

export function state(v: State) {
  // Keep violations separate from safe states and from each other.
  const personLost = v.acknowledged.includes(0) && !v.file.facts.includes(0);
  const harm = [
    v.acknowledged.some(fact => fact !== 0 && !v.file.facts.includes(fact)) ? 'Agent acknowledged work lost' : '',
    personLost ? (!v.file.valid ? 'Person change absent; invalid source is visible' :
      v.route.journal ? (v.route.declined ? 'Recovery declined; loss still flagged' : 'Person change lost; journal flags it') : 'Person change silently lost') : '',
    v.wroteOverInvalid ? 'Invalid board overwritten' : '', v.replayChanged ? 'Replay wrote again' : '',
  ].filter(Boolean);
  return { YourSave: harm.length ? harm.join(' / ') : phases[v.route.phase], Agent: agentPhases[v.agent.phase] };
}

export function step(action: string, from: State, to: State) {
  const labels: Record<string, string> = {
    YouSendBatch: 'you save a note', YouResendBatch: 'you resend the same note',
    YouReapplyChange: 'you reapply the detected change', YouDeclineRecovery: 'you decline recovery',
    RouteRecordsIntent: 'the host retains applied intent before replying',
    YouLoseReply: 'the reply is lost', RouteStatsFile: 'the file is found',
    RouteReadsText: 'the text is read', RouteAppliesBatch: 'your absolute operation is applied',
    RouteWritesVersion: 'the version is checked under the file lock',
    RouteRetriesStale: 'the route tries again', RouteAnswersDone: 'you receive done',
    AgentStatsFile: 'the agent checks the version', AgentReadsFile: 'the agent reads the text',
    AgentObservesRead: 'the agent remembers that read version',
    AgentWritesObserved: 'the agent writes its edited snapshot',
    AgentEditsGuarded: 'the agent edits the current matching anchor',
    AgentPublishes: 'the agent attempts its write or matching hunk edit',
    AgentCreatesExistingRefused: 'a blind create is refused; read first',
    AgentEditsCurrent: 'a bare edit transforms current text under the lock',
    AgentObservesSuccess: 'the agent receives success', EveryoneRests: 'both writers are finished',
  };
  if (action === 'RouteStatsFile' && to.route.phase === 'not-found') return 'the file is absent';
  if (action === 'RouteAppliesBatch') {
    if (to.route.phase === 'invalid-source') return 'invalid JSON is refused';
    if (to.route.phase === 'journal') return 'the note is already there; no write';
  }
  if (action === 'RouteWritesVersion' && to.route.phase === 'retry') return 'the version changed; write refused';
  if (action === 'RouteRetriesStale' && to.route.phase === 'busy') return 'three rounds lost; answer busy';
  // Statechart can fall back to parent states when regions would invent transitions.
  return labels[action] ?? `${agentPhases[from.agent.phase]} to ${agentPhases[to.agent.phase]}`;
}

export const group = (v: State) => v.route.phase === 'done' ? 'saved' :
  ['busy', 'invalid-source', 'not-found', 'timeout'].includes(v.route.phase) ? 'refused' : 'working';
export const colors = { saved: 'teal', refused: 'orange', working: 'blue' };
