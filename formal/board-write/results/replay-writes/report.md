# BoardWrite

TLC reached 35 states and 40 steps. The chart draws 13 states and 13 arrows.
The chart does not draw 14 steps that stay in one chart state.

## ReplaySafe breaks
The shortest path has 12 steps:
0. YourSave Ready to save your note, Agent Agent finished
1. you save a note: YourSave Checking the file version, Agent Agent finished
2. the file is found: YourSave Reading the board, Agent Agent finished
3. the text is read: YourSave Checking and applying your note, Agent Agent finished
4. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent finished
5. the version is checked under the file lock: YourSave Your note is saved; remembering intent, Agent Agent finished
6. the host retains applied intent before replying: YourSave Your save is complete; reply pending, Agent Agent finished
7. the reply is lost: YourSave Reply lost; you can resend, Agent Agent finished
8. you resend the same note: YourSave Checking the file version, Agent Agent finished
9. the file is found: YourSave Reading the board, Agent Agent finished
10. the text is read: YourSave Checking and applying your note, Agent Agent finished
11. your absolute operation is applied: YourSave Ready to publish your note, Agent Agent finished
12. the version is checked under the file lock: YourSave Replay wrote again, Agent Agent finished

## Rules that hold
TypeOK, NoLostAcknowledgedChange, NoLostAgentChange, NoSilentLoss, NeverWritesOverInvalid, RoundsBounded, NoDeadlock, RouteTerminates, RecoveryEventually
