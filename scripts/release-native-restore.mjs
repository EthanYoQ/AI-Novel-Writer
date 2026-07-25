/* eslint-env node */

/**
 * Run the monitored native-runtime restoration first. If the monitor has
 * already published a terminal failure (even while its process is still
 * alive), repeat the complete restore + validation sequence independently.
 *
 * Both operations must be idempotent because the monitored attempt may have
 * restored the ABI before failing on its validation/status handshake.
 */
export async function restoreNativeWithIndependentFallback({
  restoreMonitored,
  restoreIndependent,
}) {
  try {
    await restoreMonitored()
    return {
      usedIndependentFallback: false,
      monitoredError: undefined,
    }
  } catch (monitoredError) {
    try {
      await restoreIndependent()
    } catch (independentError) {
      throw new AggregateError(
        [monitoredError, independentError],
        'Monitored and independent native-runtime restoration both failed',
        { cause: independentError },
      )
    }
    return {
      usedIndependentFallback: true,
      monitoredError,
    }
  }
}
