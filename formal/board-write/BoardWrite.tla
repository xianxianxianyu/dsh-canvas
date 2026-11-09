---------------------------- MODULE BoardWrite ----------------------------
EXTENDS Integers

CONSTANTS MaxAttempts, AgentWrites, Requests, RouteCAS, RefreshObservation,
          CheckValidity, SkipUnchanged, Policy, JournalEnabled

\* One local fs provider / per-file lock. Every publication gets a fresh token.
\* Facts 1..AgentWrites belong to the agent; fact 0 belongs to the person.
\* No actor deliberately deletes any fact. Invalid syntax can retain facts.
VARIABLES file, agent, route, acknowledged, wroteOverInvalid, replayChanged
vars == <<file, agent, route, acknowledged, wroteOverInvalid, replayChanged>>
Facts == 0..AgentWrites
Terminal == {"done", "busy", "invalid-source", "not-found", "timeout"}
Active == {"stat", "read", "apply", "write", "retry", "journal", "reply"}
Apply(facts) == facts \cup {0}
\* BoardJournal.lost, board-journal.ts:97-104: pure dry-run on valid current text.
\* route.ts:122-124 / check.ts:129-137 surface invalid source separately.
JournalFlagsLoss == route.journal /\ file.valid /\ Apply(file.facts) # file.facts

Init ==
  /\ file \in [exists : BOOLEAN, version : {0}, facts : {{}}, valid : BOOLEAN]
  /\ agent = [phase |-> IF AgentWrites = 0 THEN "done" ELSE "stat",
               base |-> 0, seen |-> -1, text |-> {}, n |-> 1, published |-> 0]
  /\ route = [phase |-> "idle", round |-> 0, seen |-> 0, text |-> {},
               valid |-> TRUE, request |-> 0, changed |-> FALSE, steps |-> 0,
               journal |-> FALSE, declined |-> FALSE]
  /\ acknowledged = {}
  /\ wroteOverInvalid = FALSE
  /\ replayChanged = FALSE

\* Person's request: route.ts:126-142, BoardJournal.apply:58-71. Serialized per file.
YouSendBatch ==
  /\ route.phase = "idle"
  /\ route' = [route EXCEPT !.phase = "stat", !.round = 1, !.request = 1]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* Lost response after commit is a timeout; a resend has the same absolute ops.
YouLoseReply ==
  /\ route.phase = "reply"
  /\ route' = [route EXCEPT !.phase = "timeout"]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

YouResendBatch ==
  /\ route.phase \in {"done", "busy", "timeout"}
  /\ route.request < Requests
  /\ route' = [route EXCEPT !.phase = "stat", !.round = 1,
                            !.request = @ + 1, !.steps = 0, !.changed = FALSE]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* A retained intent may be reapplied after detection, including another busy.
\* Requests are serialized. Recovery reuses the last request slot, not a limit
\* on the person's ability to retry. A decline is a local choice, not journal loss.
YouReapplyChange ==
  /\ route.phase \in Terminal /\ JournalFlagsLoss /\ ~route.declined
  /\ route' = [route EXCEPT !.phase = "stat", !.round = 1, !.steps = 0,
       !.changed = FALSE, !.request = IF @ < Requests THEN @ + 1 ELSE @]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

YouDeclineRecovery ==
  /\ route.phase \in Terminal /\ JournalFlagsLoss /\ ~route.declined
  /\ route' = [route EXCEPT !.declined = TRUE]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* writeBoardOps step 1, board-write.ts:39-42.
RouteStatsFile ==
  /\ route.phase = "stat"
  /\ route' = [route EXCEPT !.seen = file.version, !.steps = @ + 1,
                !.phase = IF file.exists THEN "read" ELSE "not-found"]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* Step 2, board-write.ts:43-49. Separate from stat, not one snapshot.
RouteReadsText ==
  /\ route.phase = "read"
  /\ route' = [route EXCEPT !.text = file.facts, !.valid = file.valid,
                !.steps = @ + 1, !.phase = "apply"]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* Step 3 and no-change branch, board-write.ts:51-55; board-ops.ts:53-58,73-78.
RouteAppliesBatch ==
  /\ route.phase = "apply"
  /\ route' = [route EXCEPT !.steps = @ + 1,
       !.phase = IF CheckValidity /\ ~route.valid THEN "invalid-source"
                 ELSE IF SkipUnchanged /\ Apply(route.text) = route.text
                      THEN "journal" ELSE "write"]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* Step 4 + provider's lock: board-write.ts:57-59; fs-local/index.ts:208-254.
\* Skipping validity models an unsafe parse/recovery path that emits valid output.
RouteWritesVersion ==
  /\ route.phase = "write"
  /\ IF ~RouteCAS \/ (file.exists /\ file.version = route.seen)
     THEN /\ file' = [file EXCEPT !.version = @ + 1,
                       !.facts = Apply(route.text), !.valid = TRUE]
          /\ route' = [route EXCEPT !.phase = "journal", !.steps = @ + 1,
                                     !.changed = TRUE]
          /\ agent' = IF RefreshObservation
                      THEN [agent EXCEPT !.seen = file.version + 1] ELSE agent
          /\ wroteOverInvalid' = (wroteOverInvalid \/ ~file.valid)
          /\ replayChanged' = (replayChanged \/ Apply(route.text) = route.text)
     ELSE /\ route' = [route EXCEPT !.phase = "retry", !.steps = @ + 1]
          /\ UNCHANGED <<file, agent, wroteOverInvalid, replayChanged>>
  /\ UNCHANGED acknowledged

\* Step 5, board-write.ts:60-65. Failed publication changes no file/observation.
RouteRetriesStale ==
  /\ route.phase = "retry"
  /\ route' = [route EXCEPT !.steps = @ + 1,
          !.phase = IF route.round = MaxAttempts THEN "busy" ELSE "stat",
          !.round = IF @ = MaxAttempts THEN @ ELSE @ + 1]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* BoardJournal.apply:62-64 and record:74-95. Record after writeBoardOps success,
\* before HTTP acknowledgement; only applied operations create retained intent.
RouteRecordsIntent ==
  /\ route.phase = "journal"
  /\ route' = [route EXCEPT !.phase = "reply", !.steps = @ + 1,
       !.journal = (@ \/ (JournalEnabled /\ route.changed))]
  /\ UNCHANGED <<file, agent, acknowledged, wroteOverInvalid, replayChanged>>

\* HTTP 200, route.ts:129-132; acknowledgement follows publication and record.
RouteAnswersDone ==
  /\ route.phase = "reply"
  /\ route' = [route EXCEPT !.phase = "done", !.steps = @ + 1]
  /\ acknowledged' = acknowledged \cup {0}
  /\ UNCHANGED <<file, agent, wroteOverInvalid, replayChanged>>

\* tool-fs/read.ts:139-147: stat precedes read; observation comes afterwards.
AgentStatsFile ==
  /\ agent.phase = "stat"
  /\ agent' = [agent EXCEPT !.base = file.version,
                !.phase = IF file.exists THEN "read" ELSE "done"]
  /\ UNCHANGED <<file, route, acknowledged, wroteOverInvalid, replayChanged>>

AgentReadsFile ==
  /\ agent.phase = "read"
  /\ agent' = [agent EXCEPT !.text = file.facts, !.phase = "observe"]
  /\ UNCHANGED <<file, route, acknowledged, wroteOverInvalid, replayChanged>>

\* tool-fs/read.ts:163; observation-policy/index.ts:91-94,127-129.
\* Observe the earlier stat's token, NEVER a fresh stat after reading old text.
AgentObservesRead ==
  /\ agent.phase = "observe"
  /\ agent' = [agent EXCEPT !.seen = IF Policy THEN agent.base ELSE -1,
                           !.phase = "ready"]
  /\ UNCHANGED <<file, route, acknowledged, wroteOverInvalid, replayChanged>>

\* With policy on, observed versions guard both operations. With policy off,
\* overwriting write is BLIND; hunk edit still transforms current text in-lock.
\* The anchor is an element changed by the person's operation (fact 0).
\* A nonmatching hunk fails and the agent rereads rather than overwriting.
\* observation-policy/index.ts:65-87; tool-fs/write.ts:121-131,edit.ts:133-147;
\* fs-local/index.ts:208-254,263-290. Syntax may be broken or repaired.
AgentPublishes(basis, anchorMatches) ==
  /\ agent.phase = "ready"
  /\ IF file.exists /\ (~Policy \/ agent.seen = file.version) /\ anchorMatches
     THEN /\ \E valid \in BOOLEAN:
               file' = [file EXCEPT !.facts = basis \cup {agent.n},
                         !.version = @ + 1, !.valid = valid]
          /\ agent' = [agent EXCEPT !.published = file.version + 1,
                                     !.phase = "confirm"]
     ELSE /\ agent' = [agent EXCEPT !.phase = "stat"]
          /\ UNCHANGED file
  /\ UNCHANGED <<route, acknowledged, wroteOverInvalid, replayChanged>>

AgentWritesObserved == AgentPublishes(agent.text, TRUE)
AgentEditsGuarded == AgentPublishes(file.facts, (0 \in agent.text) = (0 \in file.facts))

\* Bare provider only: no expectation, but read/match/write share the lock.
\* This is NOT a blind whole-file overwrite and is not allowed by mounted policy.
\* fs-local/index.ts:263-280. Covers an independent caller of the bare seam.
AgentEditsCurrent ==
  /\ agent.phase = "stat" /\ file.exists
  /\ \E valid \in BOOLEAN:
       file' = [file EXCEPT !.facts = @ \cup {agent.n},
                           !.version = @ + 1, !.valid = valid]
  /\ agent' = [agent EXCEPT !.published = file.version + 1, !.phase = "confirm"]
  /\ UNCHANGED <<route, acknowledged, wroteOverInvalid, replayChanged>>

\* tool-fs/mutation-result.ts:18-20. It records the outcome, not current stat.
AgentObservesSuccess ==
  /\ agent.phase = "confirm"
  /\ acknowledged' = acknowledged \cup {agent.n}
  /\ agent' = [agent EXCEPT !.seen = agent.published, !.n = @ + 1,
                !.phase = IF agent.n = AgentWrites THEN "done" ELSE "stat"]
  /\ UNCHANGED <<file, route, wroteOverInvalid, replayChanged>>

\* Unseen write intent is createIfAbsent, never a blind overwrite of an existing
\* file: observation-policy/index.ts:65-70; fs-local/index.ts:220-223.
AgentCreatesExistingRefused ==
  /\ Policy /\ agent.phase = "stat" /\ agent.seen = -1 /\ file.exists
  /\ UNCHANGED vars

EveryoneRests ==
  /\ agent.phase = "done" /\ route.phase \in Terminal
  /\ UNCHANGED vars

RouteStep == RouteStatsFile \/ RouteReadsText \/ RouteAppliesBatch
          \/ RouteWritesVersion \/ RouteRetriesStale \/ RouteRecordsIntent \/ RouteAnswersDone
Next == YouSendBatch \/ YouLoseReply \/ YouResendBatch
     \/ YouReapplyChange \/ YouDeclineRecovery
     \/ RouteStatsFile \/ RouteReadsText \/ RouteAppliesBatch
     \/ RouteWritesVersion \/ RouteRetriesStale \/ RouteRecordsIntent \/ RouteAnswersDone
     \/ AgentStatsFile \/ AgentReadsFile \/ AgentObservesRead
     \/ AgentWritesObserved \/ AgentEditsGuarded \/ AgentEditsCurrent
     \/ AgentObservesSuccess \/ AgentCreatesExistingRefused \/ EveryoneRests

Spec == Init /\ [][Next]_vars /\ WF_vars(RouteStep)
        /\ WF_vars(YouReapplyChange \/ YouDeclineRecovery)

TypeOK == /\ file.facts \subseteq Facts /\ acknowledged \subseteq Facts
          /\ file.version \in 0..(2 * AgentWrites + Requests)
          /\ file.valid \in BOOLEAN /\ file.exists \in BOOLEAN
          /\ route.phase \in Active \cup Terminal \cup {"idle"}
          /\ agent.n \in 1..(AgentWrites + 1)
NoLostAcknowledgedChange == acknowledged \subseteq file.facts
NoLostAgentChange == (acknowledged \ {0}) \subseteq file.facts
\* Detection is on inspection, not an instantaneous push notification. Invalid
\* source is a visible validation error, not a dry-run loss result or a safe replay.
NoSilentLoss == (0 \in acknowledged) =>
  ((0 \in file.facts) \/ JournalFlagsLoss \/ ~file.valid)
NeverWritesOverInvalid == ~wroteOverInvalid
ReplaySafe == ~replayChanged
RoundsBounded == /\ route.round \in 0..MaxAttempts
                /\ route.steps <= 5 * MaxAttempts + 2
\* Request identity avoids mistaking a later retry for completion of this call.
\* Fairness means scheduled local fs calls return; not a wall-clock guarantee.
RouteTerminates == \A id \in 1..Requests:
  (route.request = id /\ route.phase \in Active)
    ~> (route.request # id \/ route.phase \in Terminal)
\* Once interference ceases, a valid source permits repair. Fair user choice
\* may instead decline. Invalid JSON forever cannot be safely repaired here.
RecoveryEventually == (<>[]file.valid) =>
  ((0 \in acknowledged /\ 0 \notin file.facts) ~> (0 \in file.facts \/ route.declined))
=============================================================================
