/**
 * iOS Lab simulator panel: pick an installed device, attach (boot) it and watch its screen here.
 * Attach and detach stay previewed lab actions (start with a device option, stop), so nothing
 * runs without confirmation; the screen is the booted device's screenshot via the console.
 * The card lives in a right-side panel that the lab header's Simulator icon toggles, so the
 * page stays focused on readiness and actions until the mirror is wanted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwiseIcon,
  CameraIcon,
  CircleNotchIcon,
  DeviceMobileIcon,
  FrameCornersIcon,
  PowerIcon,
  XIcon
} from "@phosphor-icons/react";
import { Badge, Empty, Field, IconButton, Skeleton, Status } from "../components/ui";
import { api, message, usePoll, type CleanupVolumes, type IosDevicesInfo, type IosResources } from "../lib/api";
import { localeFromPath, localePath } from "../i18n/paths";
import { keepModalFocus } from "./modal-focus";
import type { LabRequest } from "../lib/api";

/** Screens refresh a little slower than jobs; each frame is one simctl screenshot on this Mac. */
const SCREEN_INTERVAL = 5000;
/** Real devices change rarely; devicectl costs a subprocess, so this polls gently. */
const DEVICES_INTERVAL = 30000;
/** Below this much free space on the home volume, the drawer points at the relocation tab. */
const DISK_TIGHT_BYTES = 20 * 1024 ** 3;

const locale = () => (typeof window === "undefined" ? "en" : localeFromPath(window.location.pathname));
const AUTO_STOP_KEY = "oslab.ios.autostop";
const RESOURCE_DIALOG_COOLDOWN_MS = 5 * 60 * 1000;

const gib = (bytesValue: number | null | undefined) =>
  bytesValue == null ? "?" : `${(bytesValue / 1024 ** 3).toFixed(1)} GiB`;

function fmtBytes(bytesValue: number | null | undefined) {
  if (bytesValue == null) return "?";
  if (bytesValue >= 1024 ** 3) return `${(bytesValue / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.round(bytesValue / 1024 ** 2)} MiB`;
}

/** One pressure bar; the tone hardens as the value crosses warn, then critical. */
function Meter({ label, percent, detail, warn, critical }: { label: string; percent: number | null; detail: string; warn: number; critical: number }) {
  const tone = percent == null ? "bg-(--iux-muted-foreground)"
    : percent >= critical ? "bg-(--iux-danger)"
    : percent >= warn ? "bg-(--iux-warning)" : "bg-(--iux-success)";
  return <div>
    <div className="flex items-center justify-between text-xs">
      <span className="font-medium">{label}</span>
      <span dir="ltr" className="tabular-nums text-(--iux-muted-foreground)">{detail}</span>
    </div>
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-(--iux-muted)" role="progressbar"
      aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${percent == null ? 0 : Math.min(percent, 100)}%` }} />
    </div>
  </div>;
}

/** The critical alert: numbers, one-click stops that still ride the previewed plan → token flow, dismiss. */
function ResourceDialog({
  resources, selectedName, stopping, stopError, onStopAll, onStopSelected, onDismiss
}: {
  resources: IosResources; selectedName: string | null; stopping: boolean; stopError: string;
  onStopAll: () => void; onStopSelected: () => void; onDismiss: () => void;
}) {
  const box = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.showModal();
    box.current?.focus();
    return () => {
      if (box.current?.open) box.current.close();
      document.body.style.overflow = previousOverflow;
      prev?.focus();
    };
  }, []);
  const mem = resources.memory?.percent;
  const cpu = resources.cpu?.percent;
  return <dialog ref={box} tabIndex={-1} aria-labelledby="resource-alert-title"
    className="iux-dialog m-auto w-[calc(100%-2rem)] max-w-md rounded-xl p-5"
    onClose={onDismiss} onKeyDown={keepModalFocus}
    onMouseDown={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        event.preventDefault();
        onDismiss();
      }
    }}>
    <h2 id="resource-alert-title" className="text-sm font-semibold">System resources are running low</h2>
    <p className="mt-2 text-sm">The simulator will lag. Stop simulators to free memory and CPU.</p>
    <p className="mt-1 text-xs text-(--iux-muted-foreground)" dir="ltr">
      {mem != null ? `RAM ${mem}%` : ""}{cpu != null ? ` · CPU ${cpu}%` : ""}
    </p>
    {stopError && <Status value={{ ok: false, text: stopError }} />}
    <div className="mt-4 flex flex-col gap-2">
      <button type="button" className="iux-btn" data-variant="primary" disabled={stopping} onClick={onStopAll}>
        <PowerIcon size={14} /> Stop all simulators
      </button>
      {selectedName && (
        <button type="button" className="iux-btn" disabled={stopping} onClick={onStopSelected}>
          Stop the selected device{selectedName ? ` (${selectedName})` : ""}
        </button>
      )}
      <button type="button" className="iux-btn" onClick={onDismiss}>Dismiss</button>
    </div>
  </dialog>;
}

export function SimulatorDrawer({ open, onClose, onPreview }: { open: boolean; onClose: () => void; onPreview: (action: string, extra?: Partial<LabRequest>) => void }) {
  if (!open) return null;
  return (
    <aside role="dialog" aria-label="Simulator" className="iux-sidepanel fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-(--iux-border) bg-(--iux-background) shadow-2xl">
      <header className="flex items-center gap-2 border-b border-(--iux-border) px-5 py-3">
        <span className="shrink-0 text-[#f36c21]">
          <DeviceMobileIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Simulator</h2>
          <p className="text-xs text-(--iux-muted-foreground)">Pick a device, attach it and watch its screen here.</p>
        </div>
        <IconButton label="Close" onClick={onClose} className="ml-auto">
          <XIcon size={14} weight="bold" />
        </IconButton>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        <SimulatorBody onPreview={onPreview} />
      </div>
    </aside>
  );
}

function SimulatorBody({ onPreview }: { onPreview: (action: string, extra?: Partial<LabRequest>) => void }) {
  const { data, error } = usePoll(() => api.iosSimulator(), SCREEN_INTERVAL);
  const { data: hostReport } = usePoll(() => api.host(), 0);
  const { data: realDevices, error: devicesError } = usePoll<IosDevicesInfo>(() => api.iosDevices(), DEVICES_INTERVAL);
  const { data: volumeReport } = usePoll<CleanupVolumes>(() => api.cleanupVolumes(), 0);
  const { data: resources } = usePoll<IosResources>(() => api.iosResources(), SCREEN_INTERVAL);
  const home = volumeReport?.volumes?.find((v) => v.isHome) ?? null;
  const diskTight = !!home && (home.pressure === "warning" || (home.freeBytes != null && home.freeBytes < DISK_TIGHT_BYTES));
  const xcodePath = hostReport?.host.xcode?.xcodeApp || hostReport?.host.xcode?.developerDir || null;
  const [udid, setUdid] = useState("");

  // Resource watchdog: two critical polls in a row open the alert (or fire the
  // armed auto-stop); a 5-minute cooldown keeps a stuck machine from nagging.
  const [resourceAlert, setResourceAlert] = useState(false);
  const [autoStop, setAutoStop] = useState(() => (typeof window === "undefined" ? false : window.localStorage.getItem(AUTO_STOP_KEY) === "1"));
  const [stopping, setStopping] = useState(false);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const [stopError, setStopError] = useState("");
  const criticalStreak = useRef(0);
  const lastAlertAt = useRef(0);
  useEffect(() => {
    const mem = resources?.memory?.percent;
    const cpu = resources?.cpu?.percent;
    const critical = (mem != null && mem >= (resources?.memory?.critical ?? 92))
      || (cpu != null && cpu >= (resources?.cpu?.critical ?? 95));
    if (!critical) {
      criticalStreak.current = 0;
      return;
    }
    criticalStreak.current += 1;
    if (criticalStreak.current < 2) return;
    criticalStreak.current = 0;
    if (autoStop) {
      // Armed: the stop fires by itself; the dialog never shows while armed.
      if (!stopping) void stopSimulators("all", true);
      return;
    }
    if (!resourceAlert && Date.now() - lastAlertAt.current > RESOURCE_DIALOG_COOLDOWN_MS) {
      lastAlertAt.current = Date.now();
      setResourceAlert(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources, autoStop]);

  /** Stop all simulators, or just the selected device — still through the console's previewed plan → token flow. */
  async function stopSimulators(kind: "all" | "selected", automatic = false) {
    setStopping(true);
    setStopError("");
    try {
      const request: LabRequest = { lab: "ios", action: "stop", ...(kind === "selected" && selected ? { device: selected } : {}) };
      const { token } = await api.plan(request);
      await api.start(request, token);
      setStopNote(automatic ? "Simulators were stopped automatically to free memory and CPU." : "Simulators stopped.");
    } catch (e) {
      setStopError(message(e));
      setStopNote(null);
    } finally {
      setStopping(false);
      setResourceAlert(false);
    }
  }

  function armAutoStop(armed: boolean) {
    setAutoStop(armed);
    try {
      window.localStorage.setItem(AUTO_STOP_KEY, armed ? "1" : "0");
    } catch { /* private mode: the arm lives for this session only */ }
  }

  // Reachability probes per device; devicectl connects the tunnel to answer.
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { reachable: boolean; reason?: string | null; name?: string; state?: string; developerMode?: boolean }>>({});
  async function checkDevice(udid: string) {
    setChecking(udid);
    try {
      const result = await api.iosDeviceCheck(udid);
      setChecks((old) => ({ ...old, [udid]: result }));
    } catch (e) {
      setChecks((old) => ({ ...old, [udid]: { reachable: false, reason: message(e) } }));
    } finally {
      setChecking(null);
    }
  }
  const [framed, setFramed] = useState(true);
  // An older console (or the e2e mock) may answer {}; every field is optional in practice.
  const devices = data?.devices ?? [];
  const booted = data?.booted?.[0] ?? null;

  // The picker starts on the booted device, else the configured one, else the first iPhone.
  const defaultUdid = useMemo(
    () =>
      booted?.udid ??
      (data?.configuredDevice ? devices.find((d) => d.name === data.configuredDevice)?.udid : undefined) ??
      devices.find((d) => d.name.startsWith("iPhone"))?.udid ??
      devices[0]?.udid ??
      "",
    [booted?.udid, data?.configuredDevice, devices]
  );
  useEffect(() => {
    if (defaultUdid && !devices.some((d) => d.udid === udid)) setUdid(defaultUdid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultUdid]);

  const selected = devices.some((d) => d.udid === udid) ? udid : defaultUdid;
  const attach = () => onPreview("start", selected ? { device: selected } : {});
  const detach = () => onPreview("stop");

  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const shotRef = useRef<string | null>(null);
  const grab = useCallback(async () => {
    setShotBusy(true);
    try {
      const res = await fetch(api.iosScreenshotUrl, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      const url = URL.createObjectURL(await res.blob());
      if (shotRef.current) URL.revokeObjectURL(shotRef.current);
      shotRef.current = url;
      setShot(url);
      setShotError(null);
    } catch (e) {
      setShotError(message(e));
    } finally {
      setShotBusy(false);
    }
  }, []);
  useEffect(() => () => {
    if (shotRef.current) URL.revokeObjectURL(shotRef.current);
  }, []);
  useEffect(() => {
    if (!booted) {
      setShot(null);
      setShotError(null);
      return;
    }
    void grab();
    const timer = setInterval(() => {
      if (!document.hidden) void grab();
    }, SCREEN_INTERVAL);
    return () => clearInterval(timer);
  }, [booted?.udid, grab]);

  return (
    <>
      {error ? (
        <Status value={{ ok: false, text: error }} />
      ) : !data ? (
        <Skeleton rows={2} />
      ) : !data.available ? (
        <Empty>{data.reason ?? "The simulator tooling is not usable on this Mac."}</Empty>
      ) : (
        <>
          {diskTight && home && (
            <div className="mb-5 w-full max-w-sm rounded-md border border-(--iux-warning) p-3 text-sm">
              <p>System disk is running low. Simulator device data can move to another volume from the Cleanup Lab.</p>
              <p className="mt-1 text-xs text-(--iux-muted-foreground)" dir="ltr">{home.mountPoint} · {home.freeBytes == null ? "?" : Math.round(home.freeBytes / 1024 ** 3)} GiB free</p>
              <a className="iux-btn mt-2" data-variant="outline" href={localePath("/cleanup/relocation/", locale())}>Open Relocation</a>
            </div>
          )}
          {xcodePath && (
            <p className="mb-4 w-full max-w-sm break-all text-xs text-(--iux-muted-foreground)">
              <span className="font-medium">Xcode</span> · <span translate="no">{xcodePath}</span>
            </p>
          )}
          {resources?.available && resources.memory && resources.cpu && (
            <section className="mb-4 w-full max-w-sm rounded-md border border-(--iux-border) p-3">
              <h3 className="text-sm font-semibold">Resources</h3>
              <div className="mt-2 flex flex-col gap-2">
                <Meter label="System memory" percent={resources.memory.percent} warn={resources.memory.warn} critical={resources.memory.critical}
                  detail={`${gib(resources.memory.usedBytes)} / ${gib(resources.memory.totalBytes)}`} />
                <Meter label="System CPU" percent={resources.cpu.percent} warn={resources.cpu.warn} critical={resources.cpu.critical}
                  detail={resources.cpu.percent == null ? "…" : `${resources.cpu.percent}%`} />
                {resources.simulator && (
                  <Meter label="Simulator app" percent={null} warn={100} critical={100}
                    detail={resources.simulator.running ? `${fmtBytes(resources.simulator.rssBytes)} · ${resources.simulator.cpuPercent ?? 0}% CPU` : "not running"} />
                )}
              </div>
              <label className="mt-3 flex items-start gap-2 text-xs text-(--iux-muted-foreground)">
                <input type="checkbox" className="mt-0.5" checked={autoStop} onChange={(e) => armAutoStop(e.target.checked)} />
                Stop simulators automatically when the system runs out of resources
              </label>
              {stopNote && <p role="status" className="mt-2 text-xs">{stopNote}</p>}
              {stopError && <Status value={{ ok: false, text: stopError }} />}
            </section>
          )}
          <div className="flex flex-col items-center gap-5">
          <div className="flex w-full max-w-sm flex-wrap items-center justify-between gap-3">
            <div className="min-w-56 flex-1">
              <Field label="Device" hint={data.runtimes[0]}>
                <select className="iux-input" value={selected} onChange={(e) => setUdid(e.target.value)} aria-label="Device">
                  {devices.map((d) => (
                    <option key={d.udid} value={d.udid}>
                      {d.name} · {d.runtime}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {booted ? (
              <Badge tone="success">
                Booted{` · ${booted.name}`}
              </Badge>
            ) : null}
          </div>

          <div className={`relative ${framed ? "rounded-[3rem] border border-zinc-700 bg-zinc-950 p-2 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.55)]" : ""}`}>
            {framed ? (
              <>
                <span aria-hidden="true" className="absolute top-24 -left-[3px] h-9 w-[3px] rounded-l-sm bg-zinc-600" />
                <span aria-hidden="true" className="absolute top-36 -left-[3px] h-12 w-[3px] rounded-l-sm bg-zinc-600" />
                <span aria-hidden="true" className="absolute top-28 -right-[3px] h-16 w-[3px] rounded-r-sm bg-zinc-600" />
              </>
            ) : null}
            <div
              className={`relative w-72 max-w-full overflow-hidden bg-black ${framed ? "rounded-[2.6rem]" : "rounded-xl border border-(--iux-border)"}`}
              style={{ aspectRatio: "393 / 852" }}
            >
              {booted ? (
                shot ? (
                  <img src={shot} alt="Simulator screen" className="h-full w-full object-cover" />
                ) : shotError ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                    <p className="text-xs text-zinc-400">{shotError}</p>
                    <button type="button" className="iux-btn" data-variant="outline" onClick={() => void grab()}>
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center" aria-busy="true">
                    <CircleNotchIcon size={24} className="animate-spin text-zinc-500" aria-hidden />
                  </div>
                )
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <DeviceMobileIcon size={30} className="text-zinc-500" aria-hidden />
                  <p className="text-base font-semibold text-zinc-100">Attach a simulator to see its screen here</p>
                  <p className="text-xs text-zinc-400">Shut-down devices boot when you attach.</p>
                  <button
                    type="button"
                    className="mt-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-60"
                    disabled={!devices.length}
                    onClick={attach}
                  >
                    Attach simulator
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button type="button" className="iux-btn" data-variant="outline" aria-pressed={framed} onClick={() => setFramed((f) => !f)}>
              <FrameCornersIcon size={14} /> Frame
            </button>
            <button type="button" className="iux-btn" data-variant="outline" disabled={!booted || shotBusy} onClick={() => void grab()}>
              <ArrowClockwiseIcon size={14} /> Refresh
            </button>
            {shot ? (
              <a className="iux-btn" data-variant="outline" href={shot} download="ios-lab-screenshot.png">
                <CameraIcon size={14} /> Screenshot
              </a>
            ) : null}
            {booted ? (
              <button type="button" className="iux-btn" data-variant="outline" onClick={detach}>
                <PowerIcon size={14} /> Detach simulator
              </button>
            ) : null}
          </div>
        </div>
        </>
      )}
      <section className="mt-6 w-full max-w-sm border-t border-(--iux-border) pt-4">
        <h3 className="text-sm font-semibold">Real devices</h3>
        <p className="text-xs text-(--iux-muted-foreground)">Paired and connected iPhones and iPads, read-only.</p>
        {devicesError ? (
          <Status value={{ ok: false, text: devicesError }} />
        ) : !realDevices ? (
          <Skeleton rows={1} />
        ) : !realDevices.available ? (
          <p className="mt-2 text-sm text-(--iux-muted-foreground)">{realDevices.reason}</p>
        ) : realDevices.devices.length === 0 ? (
          <Empty>No real devices are paired with this Mac.</Empty>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {realDevices.devices.map((d) => {
              const check = checks[d.udid];
              const state = check?.reachable
                ? (check.state === "connected" ? "connected" : "reachable")
                : check ? "unreachable" : d.state;
              return (
                <li key={d.udid} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-sm">
                  <span className="min-w-0 max-w-full truncate font-medium">{check?.name || d.name}</span>
                  {state ? (
                    <Badge tone={state === "connected" ? "success" : undefined}>{state}</Badge>
                  ) : null}
                  <span className="ms-auto flex items-center gap-1.5 text-xs text-(--iux-muted-foreground)">
                    <span dir="ltr">{d.osVersion}</span>
                    <button type="button" className="iux-btn" data-variant="ghost" disabled={checking === d.udid}
                      onClick={() => void checkDevice(d.udid)}>
                      {checking === d.udid ? "Checking…" : "Check"}
                    </button>
                  </span>
                  <p className="w-full truncate text-xs text-(--iux-muted-foreground)" dir="ltr" title={d.udid}>
                    <span translate="no">{d.udid}</span>
                    {d.paired && (d.transport === "localNetwork" ? " · Wi-Fi" : d.transport ? " · USB" : "")}
                    {d.lastSeen ? ` · ${new Date(d.lastSeen).toLocaleString(locale())}` : ""}
                  </p>
                  {check && !check.reachable && check.reason && <p className="w-full text-xs text-(--iux-danger)">{check.reason}</p>}
                  {check?.reachable && check.developerMode === false && <p className="w-full text-xs text-(--iux-warning)">Developer Mode is off on this device.</p>}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-(--iux-muted-foreground)">
          Controlling a real device needs Developer Mode and a signed WebDriverAgent — see the iOS lab README.
        </p>
      </section>
      {resourceAlert && !autoStop && resources?.available && (
        <ResourceDialog resources={resources} selectedName={devices.find((d) => d.udid === selected)?.name ?? null}
          stopping={stopping} stopError={stopError}
          onStopAll={() => void stopSimulators("all")}
          onStopSelected={() => void stopSimulators("selected")}
          onDismiss={() => setResourceAlert(false)} />
      )}
    </>
  );
}
