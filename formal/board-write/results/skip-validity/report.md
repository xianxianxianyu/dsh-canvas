# BoardWrite

TLC reached 462 states and 874 steps. The chart draws 18 states and 20 arrows.
The chart does not draw 154 steps that stay in one chart state.

## NeverWritesOverInvalid breaks
The shortest path has 5 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. you save a note: YourSave Checking the file version, Agent Agent will read
2. the file is found: YourSave Reading the board, Agent Agent will read
3. the text is read: YourSave Checking and applying your note, Agent Agent will read
4. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent will read
5. the version is checked under the file lock: YourSave Invalid board overwritten, Agent Agent will read

## Rules that hold
TypeOK, NoLostAcknowledgedChange, NoLostAgentChange, NoSilentLoss, DeclinedNeverReported, ReplaySafe, RoundsBounded, NoDeadlock, RouteTerminates, RecoveryEventually
