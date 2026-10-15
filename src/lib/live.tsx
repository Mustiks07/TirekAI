"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { api } from "./client";

// T051: open screens re-read their data after a change committed by anyone in the same
// organization/branch scope. The shell polls the change cursor once a second while the tab is
// visible; pages add the signal to their own refresh counter.
const Live = createContext(0);
export const LIVE_INTERVAL_MS = 1000;
export function LiveSync({
  organizationId,
  children,
}: {
  organizationId: string;
  children: ReactNode;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!organizationId) return;
    let last = "",
      stopped = false,
      busy = false;
    const poll = async () => {
      if (stopped || busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const r = await api<{ cursor: string }>(
          `organizations/${organizationId}/changes`,
        );
        if (!stopped && last && r.cursor !== last) setTick((v) => v + 1);
        last = r.cursor;
      } catch {
        // Offline or signed out: the screen keeps its data and its own error states.
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(poll, LIVE_INTERVAL_MS);
    const visible = () => void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [organizationId]);
  return <Live.Provider value={tick}>{children}</Live.Provider>;
}
export const useLive = () => useContext(Live);
// Drop-in replacement for `useState(0)` refresh counters: local actions still bump the counter,
// changes by other people add to it.
export function useRevision(): [number, Dispatch<SetStateAction<number>>] {
  const live = useLive(),
    [local, setLocal] = useState(0);
  return [local + live, setLocal];
}
