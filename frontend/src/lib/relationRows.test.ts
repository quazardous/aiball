/**
 * #2388 david — a relation event kind with no label blanks the whole thread:
 * the template reads `.icon` off `undefined`, Vue drops the list, and every
 * comment vanishes while the API still serves them. What must hold:
 * - every kind rendered as a relation row has a label;
 * - the three event kinds the daemon posts are among them;
 * - an unknown kind still yields a usable label rather than undefined.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RELATION_ROW_KINDS, RELATION_ROW_LABELS, isRelationRowKind, relationRowLabel } from "./relationRows";

test("every kind rendered as a relation row carries a label", () => {
    for (const kind of RELATION_ROW_KINDS) {
        assert.ok(isRelationRowKind(kind), `${kind} routes to a relation row`);
        const label = RELATION_ROW_LABELS[kind];
        assert.ok(label && label.icon && label.verbOne && label.verbMany, `${kind} has a complete label`);
    }
});

test("the relation events the daemon posts are all covered", () => {
    for (const kind of ["ticket_sub_added", "ticket_referenced", "ticket_relation", "dependency_closed", "related_closed", "dependency_rejected"]) {
        assert.ok(isRelationRowKind(kind), `${kind} is rendered as a relation row`);
    }
});

test("an unknown kind reads as a bare link instead of blanking the thread", () => {
    const label = relationRowLabel("some_kind_shipped_later");
    assert.ok(label.icon && label.verbOne && label.verbMany);
    assert.equal(isRelationRowKind("some_kind_shipped_later"), false);
});
