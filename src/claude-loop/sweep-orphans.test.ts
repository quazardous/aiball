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
import { registerKernelPid, readKernelPids, kernelPidsPath, claimLoopAsKernel } from "./state.js";

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

// Garde réservé aux cas `sweepOrphans` : sur Linux il lit `/proc` et ignore le
// registre, donc ces cas-là n'y ont rien à vérifier. À NE PAS étendre au reste
// du fichier par proximité — voir la section `claimLoopAsKernel` plus bas, qui
// tourne sur toutes les plateformes et doit être testée sur toutes.
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

// --- claimLoopAsKernel : le balayage AU BOOT ------------------------------
// Le sweep piloté par la CLI tourne avant qu'elle ne spawn, donc il ne peut
// pas voir un kernel qui apparaît après — et il en apparaît un couramment :
// modifier la source fait s'auto-recharger le kernel courant, et un
// `claude-loop reload` lancé au même moment en ajoute un second. Mesuré après
// exactement cette séquence : deux kernels vivants par loop, tous deux
// enregistrés, aucun balayé. Le faire au boot est auto-réparateur.
//
// CES CAS TOURNENT PARTOUT, `test` et non `tt`. Le garde Linux plus haut vaut
// pour `sweepOrphans`, qui lit `/proc` là-bas et ignore le registre. Il ne vaut
// pas pour `claimLoopAsKernel`, appelé sans condition au boot du kernel
// (`kernel.ts`) donc sur Linux aussi. Rangés d'abord sous le même garde par
// commodité de fichier, ils n'y étaient jamais exécutés : une fonction qui
// envoie des SIGKILL tournait sur la plateforme principale avec zéro test qui
// s'y exécute, et la lane Linux était verte parce qu'elle n'en testait rien.
// Rien ici ne dépend de la plateforme — on spawn de vrais processus et on
// vérifie qu'ils meurent, ce qui se tient aussi bien des deux côtés.

test("claimLoopAsKernel tue les kernels plus anciens et garde le nouveau", async () => {
    await withSd(async (sd) => {
        const older = spawnVictim();
        registerKernelPid(sd, older.pid);
        await sleep(150);

        const { killed } = claimLoopAsKernel(sd);
        await sleep(300);

        assert.deepEqual(killed, [older.pid], "l'ancien doit être tué");
        assert.equal(isAlive(older.pid), false);
        assert.deepEqual(readKernelPids(sd), [process.pid], "le nouveau reste seul inscrit");
    });
});

test("claimLoopAsKernel s'enregistre même quand il n'y a personne à tuer", async () => {
    await withSd(async (sd) => {
        const { killed } = claimLoopAsKernel(sd);
        assert.deepEqual(killed, []);
        assert.deepEqual(readKernelPids(sd), [process.pid], "un premier boot doit quand même s'inscrire");
    });
});
