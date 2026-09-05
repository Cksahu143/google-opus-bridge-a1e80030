// Legacy compatibility shim.
// The Vercel deployment uses Supabase's standard browser localStorage directly.
// Keep this export only so an older import cannot break a build during migration.
export function brokeredPreviewStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.localStorage;
}
