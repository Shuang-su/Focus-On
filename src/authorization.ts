export const captureGrant = 'capture';
export const financeConfirmGrant = 'finance-confirm';
const knownGrants = new Set([captureGrant, financeConfirmGrant]);

export function unknownGrants(grants: readonly string[]): string[] {
  return grants.filter(grant => !knownGrants.has(grant));
}

export function confirmationAttempt(request: unknown): boolean {
  if (!request || typeof request !== 'object') return false;
  const body = request as { confirmFinance?: unknown; operations?: unknown };
  if (body.confirmFinance === true) return true;
  if (!Array.isArray(body.operations)) return false;
  return body.operations.some(operation => {
    if (!operation || typeof operation !== 'object') return false;
    const record = (operation as { record?: { kind?: unknown; status?: unknown } }).record;
    return record?.kind === 'finance_draft' && record.status !== 'pending';
  });
}

export function assertCaptureAuthorized(grants: readonly string[], request: unknown): void {
  const unknown = unknownGrants(grants);
  if (unknown.length) throw new Error('Unknown authorization: ' + unknown.join(', '));
  if (!grants.includes(captureGrant)) throw new Error('Authorization required: pass --authorize capture. The default path remains plan-only.');
  if (!confirmationAttempt(request)) return;
  if (!grants.includes(financeConfirmGrant)) throw new Error('Finance confirmation requires a separate --authorize finance-confirm and is not applied.');
  throw new Error('Finance confirmation was separately authorized but is not applied. Format v1 only stores pending drafts.');
}

export function refuseFinanceConfirmation(grants: readonly string[]): never {
  const unknown = unknownGrants(grants);
  if (unknown.length) throw new Error('Unknown authorization: ' + unknown.join(', '));
  if (!grants.includes(financeConfirmGrant)) throw new Error('Finance confirmation requires a separate --authorize finance-confirm and is not applied.');
  throw new Error('Finance confirmation was separately authorized but is not applied. Format v1 only stores pending drafts.');
}
