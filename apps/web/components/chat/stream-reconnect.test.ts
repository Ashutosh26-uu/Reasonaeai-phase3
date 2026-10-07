import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamReconnectNotice,
  STREAM_RECONNECT_NOTICE_DELAY_MS,
} from "./stream-reconnect";

afterEach(() => vi.useRealTimers());

describe("stream interruption notice", () => {
  it("keeps short disconnects quiet and cancels the warning on recovery", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const notice = createStreamReconnectNotice(notify, vi.fn());
    notice.interrupted();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    notice.recovered();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS);
    expect(notify).not.toHaveBeenCalled();
  });
  it("warns once for a sustained outage without repeated errors restarting its deadline", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const notice = createStreamReconnectNotice(notify, vi.fn());
    notice.interrupted();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS / 2);
    notice.interrupted();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS / 2);
    expect(notify).toHaveBeenCalledTimes(1);
    notice.interrupted();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS);
    expect(notify).toHaveBeenCalledTimes(1);
    notice.recovered();
    notice.interrupted();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("keeps the outage deadline through short-lived successful handshakes", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const recovered = vi.fn();
    const notice = createStreamReconnectNotice(notify, recovered);
    notice.interrupted();
    vi.advanceTimersByTime(3000);
    notice.connected();
    vi.advanceTimersByTime(1000);
    notice.interrupted();
    vi.advanceTimersByTime(4000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(recovered).not.toHaveBeenCalled();
    notice.connected();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS);
    expect(recovered).toHaveBeenCalledTimes(1);
    notice.connected();
    notice.recovered();
    vi.advanceTimersByTime(STREAM_RECONNECT_NOTICE_DELAY_MS);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
