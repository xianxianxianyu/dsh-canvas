# BoardWrite

TLC reached 284 states and 536 steps. The chart draws 65 states and 131 arrows.
The chart does not draw 52 steps that stay in one chart state.
The model goes from YourSave Your note is saved; remembering intent, Agent Agent write succeeded; records its version to YourSave Your note is saved; remembering intent, Agent Agent finished by the agent receives success, which the regions chart cannot show. So the chart draws parent states in place of regions.

## NeverWritesOverInvalid breaks
The shortest path has 6 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. you save a note: YourSave Checking the file version, Agent Agent will read
2. the file is found: YourSave Reading the board, Agent Agent will read
3. the text is read: YourSave Checking and applying your note, Agent Agent will read
4. a bare edit transforms current text under the lock: YourSave Checking and applying your note, Agent Agent write succeeded; records its version
5. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent write succeeded; records its version
6. the version is checked under the file lock: YourSave Invalid board overwritten, Agent Agent write succeeded; records its version

## NoLostAcknowledgedChange breaks
The shortest path has 7 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. you save a note: YourSave Checking the file version, Agent Agent will read
2. the file is found: YourSave Reading the board, Agent Agent will read
3. the text is read: YourSave Checking and applying your note, Agent Agent will read
4. a bare edit transforms current text under the lock: YourSave Checking and applying your note, Agent Agent write succeeded; records its version
5. the agent receives success: YourSave Checking and applying your note, Agent Agent finished
6. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent finished
7. the version is checked under the file lock: YourSave Agent acknowledged work lost / Invalid board overwritten, Agent Agent finished

## NoLostAgentChange breaks
The shortest path has 7 steps:
0. YourSave Ready to save your note, Agent Agent will read
1. you save a note: YourSave Checking the file version, Agent Agent will read
2. the file is found: YourSave Reading the board, Agent Agent will read
3. the text is read: YourSave Checking and applying your note, Agent Agent will read
4. a bare edit transforms current text under the lock: YourSave Checking and applying your note, Agent Agent write succeeded; records its version
5. the agent receives success: YourSave Checking and applying your note, Agent Agent finished
6. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent finished
7. the version is checked under the file lock: YourSave Agent acknowledged work lost / Invalid board overwritten, Agent Agent finished

## Rules that hold
TypeOK, NoSilentLoss, ReplaySafe, RoundsBounded, NoDeadlock, RouteTerminates, RecoveryEventually
