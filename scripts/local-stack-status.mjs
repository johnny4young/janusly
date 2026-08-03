/** Return a secret-free status result when the local Supabase CLI is stopped. */
export async function inspectLocalSupabase(readStatus) {
  try {
    return {
      available: true,
      status: await readStatus(),
    };
  } catch {
    return {
      available: false,
      status: null,
    };
  }
}

/** Keep lifecycle output useful without exposing captured Supabase credentials. */
export function formatLocalStackStatus(inspection, { authEnabled }) {
  if (!inspection.available) {
    return "[local] Supabase unavailable; the persistent stack is stopped or incomplete";
  }

  const authUrl = authEnabled ? inspection.status.API_URL : null;
  return `[local] unified Supabase PostgreSQL ready${authUrl ? ` · Auth ${authUrl}` : ""}`;
}
