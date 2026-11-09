# BoardWrite

TLC reached 22,099 states, more than the chart budget of 500, so the chart draws only the bug paths: 14 states and 12 arrows.
The step the agent attempts its write or matching hunk edit changes YourSave and Agent at the same time.

## NoLostAcknowledgedChange breaks
The shortest path has 11 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. you save a note: YourSave Checking the file version, Agent Agent will read
2. the file is found: YourSave Reading the board, Agent Agent will read
3. the text is read: YourSave Checking and applying your note, Agent Agent will read
4. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent will read
5. the agent checks the version: YourSave Ready to publish your note, Agent Agent is reading
6. the agent reads the text: YourSave Ready to publish your note, Agent Agent records the read version
7. the version is checked under the file lock: YourSave Your note is saved; remembering intent, Agent Agent records the read version
8. the host retains applied intent before replying: YourSave Your save is complete; reply pending, Agent Agent records the read version
9. you receive done: YourSave You were told it is saved, Agent Agent records the read version
10. the agent remembers that read version: YourSave You were told it is saved, Agent Agent can edit
11. the agent attempts its write or matching hunk edit: YourSave Person change absent; invalid source is visible, Agent Agent write succeeded; records its version

## Rules that hold
TypeOK, NoLostAgentChange, NoSilentLoss, NeverWritesOverInvalid, ReplaySafe, RoundsBounded, NoDeadlock, RouteTerminates, RecoveryEventually
