/**
 * #1613 — la branche Linux de `sweepOrphans` (`cmds/manage.ts`), celle qui lit
 * `/proc/<pid>/environ` pour savoir à quel state dir un processus appartient.
 *
 * Elle n'était exécutée par AUCUN test : le seul fichier qui touchait
 * `sweepOrphans` skippe en entier sur Linux (son garde vise la branche registre,
 * qui n'a rien à vérifier là-bas), et sur Windows `/proc` n'existe pas. Du code
 * qui envoie des SIGKILL, sur la plateforme principale, sans un test qui s'y
 * exécute.
 *
 * On teste `/proc` en le lisant vraiment plutôt qu'en injectant une fausse
 * racine : ce qui se casse ici n'est pas l'arborescence, c'est le FILTRAGE — la
 * comparaison exacte-clé et le garde `kernelOnly` — et une arborescence
 * fabriquée à la main encode nos propres hypothèses sur la forme d'`environ` au
 * lieu de les éprouver. On spawn donc de vrais processus, on relève leur
 * `environ` réel comme témoin, puis on vérifie qui meurt et qui survit.
 *
 * Le témoin n'est pas décoratif : un survivant qui survit parce que son env
 * n'a jamais été posé ressemble trait pour trait à un filtre qui marche.
 *
 * Lancer : `npx tsx --test src/claude-loop/sweep-orphans-proc.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphans } from "./cmds/manage.js";

// `/proc` n'existe pas ailleurs — la branche testée ici y est inatteignable.
const tt = process.platform === "linux" ? test : test.skip;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

type Victim = { pid: number; environ: string; cmdline: string; kill: () => void };

let victims: ChildProcess[] = [];

/**
 * Un processus jetable portant `stateDir` dans son env, et `kernelLike` près
 * dans sa ligne de commande.
 *
 * L'env est construit à la main plutôt qu'hérité : cette session tourne
 * elle-même sous un `claude-loop`, donc `process.env` porte le `CL_STATE_DIR`
 * du loop VIVANT. Le propager à des processus jetables les rendrait ramassables
 * par un vrai balayage.
 *
 * `kernelLike` passe le chemin en argument positionnel — `kernel.ts` n'a besoin
 * d'être que dans la ligne de commande, qui est tout ce que le filtre regarde,
 * et un argument suffit là où exécuter un vrai fichier `.ts` dépendrait du
 * détourage de types de la version de node.
 *
 * `first` décide si le marqueur est la PREMIÈRE entrée d'`environ`, donc s'il
 * est précédé d'un NUL ou non. Les deux positions empruntent des clauses
 * différentes du filtre (`includes` vs `startsWith`) : sans les deux, une moitié
 * n'est jamais exécutée.
 */
async function spawnVictim(
    opts: { env: Record<string, string>; kernelLike?: boolean; first?: boolean; sd: string },
): Promise<Victim> {
    const argv = ["-e", "setInterval(() => {}, 1000)"];
    if (opts.kernelLike) argv.push(join(opts.sd, "kernel.ts"));
    const PATH = process.env.PATH ?? "";
    const c = spawn(process.execPath, argv, {
        stdio: "ignore",
        env: opts.first ? { ...opts.env, PATH } : { PATH, ...opts.env },
    });
    victims.push(c);
    const pid = c.pid as number;

    // `/proc/<pid>/environ` n'est lisible qu'une fois l'exec fait ; on attend le
    // témoin plutôt qu'un délai au jugé.
    let environ = "", cmdline = "";
    for (let i = 0; i < 50 && environ === ""; i++) {
        try {
            environ = readFileSync(`/proc/${pid}/environ`, "utf8");
            cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        } catch { await sleep(20); }
    }
    assert.notEqual(environ, "", `témoin illisible : /proc/${pid}/environ`);
    return { pid, environ, cmdline, kill: () => { try { c.kill("SIGKILL"); } catch { /* déjà mort */ } } };
}

function withSd<T>(fn: (sd: string) => Promise<T>): Promise<T> {
    const sd = mkdtempSync(join(tmpdir(), "sweep-proc-"));
    victims = [];
    return fn(sd).finally(() => {
        for (const c of victims) { try { c.kill("SIGKILL"); } catch { /* déjà mort */ } }
        victims = [];
        try { rmSync(sd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

tt("un satellite du state dir est tué pour de vrai", async () => {
    await withSd(async (sd) => {
        const v = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd });
        assert.ok(v.environ.includes(`CL_STATE_DIR=${sd}`), "témoin : la victime porte bien le marqueur");
        assert.equal(isAlive(v.pid), true, "témoin : elle tourne avant le balayage");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [v.pid]);
        assert.equal(isAlive(v.pid), false, "l'orphelin doit être MORT, pas seulement listé");
    });
});

tt("une clé dont la nôtre est le SUFFIXE ne matche pas", async () => {
    // Le piège que le NUL de tête attrape, et le seul de ce côté :
    // `OLD_CL_STATE_DIR=<sd>` contient `CL_STATE_DIR=<sd>` mot pour mot, donc un
    // `includes` non ancré le prend pour nous.
    //
    // À ne pas confondre avec `CL_STATE_DIR_BACKUP=<sd>`, l'exemple que donnait
    // le commentaire du code : celui-là ne peut PAS faux-matcher, le `_BACKUP`
    // s'intercalant avant le `=`. Un cas écrit là-dessus passe avec ou sans
    // l'ancrage — mesuré : il survit à la mutation qui retire le NUL.
    await withSd(async (sd) => {
        const v = await spawnVictim({ env: { OLD_CL_STATE_DIR: sd }, sd });
        assert.ok(v.environ.includes(`CL_STATE_DIR=${sd}`), "témoin : le leurre contient bien notre marqueur en sous-chaîne");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [], "aucune victime : la clé n'est pas la nôtre");
        assert.equal(isAlive(v.pid), true, "un porteur de clé homonyme doit SURVIVRE");
    });
});

tt("le marqueur en PREMIÈRE entrée d'environ est tout de même reconnu", async () => {
    // La première variable d'`environ` n'est précédée d'aucun NUL, donc le
    // `includes(`\0…`)` la manque : c'est ce que rattrape la clause
    // `startsWith`. Sans ce cas, la moitié du filtre n'est jamais exécutée et un
    // orphelin réel survivrait selon l'ordre de son env.
    await withSd(async (sd) => {
        const v = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd, first: true });
        assert.ok(v.environ.startsWith(`CL_STATE_DIR=${sd}\0`), "témoin : le marqueur est bien en tête d'environ");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [v.pid]);
        assert.equal(isAlive(v.pid), false);
    });
});

tt("un state dir voisin dont le nôtre est un préfixe survit", async () => {
    // `/tmp/sweep-proc-ab` et `/tmp/sweep-proc-abcd` : deux loops distincts. Sans
    // le `\0` de fin, balayer le premier emporterait le second.
    await withSd(async (sd) => {
        const neighbour = `${sd}-voisin`;
        const v = await spawnVictim({ env: { CL_STATE_DIR: neighbour }, sd });
        assert.ok(v.environ.includes(`CL_STATE_DIR=${neighbour}`), "témoin : le voisin porte bien son propre state dir");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [], "le balayage d'un loop ne déborde pas sur son voisin");
        assert.equal(isAlive(v.pid), true);
    });
});

tt("kernelOnly épargne le proxy et n'emporte que les kernels", async () => {
    // #1059 : au RELOAD le proxy est vivant et porte le même `CL_STATE_DIR`. Un
    // balayage non filtré le tue → le PTY de claude meurt avec lui.
    await withSd(async (sd) => {
        const proxy = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd });
        const kernel = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd, kernelLike: true });
        assert.ok(!/kernel\.ts/.test(proxy.cmdline), "témoin : le proxy n'a pas kernel.ts en ligne de commande");
        assert.ok(/kernel\.ts/.test(kernel.cmdline), "témoin : le kernel, si");

        const { killed } = sweepOrphans(sd, { kernelOnly: true });
        await sleep(300);

        assert.deepEqual(killed, [kernel.pid], "seul le kernel tombe");
        assert.equal(isAlive(kernel.pid), false);
        assert.equal(isAlive(proxy.pid), true, "le proxy doit SURVIVRE au reload");
    });
});

tt("sans kernelOnly le balayage emporte tout le state dir", async () => {
    // Le cas `cmdStart` : démarrage à froid, rien de vivant à protéger.
    await withSd(async (sd) => {
        const a = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd });
        const b = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd, kernelLike: true });

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.equal(killed.length, 2, `attendu 2 tués, obtenu ${JSON.stringify(killed)}`);
        assert.equal(isAlive(a.pid), false);
        assert.equal(isAlive(b.pid), false);
    });
});
