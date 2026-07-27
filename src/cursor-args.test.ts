/**
 * Le lecteur de position du curseur — la commande et son parse.
 *
 * Le bug épinglé ici : le kernel avait sa propre copie du lecteur, dérivée
 * vers `display-message -F "#{cursor_x} #{cursor_y}"`. psmux ne connaît pas
 * `-F` pour cette commande et le traite comme un mot du message : il répond
 * `-F 2,36` avec un `exit 0`, que le parse rejette. Résultat mesuré sur
 * Windows : `captureCursor()` rendait `null` à CHAQUE poll, sans erreur, sans
 * trace — et la règle curseur (celle qui distingue une suggestion grisée
 * d'une vraie saisie) ne s'exécutait jamais.
 *
 * On teste donc l'argv, pas seulement le parse : c'est la forme de la
 * commande qui était fausse, et un parse correct sur une entrée qu'on ne
 * reçoit jamais ne prouve rien.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorArgs, parseCursor } from "./pane.js";

test("le format part en ARGUMENT POSITIONNEL, jamais derrière -F", () => {
    const args = cursorArgs("sess.0");
    assert.equal(args.includes("-F"), false, "psmux prendrait -F pour un mot du message");
    assert.equal(args.at(-1), "#{cursor_x},#{cursor_y}", "le format doit être le dernier argument");
});

test("l'argv vise bien le pane demandé", () => {
    const args = cursorArgs("cl-projet-42.0");
    assert.deepEqual(args.slice(0, 4), ["display-message", "-p", "-t", "cl-projet-42.0"]);
});

test("parse la réponse normale, quel que soit l'habillage de fin de ligne", () => {
    assert.deepEqual(parseCursor("2,36"), { x: 2, y: 36 });
    assert.deepEqual(parseCursor("2,36\n"), { x: 2, y: 36 });
    assert.deepEqual(parseCursor("  0,0  \r\n"), { x: 0, y: 0 });
});

test("rejette la réponse que produisait la forme -F", () => {
    // Sortie RÉELLE mesurée sur psmux avec l'ancienne commande.
    assert.equal(parseCursor("-F 2 36"), null);
});

test("rejette le bruit plutôt que d'inventer une position", () => {
    for (const junk of ["", "no current target", "2", "x,y", "2,36,7"]) {
        assert.equal(parseCursor(junk), null, `entrée ${JSON.stringify(junk)}`);
    }
});
