/** Runs a local qualification while making cleanup a mandatory outcome. */

export async function runQualificationWithCleanup(
  qualify,
  cleanup,
  label,
) {
  let result;
  let primaryError;
  try {
    result = await qualify();
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${label} and cleanup failed`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}
