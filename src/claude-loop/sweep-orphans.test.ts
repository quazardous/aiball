/**
 * #1601 — le balayage des kernels orphelins hors Linux.
 *
 * Le bug qu'ils épinglent : `sweepOrphans` sortait immédiatement dès que la
 * plateforme n'était pas Linux, donc rien ne ramassait un kernel orphelin sur
 * Windows. Un `reload` ne tue que le pid inscrit dans `loop.pid` ; ceux laissés
 * par les reloads précédents s'accumulaient. Observé en vrai : trois kernels
 * pour un seul loop, tous vivants, tous en train de peindre la barre.
 *
 * On tue de VRAIS processus ici plutôt que de simuler `process.kill` : la
 * panne était que rien ne mourait, donc un test qui ne vérifie pas la mort ne
 * vérifie rien.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphans } from "./cmds/manage.js";
import { registerKernelPid, readKernelPids, kernelPidsPath } from "./state.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Un processus jetable qui vit jusqu'à ce qu'on le tue. Enregistré dans
 * `victims` pour être ramassé par `withSd` QUOI QU'IL ARRIVE : une assertion
 * qui échoue laissait sinon un `setInterval` orphelin qui garde le runner en
 * vie — le test pendait au lieu d'échouer, ce qui est le pire des deux.
 */
let victims: { pid: number; kill: () => void }[] = [];

function spawnVictim(): { pid: number; kill: () => void } {
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const v = { pid: c.pid as number, kill: () => { try { c.kill("SIGKILL"); } catch { /* déjà mort */ } } };
    victims.push(v);
    return v;
}

function withSd<T>(fn: (sd: string) => Promise<T>): Promise<T> {
    const sd = mkdtempSync(join(tmpdir(), "sweep-"));
    victims = [];
    return fn(sd).finally(() => {
        for (const v of victims) v.kill();
        victims = [];
        try { rmSync(sd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

// Le chemin Linux lit /proc et ignore le registre : ces cas ne le concernent pas.
const tt = process.platform === "linux" ? test.skip : test;

tt("un kernel enregistré et encore vivant est tué", async () => {
    await withSd(async (sd) => {
        const victim = spawnVictim();
        registerKernelPid(sd, victim.pid);
        await sleep(150);
        assert.equal(isAlive(victim.pid), true, "témoin : la victime tourne avant le balayage");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [victim.pid]);
        assert.equal(isAlive(victim.pid), false, "l'orphelin doit être MORT, pas seulement listé");
    });
});

tt("le balayeur ne se tue pas lui-même", async () => {
    await withSd(async (sd) => {
        registerKernelPid(sd, process.pid);
        const { killed } = sweepOrphans(sd);
        assert.deepEqual(killed, [], "process.pid est le survivant, jamais une cible");
        assert.deepEqual(readKernelPids(sd), [process.pid], "et il reste inscrit");
    });
});

tt("un pid déjà mort est retiré du registre sans être compté", async () => {
    await withSd(async (sd) => {
        const gone = spawnVictim();
        gone.kill();
        await sleep(200);
        registerKernelPid(sd, gone.pid);

        const { killed } = sweepOrphans(sd);
        assert.deepEqual(killed, [], "rien à tuer");
        assert.deepEqual(readKernelPids(sd), [], "le registre est purgé des morts");
    });
});

tt("plusieurs orphelins sont tous ramassés", async () => {
    // Le cas réel : trois kernels pour un loop, deux à ramasser.
    await withSd(async (sd) => {
        const a = spawnVictim(), b = spawnVictim();
        registerKernelPid(sd, a.pid);
        registerKernelPid(sd, b.pid);
        registerKernelPid(sd, process.pid);
        await sleep(150);

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.equal(killed.length, 2, `attendu 2 tués, obtenu ${JSON.stringify(killed)}`);
        assert.equal(isAlive(a.pid), false);
        assert.equal(isAlive(b.pid), false);
        assert.deepEqual(readKernelPids(sd), [process.pid], "seul le survivant reste inscrit");
    });
});

tt("un registre absent ne fait pas échouer le balayage", async () => {
    await withSd(async (sd) => {
        assert.equal(existsSync(kernelPidsPath(sd)), false);
        assert.deepEqual(sweepOrphans(sd).killed, []);
    });
});
