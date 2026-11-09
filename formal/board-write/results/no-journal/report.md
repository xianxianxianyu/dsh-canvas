# BoardWrite

TLC reached 242 states and 435 steps. The chart draws 68 states and 136 arrows.
The chart does not draw 27 steps that stay in one chart state.
The regions chart lets YourSave You were told it is saved, Agent Agent can edit go to YourSave Person change absent; invalid source is visible, Agent Agent will read by the agent attempts its write or matching hunk edit, which the model never does. So the chart draws parent states in place of regions.

## NoLostAcknowledgedChange breaks
The shortest path has 11 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. the agent checks the version: YourSave Ready to save your note, Agent Agent is reading
2. the agent reads the text: YourSave Ready to save your note, Agent Agent records the read version
3. the agent remembers that read version: YourSave Ready to save your note, Agent Agent can edit
4. you save a note: YourSave Checking the file version, Agent Agent can edit
5. the file is found: YourSave Reading the board, Agent Agent can edit
6. the text is read: YourSave Checking and applying your note, Agent Agent can edit
7. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent can edit
8. the version is checked under the file lock: YourSave Your note is saved; remembering intent, Agent Agent can edit
9. the agent attempts its write or matching hunk edit: YourSave Your note is saved; remembering intent, Agent Agent write succeeded; records its version
10. the host retains applied intent before replying: YourSave Your save is complete; reply pending, Agent Agent write succeeded; records its version
11. you receive done: YourSave Person change absent; invalid source is visible, Agent Agent write succeeded; records its version

## NoSilentLoss breaks
The shortest path has 11 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. the agent checks the version: YourSave Ready to save your note, Agent Agent is reading
2. the agent reads the text: YourSave Ready to save your note, Agent Agent records the read version
3. the agent remembers that read version: YourSave Ready to save your note, Agent Agent can edit
4. you save a note: YourSave Checking the file version, Agent Agent can edit
5. the file is found: YourSave Reading the board, Agent Agent can edit
6. the text is read: YourSave Checking and applying your note, Agent Agent can edit
7. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent can edit
8. the version is checked under the file lock: YourSave Your note is saved; remembering intent, Agent Agent can edit
9. the agent attempts its write or matching hunk edit: YourSave Your note is saved; remembering intent, Agent Agent write succeeded; records its version
10. the host retains applied intent before replying: YourSave Your save is complete; reply pending, Agent Agent write succeeded; records its version
11. you receive done: YourSave Person change silently lost, Agent Agent write succeeded; records its version

## RecoveryEventually breaks
TLC's counterexample is in tlc-RecoveryEventually.out. It has 12 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. you save a note: YourSave Checking the file version, Agent Agent will read
2. the file is found: YourSave Reading the board, Agent Agent will read
3. the text is read: YourSave Checking and applying your note, Agent Agent will read
4. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent will read
5. the agent checks the version: YourSave Ready to publish your note, Agent Agent is reading
6. the agent reads the text: YourSave Ready to publish your note, Agent Agent records the read version
7. the agent remembers that read version: YourSave Ready to publish your note, Agent Agent can edit
8. the version is checked under the file lock: YourSave Your note is saved; remembering intent, Agent Agent can edit
9. the host retains applied intent before replying: YourSave Your save is complete; reply pending, Agent Agent can edit
10. you receive done: YourSave You were told it is saved, Agent Agent can edit
11. the agent attempts its write or matching hunk edit: YourSave Person change silently lost, Agent Agent write succeeded; records its version
12. the agent receives success: YourSave Person change silently lost, Agent Agent finished
The run stops in "YourSave Person change silently lost, Agent Agent finished" forever.

## Rules that hold
TypeOK, NoLostAgentChange, NeverWritesOverInvalid, ReplaySafe, RoundsBounded, NoDeadlock, RouteTerminates
