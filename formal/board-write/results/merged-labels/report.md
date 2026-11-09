# BoardWrite

TLC reached 7 states and 7 steps. The chart draws 7 states and 6 arrows.
The chart does not draw 1 steps that stay in one chart state.

## RetainedFieldIdentity breaks
The shortest path has 3 steps:
0. Before resize
1. you resize to 300 by 50: Resize saved at time 1
2. agent sets width to 500: Agent changed width to 500
3. you drag to 40,40: Drag saved at time 2

## RecoveryUsesRetainedFields breaks
The shortest path has 6 steps:
0. Before resize
1. you resize to 300 by 50: Resize saved at time 1
2. agent sets width to 500: Agent changed width to 500
3. you drag to 40,40: Drag saved at time 2
4. inspect retained fields and batch identity: Recoverable resize selected
5. agent moves to 60,60: Agent moved to 60,60
6. reapply only the selected retained fields: Recovery also reverted the newer position

## Rules that hold
FieldTypeOK, NoDeadlock
