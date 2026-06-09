/**
 * #649 Slice 4 — in-process mutation helpers for the AFK state. Update
 * the AfkService observable AND the ipcState in one call.
 *
 * #840 `4z59jt` — david "vire tout marker fichier". Le fichier `afk` est
 * dégagé : plus de writeFileSync, plus de hydrate-from-file, plus de
 * fs.watch. Le proxy lit l'AFK via le WS push (cf. pty-proxy._afk_mode) ;
 * les hook subprocesses via le UDS round-trip (queryLoopState).
 */
import { type AfkService, getAfkService } from "./afk-service.js";
import { setIpcAfk } from "./ipc-state.js";

export function armAfkViaService(
    _sd: string,
    seconds = 600,
    svc?: AfkService,
): number {
    const s = svc ?? getAfkService();
    const expiry = Date.now() + seconds * 1000;
    s.set10m(expiry);
    setIpcAfk("wait_10m", expiry);
    return expiry;
}

export function setAfkInfViaService(_sd: string, svc?: AfkService): void {
    const s = svc ?? getAfkService();
    s.setInf();
    setIpcAfk("wait_inf", null);
}

export function clearAfkViaService(_sd: string, svc?: AfkService): void {
    const s = svc ?? getAfkService();
    s.setOff();
    setIpcAfk("off", null);
}
