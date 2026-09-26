/**
 * #3063 — every module that defines bus methods, imported once so the table is
 * complete before the first connection or request. A new method module is
 * listed here.
 */
import "./methods/bus.js";
import "./methods/catalog.js";
import "./methods/consumer.js";
import "./methods/message.js";
import "./methods/ticket.js";
import "./methods/inbox.js";
import "./methods/ticket-get.js";
import "./methods/subjects.js";
import "./methods/session.js";
