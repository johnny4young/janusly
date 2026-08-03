export function classifySupabasePostgres18Probe({ status, stdout = "", stderr = "" }) {
  const diagnostic = `${stdout}\n${stderr}`.trim();
  if (/Invalid db\.major_version:\s*18\b/iu.test(diagnostic)) {
    return { configAccepted: false, operational: false, reason: "major_18_rejected" };
  }
  if (/Failed reading config:/iu.test(diagnostic)) {
    throw new Error(`Supabase failed to parse the probe config for an unrelated reason: ${diagnostic}`);
  }
  return {
    configAccepted: true,
    operational: status === 0,
    reason: status === 0 ? "major_18_accepted" : "major_18_accepted_environment_unavailable",
  };
}
