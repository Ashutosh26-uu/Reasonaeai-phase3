export const STREAM_RECONNECT_NOTICE_DELAY_MS = 8000;

/** Brief retries stay quiet; one sustained outage produces one notice. */
export function createStreamReconnectNotice(
  notify: () => void,
  onRecovered: () => void
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let notified = false;
  function recovered() {
    clearTimeout(timer);
    clearTimeout(recoveryTimer);
    timer = undefined;
    recoveryTimer = undefined;
    notified = false;
  }
  return {
    connected() {
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        recovered();
        onRecovered();
      }, STREAM_RECONNECT_NOTICE_DELAY_MS);
    },
    interrupted() {
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
      if (timer !== undefined || notified) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        notified = true;
        notify();
      }, STREAM_RECONNECT_NOTICE_DELAY_MS);
    },
    recovered,
  };
}
