/** Runs a local qualification while making cleanup a mandatory outcome. */

export async function runQualificationWithCleanup(
  qualify,
  cleanup,
  label,
  options = {},
) {
  let result;
  let primaryError;
  try {
    result = await qualify();
  } catch (error) {
    primaryError = error;
  }

  let failureCaptureError;
  if (primaryError && options.beforeCleanup) {
    try {
      await options.beforeCleanup(primaryError);
    } catch (error) {
      failureCaptureError = error;
    }
  }

  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && failureCaptureError && cleanupError) {
    throw new AggregateError(
      [primaryError, failureCaptureError, cleanupError],
      `${label}, failure capture, and cleanup failed`,
    );
  }
  if (primaryError && failureCaptureError) {
    throw new AggregateError(
      [primaryError, failureCaptureError],
      `${label} and failure capture failed`,
    );
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
