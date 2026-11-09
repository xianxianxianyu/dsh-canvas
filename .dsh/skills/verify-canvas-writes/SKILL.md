---
name: verify-canvas-writes
description: "Verify board-write concurrency in both DSH observation-policy modes, journal loss detection, replay, recovery and decline. Use when writeBoardOps, BoardJournal, the board route/check path, operations or filesystem guards change."
---

# Verify canvas writes

Read **statechart** first: `$HOME/.omp/agent/skills/statechart/SKILL.md`.
Read every result with statechart, including its shortest counterexamples. This
skill calls the installed tool; it does not copy TLC or the chart generator.
TLA+ fits this target because the question is which interleaving loses an
acknowledged change, not whether a parser accepts arbitrary input.

## Coverage and synchronization

**Source synchronization:** canvas same-commit subject
`fix(board): preserve untouched member source spans` (own-key rewrites preserve
unknown values byte-for-byte; protocol and retained-intent model unchanged); DSH source
`b830ec950faba0a46dda564be3e2d854afed94f1` (rc.5). The model, all configurations,
scratch controls and recorded results were rerun together. The installed 0.2.2-rc.1 P1
probe found the observation policy disabled, unlike that source default. Thus
`Policy = FALSE` is a supported, deliberately weaker mode—not a defect to hide.
Canvas does not enable a global policy: its skill tells agents to **edit**, not
blindly overwrite, an existing board. The journal detects replayable losses.

**Sync rule:** if `board-write.ts`, `BoardJournal`, or the route's write/check/
decline path changes, update/reconfirm the model and rerun this skill in the **same
commit**. Apply the same rule to covered board operations, DSH observation
policy, provider locking or publication semantics. Move the source-sync record
forward only after mapping the model to that new code; for a same-commit change,
record the unique commit subject until its hash exists, then advance it at the
next synchronization. Never invent a self-referential commit hash.

`DSH/` below denotes a DeepSeek Harness source checkout, not a workstation path.
Function names remain authoritative when line numbers move.

| Modeled action / predicate | Code and exact function |
|---|---|
| `YouSendBatch`, `YouResendBatch`, `RouteAnswersDone` | `src/host/route.ts` `handleBoard` / `boardRoute`: parse, call journal, HTTP outcome. Lost reply/resend is an environment action. |
| `RouteStatsFile` | `src/host/board-write.ts:38-42` `writeBoardOps` step 1; `MAX_ATTEMPTS:15`. |
| `RouteReadsText` | `board-write.ts:43-49` step 2; version and text are separate reads. |
| `RouteAppliesBatch` | `board-write.ts:51-55` step 3 and no-change return; `src/shared/board-ops.ts:53-58,73-78` `applyBoardOps` / `applyOne` (`addNote`). |
| `RouteWritesVersion` | `board-write.ts:57-59` step 4; `DSH/packages/fs/fs-local/src/index.ts:202-254` `LocalFileSystem.writeText`: `withLock`, version guard, atomic publication. |
| `RouteRetriesStale` | `board-write.ts:60-65` step 5: stale only, three rounds, busy. Other I/O errors and abort are outside this model. |
| `RouteRecordsIntent` | `src/host/board-journal.ts` `BoardJournal.apply` / `enqueue` / `record`: serialize routes per path, record only applied ops after publication and **before** HTTP success. A later applied request creates new retained intent, not the previously declined batch. |
| `JournalFlagsLoss`, `NoSilentLoss` | `BoardJournal.lost`: dry-run current text, any applied status means recoverable loss; `handleBoard` GET and `src/host/check.ts` `checkFile` expose losses, or explicitly report invalid source. `src/host/index.ts` `apply` shares one journal across route and check. |
| `YouReapplyChange` | Reapply submits the same ops through `handleBoard` / `BoardJournal.apply`; an unchanged retry does not create a batch. |
| `YouDeclineRecovery`, `DeclinedNeverReported` | `handleBoard` POST `{ sessionId?, path, decline: batchIds }` awaits `BoardJournal.decline` and echoes `{ declined: batchIds }`. `decline` uses the same per-path `enqueue` as `apply` and physically removes the selected retained batches. Absent IDs succeed; other batches/paths and board bytes are unchanged. The action models successful queued completion, not a local banner dismissal. |
| `AgentStatsFile`, `AgentReadsFile`, `AgentObservesRead` | `DSH/packages/fs/tool-fs/src/read.ts:137-163` `applyReadTool`'s `execute`; `read-target.ts:19-34` `resolveRegularReadTarget`: stat before text, emit the captured version afterwards. |
| `AgentWritesObserved`, `AgentEditsGuarded` | `DSH/packages/fs/fs-observation-policy/src/index.ts:65-87` `ObservedStateGate.writeIntent` / `editIntent`; `tool-fs/src/write.ts:121-131` `applyWriteTool`'s `execute`, `edit.ts:133-147` `applyEditTool`'s `execute`; `fs-local/src/index.ts:208-254,263-290` `writeText` / `editText`. With policy off, overwrite is blind; hunk edit still uses current text and fails when its anchor changed. |
| `AgentEditsCurrent` | `DSH/packages/fs/fs-local/src/index.ts:263-280` `LocalFileSystem.editText` with no expectation: current-text read/match/write under one lock. Models a hunk on an unaffected anchor; not a blind snapshot overwrite. Also covers a bare-provider caller when policy is on. |
| `AgentCreatesExistingRefused` | `DSH/packages/fs/fs-observation-policy/src/index.ts:65-70` `writeIntent`; `fs-local/src/index.ts:220-223` `writeText`. Policy-on unseen write is create-if-absent and refuses an existing file. |
| `AgentObservesSuccess` | `DSH/packages/fs/tool-fs/src/mutation-result.ts:18-20` `mutationResult`; `fs-observation-policy/src/index.ts:91-94,127-129` `observe` / synchronous listener. The outcome's version is recorded, not a fresh stat. When policy is off, this bookkeeping does not guard mutations. |
| Version counter | `DSH/packages/fs/fs-local/src/fsio.ts:75-76` `versionOf`, token `dev:ino:size:mtimeNs:ctimeNs`. Assumes no repeated token in modeled publications. |

## Run

Prerequisites: Node 26 (or supported native-TypeScript Node), project dependencies,
the installed statechart tool and its pinned **TLC 1.7.4 / Java Temurin 25** setup
through mise. Consult statechart for installation/overrides. Rendering uses the
plugin's Pele and local Chrome/Edge; it starts no DSH server and touches no DSH
profile. Run from the canvas repository root:

```sh
export STATECHART="$HOME/.omp/agent/skills/statechart/scripts/statechart"
OUT="$(mktemp -d)"
node formal/board-write/run.mjs "$OUT" --record
node formal/board-write/render.mjs "$OUT"
node scripts/check-public.mjs
```

Open `$OUT/chart.png`; inspect the actual drawing, not just the exit status.
`render.json` records its dimensions. `CANVAS_BROWSER` may select a Chrome/Edge
binary if discovery fails. Use a **fresh** output directory: statechart refuses
to overwrite its evidence. The run command checks exact expected holds/failures,
rejects unchecked properties, and executes real-code scratch controls. With
`--record`, it replaces its generated `formal/board-write/results/` and copies
`chart/chart.mmd` to `formal/board-write/chart.mmd`; paths in retained TLC logs
are sanitized. Omit `--record` for a read-only rerun. No product source is edited.

Individual statechart command (substitute any config below):

```sh
"$STATECHART" formal/board-write/BoardWrite.tla \
  --config formal/board-write/BoardWrite.cfg \
  --view formal/board-write/view.ts --out "$OUT/full"
```

## Promises, bounds and observed results

| Property | Meaning |
|---|---|
| `NoLostAcknowledgedChange` | Every agent success / route done fact remains. Holds with policy on; **expected to fail** with policy off, through blind agent overwrite. |
| `NoLostAgentChange` | Acknowledged agent facts remain in both supported modes. |
| `NoSilentLoss` | For a valid current file, acknowledged person intent is present, its retained journal dry-run flags it, **or the person declined it**. Invalid source is instead an explicit validation error. This is detectability on inspection, **not** instantaneous UI notification. |
| `DeclinedNeverReported` | A successfully declined batch is no longer retained, so neither the current loss nor a later overwrite can report it again. A later applied request is a new batch and clears the model's decline marker for that new intent. |
| `NeverWritesOverInvalid` | A route publication never replaces a currently invalid board, even if corruption happened after its read. |
| `ReplaySafe` | Replaying already-present absolute intent does not publish again or change the version. Reapplying an overwritten change is intentionally a new publication. |
| `RouteTerminates` | A started request finishes done, busy, invalid-source, not-found or with a lost completed reply, assuming fair scheduling and returning local I/O. |
| `RoundsBounded` | At most 3 rounds and 17 modeled route transitions per request, including journal recording and response. Not a wall-clock deadline. |
| `RecoveryEventually` | After finite interference, if source eventually stays valid, acknowledged lost intent eventually returns **or the person declines**. Requires fair route/user-choice scheduling; it does not promise repair of permanently invalid JSON. |
| `TypeOK`, `NoDeadlock` | State domains stay bounded and modeled unfinished states have a next action. |

`BoardWrite.cfg` (policy on) checks three agent publications and two ordinary
sends of one person batch, with repeatable journal recovery requests. All
stat/read/observe/write orderings, initial presence/validity, corruption, guarded
writes, current-text edits, stale reread, busy and lost completed replies are
included. `PolicyOff.cfg` has the same bound with blind overwrites permitted.
The journal has **one retained disjoint intent**: safely below its 20-batch
retention bound; no restart, eviction or supersession is modeled.

Recorded exhaustive outcomes: policy on **10,268 states**, all eleven rules hold;
policy off **21,205 states**, only `NoLostAcknowledgedChange` fails, while
`NoSilentLoss`, `DeclinedNeverReported`, `RecoveryEventually` and the other seven
rules hold. The retained-decline negative control reaches **276 states** and
breaks `DeclinedNeverReported` after twelve steps. These are bounded results,
not a proof of the entire application; `results/summary.json`, each case's
`report.md` / TLC output, and `results/code-probes.json` retain the evidence.

`Chart.cfg` has zero agent publications and two sends: **33 states**, all eleven
rules hold. It explains the person save workflow, not concurrency or decline.
Full safe runs exceed statechart's 500-state drawing budget; the policy-off and
retained-decline charts show their bug paths.
The English view shows route and agent regions, with parent-state fallback when
regions would invent transitions. No actions are hidden using `null`; the reports
state which self-label steps collapse.

## Make it fail

Statechart exits 1 for an expected counterexample. The run command accepts
exactly these failures, never an arbitrary failed invocation:

| Config | Mutation / expected failure |
|---|---|
| `NoCAS.cfg` | Remove route `replaceIfVersion`: agent publishes and gets success after route read; route blindly overwrites it. `NoLostAcknowledgedChange`, `NoLostAgentChange`, `NeverWritesOverInvalid` fail. |
| `RefreshObservation.cfg` | Hypothetically refresh agent observation on route write without giving it new text. Old-snapshot overwrite passes; `NoLostAcknowledgedChange` fails. **Not the real P1 finding**: installed P1 had no mounted policy, not a refreshed observation. |
| `SkipValidity.cfg` | Unsafe parse/recovery bypasses invalid-source refusal. `NeverWritesOverInvalid` fails. This does not pretend simply deleting an `if` produces usable output fields. |
| `ReplayWrites.cfg` | Remove the no-change branch. A resend writes identical bytes and changes version; `ReplaySafe` fails. |
| `NoJournal.cfg` | Policy off plus no retained intent. Blind overwrite silently loses the person change and the run can stay there forever. `NoLostAcknowledgedChange`, `NoSilentLoss`, `RecoveryEventually` fail. |
| `RetainDeclined.cfg` | Policy off plus `DeclineRemovesIntent = FALSE`: the person declines after a blind overwrite, but the batch stays retained. `NoLostAcknowledgedChange` and `DeclinedNeverReported` fail; all other rules hold. Every other config sets `DeclineRemovesIntent = TRUE`. |

`probe.mjs` loads in-memory scratch mutants of the **real** `writeBoardOps` and
`BoardJournal`: remove CAS, bypass invalid rejection, remove no-change return,
omit recording, and replace decline's batch-removal predicate so declined
entries remain retained. It observes the lost facts / unwanted writes / absent
loss report / repeated declined loss. It also exercises the normal writer and
journal: preserves both facts, exact replay keeps bytes/version/write count,
three interferences answer busy, resend succeeds, policy-off loss is detected
and reapply preserves the agent fact while restoring the person's. Awaited
`BoardJournal.decline(path, ids)` removes only selected batches for that path,
leaves the board unchanged, succeeds again with absent IDs, and prevents a later
overwrite from resurrecting the declined report. The retained-entry mutant
must still report that same batch both immediately and after a later overwrite.
The P1 refresh mutant uses a provider seam. These checks never edit `src/` and
do not establish a live DSH provider's behavior.

## Read a counterexample

Start with `results/<case>/report.md`; its step numbers begin at zero. Then read
`tlc.out`, or `tlc-<Property>.out` if a later pass found that property. Inspect
`file.facts`, `file.valid`, `file.version`, `agent.text`, `agent.seen`, `route.seen`,
`route.phase`, `route.journal`, `route.declined`, and `acknowledged`. Fact `0` is
the person change; facts `1..3` are agent changes. A transition is one stat/read,
synchronous parse, provider-locked publication, observation, journal record or
response—not a falsely atomic read/modify/write sequence.

For policy-off loss, follow the agent's old snapshot across the person's
publication, journal record and acknowledgement. The blind overwrite removes
fact 0. On valid text `BoardJournal.lost` would flag it; on invalid text validation
reports the broken source. A shortest trace can choose invalid text; the
real-code probe exercises the valid-text loss/detect/reapply path.
For `NoJournal`, its temporal counterexample ends in a permanent lost state.
For `RetainDeclined`, follow the valid-text loss, journal detection and
`YouDeclineRecovery`: the negative action sets `route.declined` but leaves
`route.journal` true. `DeclinedNeverReported` breaks there; the correct action
removes retained intent without changing the file. The real-code probe repeats
that sequence with the awaited journal method and proves a later loss cannot
revive the declined batch in the normal implementation.

Any unexpected normal-case failure must be preserved and replayed against the
real code, one action per step. If it cannot happen, first correct the model's
synchronization assumptions; do not weaken the property. Report real defects
before altering product behavior. Keep all controls failing after a redesign.
Use upstream `maintain-formal-verification-skill` when reconciling unverified
changes to covered code.

Board rewrites copy untouched member source spans, including whitespace, multiline
values and integer spellings outside JavaScript's exact-integer range. Only changed
fields are serialized; prototype-member names never select a change implicitly.
The JSON boundary rejects non-finite numbers, including overflowing exponents,
with their source location before geometry or write operations run.
Board JSON allows at most **128 nested containers**, counting the root object and
all arrays/objects in extension metadata. The first excessive opening bracket is
a located error. This bound also keeps accepted trees safe for recursive consumers.

## Limits

Finite model, one provider lock and one agent; no intentional deletes or edits
to the other author's fact. Corrupt syntax may retain underlying facts. It does
not prove arbitrary mixed batches, geometry, parser correctness, formatting,
text conflicts, same-id resurrection, journal supersession or retention policy.
The hunk anchor abstracts an element changed by the person; unaffected-anchor
edits use current content. Only one route is active (the journal serializes
`apply` and `decline`); successful decline completion is one transition.
The finite model abstracts a selected batch's identity with the journal/decline
markers; multiple IDs, idempotence, other paths, HTTP validation and owner-only
access require code/route checks. A timeout here is a lost **completed** apply
reply, not concurrent request cancellation.

Journal coverage ends on host restart or eviction and is not crash-atomic or
persistent. No external unlink/recreate, symlink race, crash, nonreturning I/O,
permission error, cancellation, concurrent tools in one agent session, separate
providers/processes, SSH files or metadata-token collision is modeled. Publication
is assumed atomic under the shared provider lock. The no-change response can
carry the earlier stat version; no freshness promise is made for that value.
Live P1/concurrency and UI checks remain required at these implementation edges.
