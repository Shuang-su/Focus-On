export const focusStates = {
  requestSaved: '待处理',
  branchReady: '处理中',
  needsInput: '待补充',
  pullReady: '待合并',
  merged: '待核验',
  readBack: '已入库',
  canceled: '已取消',
} as const;
export type FocusState = (typeof focusStates)[keyof typeof focusStates];
export const focusStateNames: readonly FocusState[] = Object.values(focusStates);

export function linearMapping(state: FocusState): { sync: 'disabled'; teamKey: 'FOCUS'; state: FocusState; note: string } {
  return {
    sync: 'disabled',
    teamKey: 'FOCUS',
    state,
    note: 'GitHub to Linear sync is not enabled. This mapping is local only.',
  };
}
